// The backups process (ops/backups-plan.md, ops/README.md "Whole-site backups"): hourly from
// its LaunchAgent, dev.craftish.kamaji-backups, and when the Backups panel asks. It holds the pull
// key, the Kinsta key and the restic password, which the app never does: its Doppler config is `backup`, scoped
// to ~/.kamaji-backups. One at a time: a second start while one runs exits at once.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDb } from '../db.js';
import { backupConfig } from '../updater/backup.js';
import { releaseLock, takeLock } from '../updater/lock.js';
import { realExec } from './exec.js';
import { kinstaCommand, readTest } from './kinsta.js';
import { restoreCheck } from './restore.js';
import { realRestic } from './restic.js';
import { runBackups } from './run.js';

export const LOCK = 'sitebackups.process';

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const env = process.env;
const repoRoot = new URL('../../../../', import.meta.url).pathname;

// Names only, never values.
const missing = ['RESTIC_REPOSITORY', 'RESTIC_PASSWORD'].filter(
  (name) => !env[name] || /^\$\{.+\}$/.test(env[name] ?? ''),
);
if (missing.length) {
  log(`backups: ${missing.join(' and ')} not set; not running`);
  process.exit(1);
}
const db = openDb(env.KAMAJI_DB ?? `${repoRoot}data/kamaji.db`);
const craftish = backupConfig(db, env);
if (!craftish) {
  log('backups: craftish isn’t set up as a server; not running');
  process.exit(1);
}
const other = takeLock(db, process.pid, Date.now(), LOCK);
if (other !== undefined) {
  log(`backups: another run is going (pid ${other}); exiting`);
  process.exit(0);
}

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`backups: ${signal}: stopping`);
    controller.abort();
  });
}

const pullKey = env.KAMAJI_PULL_SSH_KEY ?? `${homedir()}/.ssh/kamaji-pull`;
const craftishPull = (site: string) => [
  '/usr/bin/ssh',
  '-i',
  pullKey,
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  `UserKnownHostsFile=${craftish.knownHostsPath}`,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=30',
  '-T',
  `kamaji-pull@${craftish.host}`,
  site,
];
// Kinsta's own key, made on the mini for Kinsta alone (ops/README.md, "Kinsta"), and Kamaji's own
// known_hosts for Kinsta's hosts.
const kinsta = {
  key: env.KAMAJI_KINSTA_SSH_KEY ?? `${homedir()}/.ssh/kamaji-kinsta`,
  knownHosts: env.KAMAJI_KINSTA_KNOWN_HOSTS ?? `${homedir()}/.ssh/kamaji-kinsta.known_hosts`,
};
const restic = realRestic(env.KAMAJI_RESTIC ?? '/opt/homebrew/bin/restic');

try {
  log('backups: started');
  await runBackups({
    db,
    restic,
    pullCommand: (site, host) =>
      host === 'kinsta' ? kinstaCommand(db, kinsta, site, 'pull') : craftishPull(site),
    kinstaTest: async (site) => {
      const command = kinstaCommand(db, kinsta, site, 'test');
      if (!command) return { ok: false, problem: 'its Kinsta SSH access isn’t set' };
      const [bin, ...args] = command;
      // du over a big wp-content takes a while.
      const ran = await realExec(controller.signal)(bin!, args, { timeoutMs: 5 * 60_000 });
      return readTest(site, ran);
    },
    restore: (site, snapshotId) =>
      restoreCheck(
        {
          restic,
          exec: realExec(controller.signal),
          // Outside ~/kamaji-backups, which Arq copies: a test copy is plain files.
          workDir: env.KAMAJI_RESTORE_DIR ?? join(homedir(), 'kamaji-restore'),
          docker: env.KAMAJI_DOCKER ?? '/usr/local/bin/docker',
          sleep: (ms) => delay(ms, undefined, { signal: controller.signal }),
          signal: controller.signal,
        },
        site,
        snapshotId,
      ),
    now: Date.now,
    log,
    signal: controller.signal,
  });
  log('backups: done; exiting');
} catch (error) {
  log(`backups: stopped: ${error instanceof Error ? error.name : 'error'}`);
  process.exitCode = controller.signal.aborted ? 0 : 1;
} finally {
  releaseLock(db, Date.now(), LOCK);
  db.close();
}
