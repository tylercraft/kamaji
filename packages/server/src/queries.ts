// Reads for the API, shaped by the shared schemas.
import type {
  ActivityResponse,
  Issue,
  OverviewResponse,
  Server,
  Site,
  StatusResponse,
} from '@kamaji/shared';
import type { Db } from './db.js';
import { readHeartbeat } from './heartbeat.js';
import { latestStartedJob } from './jobs/store.js';
import { CYCLE } from './cycle.js';

type Row = Record<string, unknown>;

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown): string | null => (ms === null ? null : iso(ms));
const strOrNull = (v: unknown): string | null => (v === null ? null : String(v));

const toSite = (r: Row): Site => ({
  id: String(r.id),
  name: String(r.name),
  url: String(r.url),
  hostKind: String(r.host_kind) as Site['hostKind'],
  clientSlug: strOrNull(r.client_slug),
  mode: String(r.mode) as Site['mode'],
  setup: String(r.setup) as Site['setup'],
  pausedAt: isoOrNull(r.paused_at),
  createdAt: iso(r.created_at),
});

const toServer = (r: Row): Server => ({
  id: String(r.id),
  name: String(r.name),
  kind: String(r.kind) as Server['kind'],
  address: String(r.address),
  createdAt: iso(r.created_at),
});

const toIssue = (r: Row): Issue => ({
  id: String(r.id),
  resourceType: String(r.resource_type) as Issue['resourceType'],
  resourceId: String(r.resource_id),
  kind: String(r.kind),
  severity: String(r.severity) as Issue['severity'],
  summary: String(r.summary),
  firstSeenAt: iso(r.first_seen_at),
  lastSeenAt: iso(r.last_seen_at),
});

export function listSites(db: Db): Site[] {
  return db
    .prepare('SELECT * FROM sites WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE')
    .all()
    .map(toSite);
}

export function listServers(db: Db): Server[] {
  return db
    .prepare('SELECT * FROM servers WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE')
    .all()
    .map(toServer);
}

export function overview(db: Db): OverviewResponse {
  const sites = listSites(db);
  const live = sites.filter((s) => s.setup === 'done' && !s.pausedAt);
  const watched = live.length + listServers(db).length;
  const connected = live.filter((s) => s.mode === 'connected').length;
  const issues = db
    .prepare(
      `SELECT * FROM issues WHERE resolved_at IS NULL
       ORDER BY severity = 'urgent' DESC, first_seen_at`,
    )
    .all()
    .map(toIssue);

  return {
    sites: {
      total: sites.length,
      connected: sites.filter((s) => s.mode === 'connected').length,
      monitoring: sites.filter((s) => s.mode === 'monitoring').length,
      paused: sites.filter((s) => s.pausedAt).length,
      unfinished: sites.filter((s) => s.setup !== 'done').length,
    },
    servers: { total: listServers(db).length },
    attention:
      watched > 0 || issues.length > 0
        ? { known: true, value: issues }
        : { known: false, reason: 'Nothing is being watched yet' },
    // Inventory arrives with Craftish Care (M3). Until a connected site reports, it's unknown.
    updatesWaiting: {
      known: false,
      reason: connected > 0 ? 'No inventory reported yet' : 'No connected sites',
    },
  };
}

export function activity(db: Db, before: number | null, limit: number): ActivityResponse {
  const rows = db
    .prepare(
      `SELECT id, at, kind, summary, resource_type, resource_id FROM events
       WHERE id < ? ORDER BY id DESC LIMIT ?`,
    )
    .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map((r) => ({
      id: Number(r.id),
      at: iso(r.at),
      kind: String(r.kind),
      summary: String(r.summary),
      resourceType: strOrNull(r.resource_type),
      resourceId: strOrNull(r.resource_id),
    })),
    nextBefore: rows.length > limit && last ? Number(last.id) : null,
  };
}

export interface StatusInput {
  version: string;
  commit: string | null;
  startedAt: number;
  now: number;
  cycleSeconds: number;
  heartbeatConfigured: boolean;
}

export function status(db: Db, input: StatusInput): StatusResponse {
  const cycle = latestStartedJob(db, CYCLE);
  const beat = readHeartbeat(db);
  return {
    version: input.version,
    commit: input.commit,
    startedAt: iso(input.startedAt),
    now: iso(input.now),
    cycle: {
      intervalSeconds: input.cycleSeconds,
      last:
        cycle && cycle.state !== 'queued'
          ? {
              startedAt: iso(cycle.startedAt),
              finishedAt: isoOrNull(cycle.finishedAt),
              state: cycle.state,
            }
          : null,
    },
    heartbeat: input.heartbeatConfigured
      ? {
          configured: true,
          lastAttemptAt: beat ? iso(beat.lastAttemptAt) : null,
          lastOk: beat ? beat.lastOk : null,
          lastSuccessAt: beat ? isoOrNull(beat.lastSuccessAt) : null,
        }
      : { configured: false },
  };
}
