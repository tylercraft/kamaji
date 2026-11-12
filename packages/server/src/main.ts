// Kamaji's one process: the HTTP app, the check runner and the cycle schedule.
// Started by the LaunchAgent (ops/dev.craftish.kamaji.plist) under `doppler run`.
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { careRequest } from './care/client.js';
import { loadConfig } from './config.js';
import { readOutside, syncOutside, workerFresh } from './checks/outside.js';
import { checkServers } from './checks/serverReport.js';
import { checkSites } from './checks/sites.js';
import { checkDirectory } from './inventory/directory.js';
import { checkReports } from './inventory/report.js';
import { checkWordfence } from './wordfence/feed.js';
import { checkEndOfLife } from './endOfLife/check.js';
import { updaterLauncher } from './updates/launcher.js';
import { pendingWork } from './updates/batches.js';
import { checkMolcajete } from './molcajete/check.js';
import { CYCLE, cycleHandler } from './cycle.js';
import { migrate, openDb } from './db.js';
import { createDiscord } from './discord.js';
import { recordEvent } from './events.js';
import { createHeartbeat } from './heartbeat.js';
import { Runner } from './jobs/runner.js';
import { enqueue } from './jobs/store.js';
import { notifyNow, sendDigest, type NotifyOptions } from './notify.js';
import { backupConfig, craftishBackup } from './updater/backup.js';

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

function buildInfo(): { version: string; commit: string | null } {
  try {
    const raw = readFileSync(new URL('./build-info.json', import.meta.url), 'utf8');
    return JSON.parse(raw) as { version: string; commit: string | null };
  } catch {
    return { version: 'dev', commit: null };
  }
}

const config = loadConfig();
const { version, commit } = buildInfo();
const startedAt = Date.now();

const db = openDb(config.dbPath);
for (const m of migrate(db)) {
  log(`migrated: ${m.version} ${m.name}`);
  recordEvent(db, Date.now(), {
    kind: 'kamaji.migrated',
    summary: `Database migrated to ${m.version} (${m.name})`,
  });
}

if (!config.login) log('KAMAJI_LOGIN is not set: every request will be refused');
if (config.pingUrlInvalid) log('HEALTHCHECKS_PING_URL is set but is not an https URL: not pinging');
else if (!config.pingUrl) log('HEALTHCHECKS_PING_URL is not set: not pinging healthchecks.io');
if (config.discordUrlInvalid)
  log('DISCORD_WEBHOOK_URL is set but is not a Discord webhook: no alerts');
else if (!config.discordUrl) log('DISCORD_WEBHOOK_URL is not set: no alerts');
if (!config.worker) log('KAMAJI_WORKER_URL or KAMAJI_WORKER_TOKEN is not set: no outside checks');
if (!config.wordfenceApiKey && !config.wordfenceFeedFile)
  log('WORDFENCE_API_KEY is not set: vulnerabilities are unknown');
if (!config.care)
  log('KAMAJI_CARE_REPORT_KEY is not set: sites can be monitored but not connected');

const localMac = () =>
  db.prepare("SELECT 1 FROM servers WHERE kind = 'local-mac' AND removed_at IS NULL").get() !==
  undefined;
const startUpdater = updaterLauncher(process.env.KAMAJI_UPDATER, log);
const heartbeat = createHeartbeat(db, config.pingUrl, { log });
const discord = createDiscord(db, config.discordUrl, { log });
const runChecks = async (signal: AbortSignal) => {
  const checked = await checkSites(db, { now: Date.now, signal });
  if (config.worker) await syncOutside(db, config.worker, { now: Date.now, signal, log });
  await checkReports(db, { keys: config.care, send: careRequest, now: Date.now, signal });
  await checkDirectory(db, { now: Date.now, signal });
  await checkWordfence(db, {
    apiKey: config.wordfenceApiKey,
    feedPath: config.wordfenceFeedPath,
    localFile: config.wordfenceFeedFile,
    now: Date.now,
    signal,
    log,
  });
  checkEndOfLife(db, Date.now());
  // A batch with work left and no updater (the mini restarted mid-run): start it to reconcile.
  if (pendingWork(db)) startUpdater();
  const servers = await checkServers(db, {
    now: Date.now,
    signal,
    keyPath: config.sshKeyPath,
    knownHostsPath: config.sshKnownHostsPath,
  });
  if (localMac()) {
    try {
      await checkMolcajete(db, {
        now: Date.now,
        signal,
        crashFiles: { path: config.crashLogPath },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      // The readers don't throw; if one ever does, the rest of the cycle still runs.
      log(`molcajete readers failed: ${error instanceof Error ? error.name : 'error'}`);
    }
  }
  const notify: NotifyOptions = {
    kamajiUrl: config.kamajiUrl,
    workerAlerts: Boolean(config.worker) && workerFresh(readOutside(db), Date.now()),
    digestAt: config.digestAt,
    signal,
  };
  await notifyNow(db, Date.now(), discord, notify);
  await sendDigest(db, Date.now(), discord, notify);
  return checked + servers;
};
const runner = new Runner(db, { handlers: { [CYCLE]: cycleHandler(heartbeat, runChecks) }, log });

recordEvent(db, startedAt, {
  kind: 'kamaji.started',
  summary: `Kamaji started (${commit ? `${version}, ${commit}` : version})`,
});

const scheduleCycle = () => {
  enqueue(db, Date.now(), CYCLE, {}, { dedupeKey: CYCLE });
  runner.wake();
};
scheduleCycle();
const schedule = setInterval(scheduleCycle, config.cycleSeconds * 1000);
runner.start();

const app = createApp({
  db,
  login: config.login,
  webDist: config.webDist,
  workerOn: Boolean(config.worker),
  jobFiles: { crashFiles: { path: config.crashLogPath }, logsDir: config.logsDir },
  care: { keys: config.care, pluginDir: config.pluginDir, send: careRequest },
  startUpdater,
  // Settings read each time, so craftish added as a server later needs no restart.
  backup: (site) => craftishBackup(backupConfig(db, process.env))(site),
  log,
  statusInput: () => ({
    version,
    commit,
    startedAt,
    now: Date.now(),
    cycleSeconds: config.cycleSeconds,
    heartbeatConfigured: heartbeat.configured,
    alertsConfigured: discord.configured,
  }),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
  log(`listening on ${info.address}:${info.port}`),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  clearInterval(schedule);
  server.close();
  await runner.stop();
  recordEvent(db, Date.now(), { kind: 'kamaji.stopped', summary: 'Kamaji stopped' });
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
