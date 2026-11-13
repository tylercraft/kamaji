// The backups process's work (ops/backups-plan.md, "The process and the schedule"): the Backups
// panel's requests, then each site that's due, then at most one restore check, then the
// repository's upkeep and size. One site at a time. Everything it does is recorded in
// site_snapshots, restore_checks and Activity; failures say why in plain words.
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { ELIGIBLE, eligible } from './eligible.js';
import { backupFailed, backupWorked, restoreFailed, restoreWorked } from './alerts.js';
import { readState, writeState } from '../state.js';
import type { RestoreResult } from './restore.js';
import type { Restic } from './restic.js';
import { checkPull, readTar } from './tar.js';

const DAY = 24 * 60 * 60_000;
/** A little under a week or a fortnight, so a nightly run doesn't slip a day each time. */
export const INTERVAL = { weekly: 6.5 * DAY, fortnightly: 13.5 * DAY } as const;
export const RESTORE_EVERY = 30 * DAY;
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

export function dueSites(db: Db, now: number): string[] {
  return db
    .prepare(
      `SELECT s.id, s.site_backup_schedule AS schedule,
         (SELECT MAX(started_at) FROM site_snapshots WHERE site_id = s.id AND ok = 1) AS last
       FROM sites s WHERE ${ELIGIBLE} ORDER BY s.id`,
    )
    .all()
    .filter(
      (r) =>
        r.last === null ||
        Number(r.last) <= now - INTERVAL[String(r.schedule) as keyof typeof INTERVAL],
    )
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

export async function backUpSite(deps: BackupsDeps, siteId: string): Promise<boolean> {
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
         added_bytes, database_bytes, database_sha256, wordpress, problem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    recordEvent(db, now(), {
      kind: fields.ok ? 'site.backup' : 'site.backup-failed',
      summary: fields.ok
        ? `Whole-site backup of ${name}: ${mb(fields.bytes)}, ${mb(fields.added)} new`
        : `Whole-site backup of ${name} failed: ${fields.problem}`,
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

/** 4 weekly, 6 monthly; then marks what restic no longer has as forgotten. */
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

export async function checkRestore(deps: BackupsDeps, siteId: string): Promise<boolean> {
  const { db, now } = deps;
  const startedAt = now();
  const snapshotId = latestSnapshot(db, siteId);
  const row = db.prepare('SELECT name, expected_text FROM sites WHERE id = ?').get(siteId);
  const result: RestoreResult = snapshotId
    ? await deps.restore(
        { id: siteId, expectedText: row?.expected_text == null ? null : String(row.expected_text) },
        snapshotId,
      )
    : { ok: false, step: 'restore', problem: 'there’s no snapshot to restore yet' };
  const finishedAt = now();
  db.prepare(
    `INSERT INTO restore_checks (site_id, snapshot_id, started_at, finished_at, ok, failed_step, problem)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    siteId,
    snapshotId,
    startedAt,
    finishedAt,
    result.ok ? 1 : 0,
    result.ok ? null : result.step,
    result.ok ? null : result.problem,
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
export function takeRequests(
  db: Db,
  now: number,
): { siteId: string; kind: 'backup' | 'restore' }[] {
  const rows = db
    .prepare(
      'SELECT id, site_id, kind FROM site_backup_requests WHERE taken_at IS NULL ORDER BY id',
    )
    .all();
  const take = db.prepare('UPDATE site_backup_requests SET taken_at = ? WHERE id = ?');
  const seen = new Set<string>();
  const out: { siteId: string; kind: 'backup' | 'restore' }[] = [];
  for (const r of rows) {
    take.run(now, Number(r.id));
    const key = `${String(r.site_id)} ${String(r.kind)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ siteId: String(r.site_id), kind: String(r.kind) as 'backup' | 'restore' });
  }
  return out;
}

/** The mini's local date, for once-a-day upkeep. */
const localDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA');

export async function runBackups(deps: BackupsDeps): Promise<void> {
  const { db, now } = deps;
  const stopped = () => deps.signal?.aborted === true;
  const backedUp = new Set<string>();
  const checked = new Set<string>();
  for (const request of takeRequests(db, now())) {
    if (stopped()) return;
    if (!eligible(db, request.siteId)) continue;
    if (request.kind === 'backup') {
      await backUpSite(deps, request.siteId);
      backedUp.add(request.siteId);
    } else {
      await checkRestore(deps, request.siteId);
      checked.add(request.siteId);
    }
  }
  for (const siteId of dueSites(db, now())) {
    if (stopped()) return;
    if (!backedUp.has(siteId)) await backUpSite(deps, siteId);
  }
  if (stopped()) return;
  const restore = checked.size === 0 ? restoreDue(db, now()) : null;
  if (restore) await checkRestore(deps, restore);
  if (stopped()) return;

  const today = localDay(now());
  const upkeep = readState<{ pruned?: string; checked?: string }>(db, UPKEEP) ?? {};
  const date = new Date(now());
  if (date.getDay() === 0 && upkeep.pruned !== today) {
    const pruned = await deps.restic.prune();
    if (!pruned.ok) deps.log(`backups: prune failed: ${pruned.problem}`);
    upkeep.pruned = today;
  }
  if (date.getDate() === 1 && upkeep.checked !== today) {
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
