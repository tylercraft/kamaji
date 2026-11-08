// Kamaji's one process: the HTTP app, the check runner and the cycle schedule.
// Started by the LaunchAgent (ops/dev.craftish.kamaji.plist) under `doppler run`.
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { CYCLE, cycleHandler } from './cycle.js';
import { migrate, openDb } from './db.js';
import { recordEvent } from './events.js';
import { createHeartbeat } from './heartbeat.js';
import { Runner } from './jobs/runner.js';
import { enqueue } from './jobs/store.js';

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

const heartbeat = createHeartbeat(db, config.pingUrl, { log });
const runner = new Runner(db, { handlers: { [CYCLE]: cycleHandler(heartbeat) }, log });

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
  log,
  statusInput: () => ({
    version,
    commit,
    startedAt,
    now: Date.now(),
    cycleSeconds: config.cycleSeconds,
    heartbeatConfigured: heartbeat.configured,
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
