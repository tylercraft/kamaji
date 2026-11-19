// Whether a site can be rolled back, and to what (ops/rollback-plan.md): its latest update run
// that hasn't been rolled back, put back from the whole-site snapshot that came before it, only
// while the site is still the way that run left it. Shared by the site's page, the request and
// the backups process, which asks again before it changes anything. The same for undoing a
// rollback: only while nothing has changed on the site since.
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { pullHost, type PullHost } from '../sitebackups/eligible.js';
import { exportTime } from '../backups/exportTime.js';
import { KAMAJI_ZONE } from '../sitebackups/schedule.js';

const DAY = 24 * 60 * 60_000;
/** How long the holding folder on the server keeps what a rollback replaced (site-push/push). */
export const UNDO_FOR = 14 * DAY;
/** craftish keeps its exports 14 days; a little short of that, the snapshot's dump is used. */
const EXPORT_FOR = 13 * DAY;
/** A run relied on a snapshot under a day old (updater/run.ts); a little slack for its start. */
const RELIED_ON = 26 * 60 * 60_000;

export type ItemType = 'core' | 'plugin' | 'theme';
export interface RollbackItem {
  type: ItemType;
  item: string;
  name: string;
  /** What the run installed, and the site has now. */
  now: string;
  /** What it replaced, which the rollback puts back. */
  back: string;
}

export interface RestorePoint {
  snapshotId: string;
  snapshotAt: number;
  /** craftish's own export before the run, as db-export named it, when it's still kept. */
  exportTime: string | null;
  /** When the database that would be put back was taken. */
  databaseAt: number;
}

export type Offer =
  | {
      ok: true;
      siteId: string;
      host: PullHost;
      batchId: string;
      approvedAt: number;
      restorePoint: RestorePoint;
      items: RollbackItem[];
      /** A core update across a major version, which can upgrade the database. */
      majorCore: boolean;
      /** The run was held, or carried on past a failure: Roll back is the obvious next step. */
      prominent: boolean;
    }
  | { ok: false; why: string };

type Row = Record<string, unknown>;

export const newId = () => randomBytes(8).toString('hex');

const minor = (v: string) => v.split('.').slice(0, 2).join('.');

/** Why something else is going on for the site, or null when nothing is. */
export function siteBusy(db: Db, siteId: string, except: string | null = null): string | null {
  const run = db
    .prepare(
      `SELECT 1 FROM batch_sites s JOIN batches b ON b.id = s.batch_id
       WHERE s.site_id = ? AND s.state IN ('waiting', 'running') AND b.state != 'finished' LIMIT 1`,
    )
    .get(siteId);
  if (run) return 'An update run is waiting or running for this site';
  const request = db
    .prepare('SELECT 1 FROM site_backup_requests WHERE site_id = ? AND taken_at IS NULL LIMIT 1')
    .get(siteId);
  if (request) return 'A backup or restore check is waiting for this site';
  const rollback = db
    .prepare(
      `SELECT state FROM rollbacks WHERE site_id = ? AND id != ?
       AND (state IN ('waiting', 'running') OR (checked_at IS NULL AND changed != 'none'))
       LIMIT 1`,
    )
    .get(siteId, except ?? '');
  if (rollback)
    return rollback.state === 'waiting' || rollback.state === 'running'
      ? 'A rollback is already waiting or running for this site'
      : 'The last rollback’s checks are still running';
  return null;
}

/**
 * Why a run can't be rolled back, in words about "this run" when it's the site's latest, and
 * naming it when it isn't: after a rollback, the line is about the run before (aleyahoerlein.com,
 * 2026-11-19), so it says which.
 */
interface Why {
  latest: string;
  earlier: string;
}

const dayFormat = new Intl.DateTimeFormat('en-NZ', {
  timeZone: KAMAJI_ZONE,
  day: 'numeric',
  month: 'short',
});

function runWhy(why: Why, latest: boolean, approvedAt: number): string {
  return latest
    ? why.latest
    : `The run on ${dayFormat.format(approvedAt)} can’t be rolled back: ${why.earlier}`;
}

/** The items a run changed that are still as it left them, or why the site has moved on. */
function runItems(db: Db, batchId: string, siteId: string): RollbackItem[] | Why {
  const rows = db
    .prepare(
      `SELECT type, item, name, from_version, to_version, outcome FROM batch_items
       WHERE batch_id = ? AND site_id = ? AND state = 'done' AND outcome != 'update_failed'
       ORDER BY position`,
    )
    .all(batchId, siteId);
  const current = db.prepare(
    'SELECT version FROM components WHERE site_id = ? AND type = ? AND item = ? AND gone_at IS NULL',
  );
  const items: RollbackItem[] = [];
  for (const r of rows) {
    const version = current.get(siteId, String(r.type), String(r.item))?.version;
    const now = version === undefined ? null : String(version);
    const to = String(r.to_version);
    const from = String(r.from_version);
    if (now === to) {
      items.push({
        type: String(r.type) as ItemType,
        item: String(r.item),
        name: String(r.name),
        now: to,
        back: from,
      });
      continue;
    }
    // An item that didn't pass and isn't at its new version never went in.
    if (now === from && r.outcome !== 'passed') continue;
    const name = String(r.name);
    return now === null
      ? {
          latest: `Since this run, ${name} has gone from the site, so it isn’t the way the run left it`,
          earlier: `${name} has gone from the site since`,
        }
      : {
          latest: `Since this run, ${name} went from ${to} to ${now} outside Kamaji, so the site isn’t the way the run left it`,
          earlier: `${name} went from ${to} to ${now} outside Kamaji since`,
        };
  }
  return items;
}

/** The rollback a run has had, if it's still in effect: done, and not undone since. */
function rolledBack(db: Db, batchId: string, siteId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM rollbacks r WHERE r.kind = 'rollback' AND r.batch_id = ? AND r.site_id = ?
         AND r.changed IN ('files', 'all')
         AND NOT EXISTS (SELECT 1 FROM rollbacks u WHERE u.kind = 'undo' AND u.undoes = r.id
           AND u.changed IN ('files', 'all'))
         LIMIT 1`,
      )
      .get(batchId, siteId) !== undefined
  );
}

/** The snapshot the run relied on or made, and craftish's export before it. */
function restorePoint(
  db: Db,
  siteId: string,
  batchId: string,
  startedAt: number,
  host: PullHost,
  now: number,
): RestorePoint | Why {
  const snapshot =
    db
      .prepare(
        `SELECT snapshot_id, started_at, forgotten_at FROM site_snapshots
         WHERE site_id = ? AND batch_id = ? AND ok = 1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(siteId, batchId) ??
    db
      .prepare(
        `SELECT snapshot_id, started_at, forgotten_at FROM site_snapshots
         WHERE site_id = ? AND ok = 1 AND finished_at <= ? AND started_at >= ?
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(siteId, startedAt, startedAt - RELIED_ON);
  if (!snapshot)
    return {
      latest: 'No whole-site backup came before this run, so Kamaji has no files to put back',
      earlier: 'no whole-site backup came before it',
    };
  const pruned = 'been pruned (Kamaji keeps 14 days of them, then one a week and one a month)';
  if (snapshot.forgotten_at !== null)
    return {
      latest: `This run’s whole-site backup has ${pruned}`,
      earlier: `its whole-site backup has ${pruned}`,
    };
  const snapshotAt = Number(snapshot.started_at);
  const exported =
    host === 'craftish'
      ? db
          .prepare(
            `SELECT exported_at FROM backup_evidence WHERE site_id = ? AND batch_id = ? AND ok = 1
             AND kind = 'export' AND exported_at IS NOT NULL ORDER BY recorded_at DESC, id DESC LIMIT 1`,
          )
          .get(siteId, batchId)
      : undefined;
  const raw = exported ? String(exported.exported_at) : null;
  const at = raw && /^[0-9]{8}T[0-9]{6}Z$/.test(raw) ? exportTime(raw) : null;
  const exportAt = at ? Date.parse(at) : null;
  if (raw && exportAt !== null && exportAt > now - EXPORT_FOR && exportAt > snapshotAt)
    return {
      snapshotId: String(snapshot.snapshot_id),
      snapshotAt,
      exportTime: raw,
      databaseAt: exportAt,
    };
  return {
    snapshotId: String(snapshot.snapshot_id),
    snapshotAt,
    exportTime: null,
    databaseAt: snapshotAt,
  };
}

/** Why a host can't be rolled back, or null when it can. */
function hostProblem(db: Db, siteId: string, host: PullHost | null): string | null {
  if (!host)
    return 'Rollback needs SSH, which Kamaji has only on craftish and Kinsta. This host’s own backups are the way back';
  if (host === 'kinsta') {
    const access = db.prepare('SELECT test_ok FROM kinsta_access WHERE site_id = ?').get(siteId);
    if (!access || Number(access.test_ok) !== 1)
      return 'Rollback on Kinsta needs its SSH access tested first, under Configure → Backups';
  }
  return null;
}

/** What Roll back would do for a site now, or why it isn't offered. */
export function rollbackOffer(
  db: Db,
  siteId: string,
  now: number,
  except: string | null = null,
): Offer {
  const site = db.prepare('SELECT id FROM sites WHERE id = ? AND removed_at IS NULL').get(siteId);
  if (!site) return { ok: false, why: 'No such site' };
  const host = pullHost(db, siteId);
  const problem = hostProblem(db, siteId, host);
  if (problem) return { ok: false, why: problem };
  const busy = siteBusy(db, siteId, except);
  if (busy) return { ok: false, why: busy };
  const runs = db
    .prepare(
      `SELECT s.batch_id, s.state, s.started_at, b.approved_at,
         EXISTS (SELECT 1 FROM batch_items i WHERE i.batch_id = s.batch_id AND i.site_id = s.site_id
           AND i.state = 'done' AND i.outcome != 'passed') AS failed
       FROM batch_sites s JOIN batches b ON b.id = s.batch_id
       WHERE s.site_id = ? AND s.state IN ('done', 'held') AND s.started_at IS NOT NULL
       ORDER BY b.approved_at DESC, s.batch_id DESC`,
    )
    .all(siteId);
  for (const [n, run] of runs.entries()) {
    const batchId = String(run.batch_id);
    if (rolledBack(db, batchId, siteId)) continue;
    const why = (w: Why) => ({
      ok: false as const,
      why: runWhy(w, n === 0, Number(run.approved_at)),
    });
    const items = runItems(db, batchId, siteId);
    if (!Array.isArray(items)) return why(items);
    // A run that changed nothing leaves the site as the run before it left it.
    if (items.length === 0) continue;
    const point = restorePoint(db, siteId, batchId, Number(run.started_at), host!, now);
    if ('latest' in point) return why(point);
    const core = items.find((i) => i.type === 'core');
    return {
      ok: true,
      siteId,
      host: host!,
      batchId,
      approvedAt: Number(run.approved_at),
      restorePoint: point,
      items,
      majorCore: core !== undefined && minor(core.now) !== minor(core.back),
      prominent: run.state === 'held' || Number(run.failed) === 1,
    };
  }
  return {
    ok: false,
    why:
      runs.length === 0
        ? 'No update run has changed this site yet'
        : 'Nothing its update runs changed is left to put back',
  };
}

export type UndoOffer =
  | { ok: true; rollbackId: string; canDatabase: boolean; until: number; items: RollbackItem[] }
  | { ok: false; why: string };

const itemsOf = (db: Db, rollbackId: string): RollbackItem[] =>
  db
    .prepare('SELECT * FROM rollback_items WHERE rollback_id = ? ORDER BY position')
    .all(rollbackId)
    .map((r: Row) => ({
      type: String(r.type) as ItemType,
      item: String(r.item),
      name: String(r.name),
      now: String(r.now_version),
      back: String(r.back_version),
    }));
export { itemsOf as rollbackItems };

/** Whether the site's latest rollback can be undone now, or why not; null when there's none. */
export function undoOffer(
  db: Db,
  siteId: string,
  now: number,
  except: string | null = null,
): UndoOffer | null {
  const r = db
    .prepare(
      `SELECT * FROM rollbacks WHERE site_id = ? AND kind = 'rollback' AND changed IN ('files', 'all')
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(siteId);
  if (!r) return null;
  const id = String(r.id);
  const undone = db
    .prepare(
      `SELECT changed FROM rollbacks WHERE kind = 'undo' AND undoes = ?
       AND changed IS NOT NULL AND changed != 'none' LIMIT 1`,
    )
    .get(id);
  if (undone)
    return undone.changed === 'files' || undone.changed === 'all'
      ? { ok: false, why: 'This rollback has been undone' }
      : {
          ok: false,
          why: 'The undo of this rollback stopped part way, and needs a look on the server',
        };
  const finished = Number(r.finished_at);
  if (finished + UNDO_FOR <= now)
    return { ok: false, why: 'It’s been over 14 days, so the copies it replaced are gone' };
  const busy = siteBusy(db, siteId, except);
  if (busy) return { ok: false, why: busy };
  const later = db
    .prepare(
      `SELECT 1 FROM batch_sites s JOIN batches b ON b.id = s.batch_id
       WHERE s.site_id = ? AND b.approved_at > ? LIMIT 1`,
    )
    .get(siteId, finished);
  if (later) return { ok: false, why: 'An update run since the rollback has changed the site' };
  const items = itemsOf(db, id);
  const current = db.prepare(
    'SELECT version FROM components WHERE site_id = ? AND type = ? AND item = ? AND gone_at IS NULL',
  );
  for (const i of items) {
    const version = current.get(siteId, i.type, i.item)?.version;
    if (version === undefined || String(version) !== i.back)
      return {
        ok: false,
        why: `Since the rollback, ${i.name} ${version === undefined ? 'has gone from the site' : `went from ${i.back} to ${String(version)}`}, so the site isn’t the way the rollback left it`,
      };
  }
  return {
    ok: true,
    rollbackId: id,
    canDatabase: Number(r.with_database) === 1 && r.changed === 'all',
    until: finished + UNDO_FOR,
    items,
  };
}
