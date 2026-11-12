// The updater process (ops/README.md, "The updater"): started by the app when a batch is
// approved (launchctl kickstart on the mini), it runs every approved batch, then exits. It holds
// the update key, which the app never does: its Doppler config is `updater`, scoped to
// ~/.kamaji-updater. One at a time: a second start while one runs exits at once.
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { careRequest } from '../care/client.js';
import { loadCareKeys } from '../care/keys.js';
import { realCheckers } from '../checks/sites.js';
import { openDb } from '../db.js';
import { craftishBackup } from './backup.js';
import { releaseLock, takeLock } from './lock.js';
import { runUpdater, type Send } from './run.js';

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const env = process.env;
const repoRoot = new URL('../../../../', import.meta.url).pathname;

// The report key and the Worker's URL and token are Doppler references to checker's
// (ops/README.md, "The updater"). One Doppler can't resolve is passed through as its literal
// `${config.NAME}` text: refuse it by name, never its value.
const unresolved = Object.keys(env).filter(
  (name) => name.startsWith('KAMAJI_') && /^\$\{.+\}$/.test(env[name] ?? ''),
);
if (unresolved.length) {
  log(`updater: Doppler didn't resolve ${unresolved.join(', ')}; not running`);
  process.exit(1);
}
const keys = loadCareKeys(env);
if (!keys?.update) {
  log('updater: KAMAJI_CARE_REPORT_KEY and KAMAJI_CARE_UPDATE_KEY are needed; not running');
  process.exit(1);
}
// Without the Worker, a site's outside alerts couldn't be paused during its run.
const worker =
  env.KAMAJI_WORKER_URL?.startsWith('https://') && env.KAMAJI_WORKER_TOKEN
    ? { url: env.KAMAJI_WORKER_URL, token: env.KAMAJI_WORKER_TOKEN }
    : undefined;
if (!worker) {
  log('updater: KAMAJI_WORKER_URL and KAMAJI_WORKER_TOKEN are needed; not running');
  process.exit(1);
}
const db = openDb(env.KAMAJI_DB ?? `${repoRoot}data/kamaji.db`);

const other = takeLock(db, process.pid, Date.now());
if (other !== undefined) {
  log(`updater: another run is going (pid ${other}); exiting`);
  process.exit(0);
}

const craftish = db
  .prepare("SELECT address FROM servers WHERE id = 'craftish' AND removed_at IS NULL")
  .get();
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`updater: ${signal}: stopping; the next start reconciles`);
    controller.abort();
  });
}

const send: Send = (home, key, endpoint, body, options = {}) =>
  careRequest(home, key, endpoint, body, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

try {
  log('updater: started');
  await runUpdater({
    db,
    keys: { report: keys.report, update: keys.update },
    send,
    homePage: realCheckers.homePage,
    worker,
    backup: craftishBackup(
      craftish
        ? {
            keyPath: env.KAMAJI_BACKUP_SSH_KEY ?? `${homedir()}/.ssh/kamaji-backup`,
            knownHostsPath: env.KAMAJI_SSH_KNOWN_HOSTS ?? `${homedir()}/.ssh/kamaji_known_hosts`,
            host: String(craftish.address).replace(/^.*@/, ''),
          }
        : undefined,
    ),
    now: Date.now,
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    signal: controller.signal,
    log,
  });
  log('updater: nothing left to run; exiting');
} catch (error) {
  log(`updater: stopped: ${error instanceof Error ? error.name : 'error'}`);
  process.exitCode = controller.signal.aborted ? 0 : 1;
} finally {
  releaseLock(db, Date.now());
  db.close();
}
