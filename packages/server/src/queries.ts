// Reads for the API, shaped by the shared schemas.
import type {
  ActivityResponse,
  Availability,
  Certificate,
  Issue,
  Known,
  OutsideCheck,
  OverviewResponse,
  Server,
  ServerHealth,
  ServerSummary,
  Site,
  SiteSummary,
  StatusResponse,
} from '@kamaji/shared';
import type { CertificateResult, HomePageResult } from './checks/http.js';
import type { OutsideResult } from './checks/outside.js';
import { UBUNTU_EOL, type ReportReading } from './checks/serverReport.js';
import { findOpenIssue } from './issues.js';
import { latestObservations } from './observations.js';
import type { Db } from './db.js';
import { readDiscord } from './discord.js';
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
  tailnetOnly: Number(r.tailnet_only) === 1,
  expectedText: strOrNull(r.expected_text),
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

function availability(db: Db, site: Site): Known<Availability> {
  if (site.pausedAt) return { known: false, reason: 'Paused: not being checked' };
  if (site.setup !== 'done') return { known: false, reason: 'Not checked until setup is finished' };
  const [last] = latestObservations<HomePageResult>(db, 'site', site.id, 'http', 'mini', 1);
  if (!last) return { known: false, reason: 'First check pending' };
  const down = findOpenIssue(db, { resourceType: 'site', resourceId: site.id, kind: 'down' });
  return {
    known: true,
    value: {
      state: last.ok ? 'up' : down ? 'down' : 'failing',
      checkedAt: iso(last.at),
      responseMs: last.value.responseMs,
      problem: last.value.problem,
    },
  };
}

function outside(db: Db, site: Site, workerOn: boolean): Known<OutsideCheck> {
  if (site.tailnetOnly) return { known: false, reason: 'Tailnet only: not visible from outside' };
  if (!workerOn) return { known: false, reason: 'Outside checks aren’t set up' };
  const [last] = latestObservations<OutsideResult>(db, 'site', site.id, 'http', 'worker', 1);
  if (!last) return { known: false, reason: 'Not checked from outside yet' };
  return {
    known: true,
    value: { ok: last.ok, checkedAt: iso(last.at), problem: last.value.problem ?? null },
  };
}

function certificate(db: Db, site: Site): Known<Certificate> {
  const [last] = latestObservations<CertificateResult>(
    db,
    'site',
    site.id,
    'certificate',
    'mini',
    1,
  );
  if (!last) return { known: false, reason: 'Not read yet' };
  if (last.value.validTo === null || last.value.daysLeft === null) {
    return { known: false, reason: last.value.problem ?? 'Couldn’t read it' };
  }
  return {
    known: true,
    value: {
      validTo: iso(last.value.validTo),
      daysLeft: last.value.daysLeft,
      checkedAt: iso(last.at),
    },
  };
}

export function siteSummaries(db: Db, workerOn = false): SiteSummary[] {
  return listSites(db).map((site) => ({
    ...site,
    availability: availability(db, site),
    outside: outside(db, site, workerOn),
    certificate: certificate(db, site),
  }));
}

export function listServers(db: Db): Server[] {
  return db
    .prepare('SELECT * FROM servers WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE')
    .all()
    .map(toServer);
}

function health(at: number, r: Extract<ReportReading, { ok: true }>['report']): ServerHealth {
  const { totalBytes, availableBytes } = r.memory;
  return {
    checkedAt: iso(at),
    os: r.os.name,
    osSupportEnds: (r.os.id === 'ubuntu' && UBUNTU_EOL[r.os.codename]) || null,
    uptimeSeconds: r.uptimeSeconds === null ? null : Math.round(r.uptimeSeconds),
    securityUpdates: r.packages.security,
    otherUpdates: r.packages.other.length,
    rebootRequired: r.rebootRequired,
    stopped: [
      ...new Set([
        ...r.failedUnits.map((u) => u.replace(/\.service$/, '')),
        ...Object.entries(r.services)
          .filter(([, state]) => state === 'failed' || state === 'inactive')
          .map(([unit]) => unit),
      ]),
    ].sort(),
    disks: r.disks.map((d) => ({
      mount: d.mount,
      usedPercent: d.sizeBytes > 0 ? Math.round((d.usedBytes / d.sizeBytes) * 100) : 0,
      availableBytes: d.availableBytes,
    })),
    memoryUsedPercent:
      totalBytes && availableBytes !== null
        ? Math.round(((totalBytes - availableBytes) / totalBytes) * 100)
        : null,
    load: { one: r.load.one, cpus: r.load.cpus === null ? null : Math.round(r.load.cpus) },
    php: r.php,
  };
}

function serverSummary(db: Db, server: Server): ServerSummary {
  if (server.kind === 'local-mac') {
    const reason = 'Not read yet: molcajete’s local readers are still to come';
    return { ...server, health: { known: false, reason }, lastAttempt: { known: false, reason } };
  }
  const readings = latestObservations<ReportReading>(db, 'server', server.id, 'report', 'ssh', 50);
  const last = readings[0];
  const good = readings.find((o) => o.ok);
  return {
    ...server,
    health:
      good && good.value.ok
        ? { known: true, value: health(good.at, good.value.report) }
        : { known: false, reason: last ? 'No report has been read yet' : 'First report pending' },
    lastAttempt: last
      ? {
          known: true,
          value: {
            ok: last.ok,
            at: iso(last.at),
            problem: last.value.ok ? null : last.value.problem,
          },
        }
      : { known: false, reason: 'First report pending' },
  };
}

export function serverSummaries(db: Db): ServerSummary[] {
  return listServers(db).map((server) => serverSummary(db, server));
}

export function overview(db: Db): OverviewResponse {
  const sites = siteSummaries(db);
  const live = sites.filter((s) => s.setup === 'done' && !s.pausedAt);
  const checked = db.prepare('SELECT 1 FROM observations LIMIT 1').get() !== undefined;
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
      down: live.filter((s) => s.availability.known && s.availability.value.state === 'down')
        .length,
      unchecked: live.filter((s) => !s.availability.known).length,
    },
    servers: { total: listServers(db).length },
    attention:
      (watched > 0 && checked) || issues.length > 0
        ? { known: true, value: issues }
        : {
            known: false,
            reason: watched > 0 ? 'First checks haven’t run yet' : 'Nothing is being watched yet',
          },
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
  alertsConfigured: boolean;
}

export function status(db: Db, input: StatusInput): StatusResponse {
  const cycle = latestStartedJob(db, CYCLE);
  const beat = readHeartbeat(db);
  const discord = readDiscord(db);
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
    alerts: input.alertsConfigured
      ? {
          configured: true,
          lastOk: discord ? discord.lastOk : null,
          lastSuccessAt: discord ? isoOrNull(discord.lastSuccessAt) : null,
        }
      : { configured: false },
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
