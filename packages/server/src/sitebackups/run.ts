// The backups process's work (ops/backups-plan.md, "The process and the schedule"), hourly at :15:
// the Backups panel's requests, then each site that's due by the update time (schedule.ts), each
// restore-checked once it's backed up; then, in the 03:15 run only, the 30-day fallback restore
// check and the repository's upkeep; then its size. One site at a time. Everything it does is
// recorded in site_snapshots, restore_checks and Activity; failures say why in plain words.
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { ELIGIBLE, eligible } from './eligible.js';
import { backupFailed, backupWorked, restoreFailed, restoreWorked } from './alerts.js';
import { readState, writeState } from '../state.js';
import type { RestoreResult } from './restore.js';
import type { Restic } from './restic.js';
import { checkPull, readTar } from './tar.js';
import { readUpdateTime } from '../settings.js';
import { isDue, KAMAJI_ZONE, wallClock, type Schedule } from './schedule.js';

const DAY = 24 * 60 * 60_000;
export const RESTORE_EVERY = 30 * DAY;
/** Tries at one backup night before it waits for the next: a failure isn't retried every hour. */
export const TRIES_PER_NIGHT = 3;
/** The NZ hour of the run that does the night's restore check and upkeep. */
export const NIGHTLY_HOUR = 3;
export const REPOSITORY = 'sitebackups.repository';
const UPKEEP = 'sitebackups.upkeep';
export { eligible };

export interface BackupsDeps {
  db: Db;
  restic: Restic;
  restore: (
    site: { id: string; expectedText: string | null },
    snapshotId: string,
  ) => Promise<RestoreResult>;
  /** The ssh command that streams a site's pull from craftish. */
  pullCommand: (siteId: string) => string[];
  now: () => number;
  log: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * Sites due now: their backup night has begun and they have no good snapshot for it, so a run
 * missed at 03:15 is made up at the next one. A night that has failed three times waits for the
 * next night (or Back up site now), rather than pulling the site from craftish every hour.
 */
export function dueSites(db: Db, now: number): string[] {
  const time = readUpdateTime(db);
  const tries = db.prepare(
    'SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND ok = 0 AND started_at >= ?',
  );
  return db
    .prepare(
      `SELECT s.id, s.site_backup_schedule AS schedule, s.time_zone AS zone,
         (SELECT MAX(started_at) FROM site_snapshots WHERE site_id = s.id AND ok = 1) AS last
       FROM sites s WHERE ${ELIGIBLE} ORDER BY s.id`,
    )
    .all()
    .filter((r) => {
      const { due, night } = isDue(now, time, {
        zone: String(r.zone),
        schedule: String(r.schedule) as Schedule,
        lastGood: r.last === null ? null : Number(r.last),
      });
      return due && Number(tries.get(String(r.id), night)?.n ?? 0) < TRIES_PER_NIGHT;
    })
    .map((r) => String(r.id));
}

/** A site's newest good snapshot that retention hasn't forgotten. */
export function latestSnapshot(db: Db, siteId: string): string | null {
  const row = db
    .prepare(
      `SELECT snapshot_id FROM site_snapshots WHERE site_id = ? AND ok = 1 AND forgotten_at IS NULL
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(siteId);
  return row ? String(row.snapshot_id) : null;
}

/** The site whose last restore check is oldest (or never), if over 30 days ago. */
export function restoreDue(db: Db, now: number): string | null {
  const rows = db
    .prepare(
      `SELECT s.id, (SELECT MAX(started_at) FROM restore_checks WHERE site_id = s.id) AS last
       FROM sites s WHERE ${ELIGIBLE} ORDER BY last IS NOT NULL, last, s.id`,
    )
    .all();
  for (const r of rows) {
    if (r.last !== null && Number(r.last) > now - RESTORE_EVERY) return null;
    if (latestSnapshot(db, String(r.id))) return String(r.id);
  }
  return null;
}

function siteName(db: Db, siteId: string): string {
  return String(db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId)?.name ?? siteId);
}

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** One site's backup; `batchId` when the updater asked for it before that batch's update. */
export async function backUpSite(
  deps: BackupsDeps,
  siteId: string,
  batchId: string | null = null,
): Promise<boolean> {
  const { db, restic, now } = deps;
  const startedAt = now();
  const name = siteName(db, siteId);
  const record = (
    fields:
      | {
          ok: true;
          snapshotId: string;
          bytes: number;
          added: number;
          database: { bytes: number; sha256: string };
          wordpress: string;
        }
      | { ok: false; problem: string },
  ) => {
    db.prepare(
      `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id, bytes,
         added_bytes, database_bytes, database_sha256, wordpress, problem, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      siteId,
      startedAt,
      now(),
      fields.ok ? 1 : 0,
      fields.ok ? fields.snapshotId : null,
      fields.ok ? fields.bytes : null,
      fields.ok ? fields.added : null,
      fields.ok ? fields.database.bytes : null,
      fields.ok ? fields.database.sha256 : null,
      fields.ok ? fields.wordpress : null,
      fields.ok ? null : fields.problem,
      batchId,
    );
    recordEvent(db, now(), {
      kind: fields.ok ? 'site.backup' : 'site.backup-failed',
      summary: fields.ok
        ? `Whole-site backup of ${name}${batchId ? ' before update' : ''}: ${mb(fields.bytes)}, ${mb(fields.added)} new`
        : `Whole-site backup of ${name}${batchId ? ' before update' : ''} failed: ${fields.problem}`,
      resourceType: 'site',
      resourceId: siteId,
    });
    if (fields.ok) backupWorked(db, now(), siteId, name);
    else backupFailed(db, now(), siteId, `Whole-site backup of ${name} failed: ${fields.problem}`);
    deps.log(`backups: ${siteId} ${fields.ok ? 'backed up' : 'failed'}`);
    return fields.ok;
  };

  const made = await restic.backup(siteId, deps.pullCommand(siteId), deps.signal);
  if (!made.ok) return record(made);
  // Read the snapshot back, as stored, before it counts.
  const dumped = await restic.dump(made.snapshotId, siteId, readTar, deps.signal);
  const checked = dumped.ok ? checkPull(dumped.value, siteId) : dumped;
  if (!checked.ok) {
    await restic.forget([made.snapshotId]);
    return record({ ok: false, problem: `${checked.problem}; the snapshot was discarded` });
  }
  record({
    ok: true,
    snapshotId: made.snapshotId,
    bytes: made.bytes,
    added: made.added,
    database: checked.manifest.database,
    wordpress: checked.manifest.wordpress,
  });
  await applyRetention(deps, siteId);
  return true;
}

/** 14 days, 4 weekly, 6 monthly (KEEP); then marks what restic no longer has as forgotten. */
async function applyRetention(deps: BackupsDeps, siteId: string): Promise<void> {
  const kept = await deps.restic.keep(siteId);
  if (!kept.ok) deps.log(`backups: retention for ${siteId} failed: ${kept.problem}`);
  const listed = await deps.restic.snapshots(siteId);
  if (!listed.ok) return;
  const ids = new Set(listed.ids);
  const rows = deps.db
    .prepare(
      'SELECT id, snapshot_id FROM site_snapshots WHERE site_id = ? AND ok = 1 AND forgotten_at IS NULL',
    )
    .all(siteId);
  const forget = deps.db.prepare('UPDATE site_snapshots SET forgotten_at = ? WHERE id = ?');
  for (const r of rows) if (!ids.has(String(r.snapshot_id))) forget.run(deps.now(), Number(r.id));
}

/** A restore check of `snapshotId`, or of the site's latest snapshot. */
export async function checkRestore(
  deps: BackupsDeps,
  siteId: string,
  snapshot: string | null = null,
): Promise<boolean> {
  const { db, now } = deps;
  const startedAt = now();
  const snapshotId = snapshot ?? latestSnapshot(db, siteId);
  const row = db.prepare('SELECT name, expected_text FROM sites WHERE id = ?').get(siteId);
  const result: RestoreResult = snapshotId
    ? await deps.restore(
        { id: siteId, expectedText: row?.expected_text == null ? null : String(row.expected_text) },
        snapshotId,
      )
    : { ok: false, step: 'restore', problem: 'there’s no snapshot to restore yet' };
  const finishedAt = now();
  db.prepare(
    `INSERT INTO restore_checks (site_id, snapshot_id, started_at, finished_at, ok, failed_step, problem, problem_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    siteId,
    snapshotId,
    startedAt,
    finishedAt,
    result.ok ? 1 : 0,
    result.ok ? null : result.step,
    result.ok ? null : result.problem,
    // Only on the check's own row and the Backups panel: never in Activity or Discord.
    result.ok ? null : (result.detail ?? null),
  );
  const seconds = Math.round((finishedAt - startedAt) / 1000);
  const name = siteName(db, siteId);
  recordEvent(db, finishedAt, {
    kind: result.ok ? 'site.restore-check' : 'site.restore-check-failed',
    summary: result.ok
      ? `${name} restored to an offline test copy and served its home page (${seconds} s)`
      : `${name}’s restore check failed at “${result.step}”: ${result.problem}`,
    resourceType: 'site',
    resourceId: siteId,
  });
  if (result.ok) restoreWorked(db, finishedAt, siteId, name);
  else
    restoreFailed(
      db,
      finishedAt,
      siteId,
      `${name}’s restore check failed at “${result.step}”: ${result.problem}`,
    );
  deps.log(`backups: ${siteId} restore check ${result.ok ? 'passed' : 'failed'}`);
  return result.ok;
}

/** The panel's requests not yet taken, each marked taken. */
export interface Request {
  siteId: string;
  kind: 'backup' | 'restore';
  /** The batch the updater is holding for this backup; null for the panel's. */
  batchId: string | null;
}

/** Whether a request waits for the backups process: the app's cycle starts it then. */
export function requestsWaiting(db: Db): boolean {
  return (
    db.prepare('SELECT 1 FROM site_backup_requests WHERE taken_at IS NULL LIMIT 1').get() !==
    undefined
  );
}

/** The requests not yet taken, each marked taken; an updater's wins over the panel's twin. */
export function takeRequests(db: Db, now: number): Request[] {
  const rows = db
    .prepare(
      'SELECT id, site_id, kind, batch_id FROM site_backup_requests WHERE taken_at IS NULL ORDER BY id',
    )
    .all();
  const take = db.prepare('UPDATE site_backup_requests SET taken_at = ? WHERE id = ?');
  const out = new Map<string, Request>();
  for (const r of rows) {
    take.run(now, Number(r.id));
    const key = `${String(r.site_id)} ${String(r.kind)}`;
    const batchId = r.batch_id === null ? null : String(r.batch_id);
    const seen = out.get(key);
    if (seen && (seen.batchId !== null || batchId === null)) continue;
    out.set(key, {
      siteId: String(r.site_id),
      kind: String(r.kind) as 'backup' | 'restore',
      batchId,
    });
  }
  return [...out.values()];
}

/** The NZ date and hour, for the once-a-night work. */
function nzNight(ms: number): { day: string; hour: number; weekday: number; date: number } {
  const w = wallClock(KAMAJI_ZONE, ms);
  return {
    day: `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`,
    hour: w.hour,
    weekday: w.weekday,
    date: w.day,
  };
}

export async function runBackups(deps: BackupsDeps): Promise<void> {
  const { db, now } = deps;
  const stopped = () => deps.signal?.aborted === true;
  const backedUp = new Set<string>();
  /** Restore checks asked for from the panel: one stands in for the night's fallback. */
  const asked = new Set<string>();
  // Requests first, and again after each scheduled site: an update waiting on its backup
  // shouldn't wait for the whole night's list.
  const requests = async () => {
    // Back up site now is restore-checked straight after, like a scheduled backup; a snapshot
    // the updater asked for isn't. The checks wait until every backup taken here is done, so an
    // update waiting on its own backup isn't held behind one.
    const toCheck: { siteId: string; snapshotId: string | null }[] = [];
    for (const request of takeRequests(db, now())) {
      if (stopped()) return;
      if (!eligible(db, request.siteId)) continue;
      if (request.kind === 'backup') {
        const ok = await backUpSite(deps, request.siteId, request.batchId);
        backedUp.add(request.siteId);
        if (ok && request.batchId === null)
          toCheck.push({ siteId: request.siteId, snapshotId: latestSnapshot(db, request.siteId) });
      } else {
        await checkRestore(deps, request.siteId);
        asked.add(request.siteId);
      }
    }
    for (const check of toCheck) {
      if (stopped()) return;
      // A check asked for in the same run already covers it.
      if (asked.has(check.siteId)) continue;
      await checkRestore(deps, check.siteId, check.snapshotId);
    }
  };
  await requests();
  // Each scheduled backup that works is restore-checked straight away, that snapshot, in this
  // run. An update waiting on its own backup goes first; a before-update snapshot isn't checked
  // (its read-back covers it, and the update shouldn't wait).
  for (const siteId of dueSites(db, now())) {
    if (stopped()) return;
    if (!backedUp.has(siteId) && (await backUpSite(deps, siteId))) {
      const made = latestSnapshot(db, siteId);
      await requests();
      if (stopped()) return;
      await checkRestore(deps, siteId, made);
    }
    await requests();
  }
  if (stopped()) return;
  const night = nzNight(now());
  const upkeep =
    readState<{ pruned?: string; checked?: string; restored?: string }>(db, UPKEEP) ?? {};
  const today = night.day;
  // The fallback, for sites whose snapshots were made some other way (before an update, or
  // before this check came in): one a night, in the 03:15 run, for a site unchecked for 30 days; none after one
  // asked for.
  if (night.hour === NIGHTLY_HOUR && upkeep.restored !== today) {
    const restore = asked.size === 0 ? restoreDue(db, now()) : null;
    if (restore) await checkRestore(deps, restore);
    upkeep.restored = today;
    if (stopped()) return;
  }
  if (night.hour === NIGHTLY_HOUR && night.weekday === 0 && upkeep.pruned !== today) {
    const pruned = await deps.restic.prune();
    if (!pruned.ok) deps.log(`backups: prune failed: ${pruned.problem}`);
    upkeep.pruned = today;
  }
  if (night.hour === NIGHTLY_HOUR && night.date === 1 && upkeep.checked !== today) {
    const result = await deps.restic.check();
    recordEvent(db, now(), {
      kind: result.ok ? 'backups.checked' : 'backups.check-failed',
      summary: result.ok
        ? 'The backup repository checked out (5% of its data read back)'
        : `The backup repository’s check failed: ${result.problem}`,
    });
    upkeep.checked = today;
  }
  writeState(db, UPKEEP, upkeep, now());
  const size = await deps.restic.size();
  if (size.ok) writeState(db, REPOSITORY, { bytes: size.bytes, at: now() }, now());
}
