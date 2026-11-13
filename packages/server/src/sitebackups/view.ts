// What a site's Backups panel shows of its whole-site backups, read from what the backups
// process recorded (run.ts). The app never runs restic: it only reads these tables and asks the
// process, through site_backup_requests.
import type { RestoreCheck, SiteSnapshot, WholeSiteBackups } from '@kamaji/shared';
import type { Db } from '../db.js';
import { readState } from '../state.js';
import { eligible, INTERVAL, REPOSITORY } from './run.js';

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(Number(v)));
const intOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function wholeSiteView(db: Db, siteId: string): WholeSiteBackups | null {
  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND removed_at IS NULL').get(siteId);
  if (!site || site.host_kind !== 'craftish') return null;
  const schedule = String(site.site_backup_schedule) as WholeSiteBackups['schedule'];
  const active = eligible(db, siteId);
  const snapshots: SiteSnapshot[] = db
    .prepare(
      'SELECT * FROM site_snapshots WHERE site_id = ? ORDER BY started_at DESC, id DESC LIMIT 30',
    )
    .all(siteId)
    .map((r) => ({
      startedAt: iso(Number(r.started_at)),
      finishedAt: iso(Number(r.finished_at)),
      ok: Number(r.ok) === 1,
      bytes: intOrNull(r.bytes),
      addedBytes: intOrNull(r.added_bytes),
      databaseBytes: intOrNull(r.database_bytes),
      wordpress: strOrNull(r.wordpress),
      problem: strOrNull(r.problem),
      forgotten: r.forgotten_at !== null,
    }));
  const restoreChecks: RestoreCheck[] = db
    .prepare(
      'SELECT * FROM restore_checks WHERE site_id = ? ORDER BY started_at DESC, id DESC LIMIT 10',
    )
    .all(siteId)
    .map((r) => ({
      startedAt: iso(Number(r.started_at)),
      seconds: Math.round((Number(r.finished_at) - Number(r.started_at)) / 1000),
      ok: Number(r.ok) === 1,
      failedStep: strOrNull(r.failed_step),
      problem: strOrNull(r.problem),
    }));
  const lastGood = db
    .prepare('SELECT MAX(started_at) AS at FROM site_snapshots WHERE site_id = ? AND ok = 1')
    .get(siteId)?.at;
  const finished = (table: string) =>
    Number(
      db.prepare(`SELECT MAX(finished_at) AS at FROM ${table} WHERE site_id = ?`).get(siteId)?.at ??
        0,
    );
  /** The newest request of a kind, while nothing has finished since it was asked. */
  const pending = (kind: 'backup' | 'restore', table: string) => {
    const asked = db
      .prepare(
        'SELECT MAX(requested_at) AS at FROM site_backup_requests WHERE site_id = ? AND kind = ?',
      )
      .get(siteId, kind)?.at;
    return asked !== null && asked !== undefined && Number(asked) > finished(table)
      ? iso(Number(asked))
      : null;
  };
  const repository = readState<{ bytes: number; at: number }>(db, REPOSITORY);
  return {
    schedule,
    own: Number(site.own) === 1,
    consentAt: isoOrNull(site.site_backup_consent_at),
    consentBy: strOrNull(site.site_backup_consent_by),
    active,
    lastGoodAt: isoOrNull(lastGood),
    nextDueAt:
      active && schedule !== 'off'
        ? lastGood === null || lastGood === undefined
          ? null
          : iso(Number(lastGood) + INTERVAL[schedule])
        : null,
    snapshots,
    restoreChecks,
    pending: {
      backup: pending('backup', 'site_snapshots'),
      restore: pending('restore', 'restore_checks'),
    },
    repository: repository ? { bytes: repository.bytes, at: iso(repository.at) } : null,
  };
}

/** Queues a request for the backups process. Refused unless the site's backups are on. */
export function requestWholeSite(
  db: Db,
  siteId: string,
  kind: 'backup' | 'restore',
  login: string,
  now: number,
): 'queued' | 'not-active' | 'already' {
  if (!eligible(db, siteId)) return 'not-active';
  const view = wholeSiteView(db, siteId);
  if (view?.pending[kind]) return 'already';
  db.prepare(
    `INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by) VALUES (?, ?, ?, ?)`,
  ).run(siteId, kind, now, login);
  return 'queued';
}
