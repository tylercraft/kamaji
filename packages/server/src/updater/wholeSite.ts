// A whole-site snapshot before an update (backups/beforeUpdate.ts). The updater never holds the
// restic password or the pull key: it asks the backups process the way the Backups panel does,
// with a request naming its batch, and waits for that batch's snapshot to be recorded. The app's
// cycle starts the backups process when a request is waiting (main.ts), and the process takes
// requests between sites, so a nightly list doesn't keep an update waiting.
import type { Db } from '../db.js';
import { BEFORE_UPDATE } from '../backups/beforeUpdate.js';
import type { BackupResult } from './run.js';

/** A big site's pull can take a while; past this, the update is held rather than left waiting. */
export const SNAPSHOT_WAIT_MS = 90 * 60_000;
export const SNAPSHOT_POLL_MS = 15_000;

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export interface SnapshotWait {
  db: Db;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  waitMs?: number;
  pollMs?: number;
}

/** The newest good snapshot the backups process recorded for a site, or null. */
export function latestGoodSnapshot(db: Db, siteId: string): number | null {
  const at = db
    .prepare(
      `SELECT MAX(started_at) AS at FROM site_snapshots
       WHERE site_id = ? AND ok = 1 AND forgotten_at IS NULL`,
    )
    .get(siteId)?.at;
  return at === null || at === undefined ? null : Number(at);
}

function result(row: Record<string, unknown>): BackupResult {
  const when = new Date(Number(row.finished_at)).toISOString();
  return Number(row.ok) === 1
    ? {
        ok: true,
        words: `${BEFORE_UPDATE.snapshot}: snapshot ${String(row.snapshot_id).slice(0, 8)}, ${mb(Number(row.bytes))}, read back whole, ${when}`,
        bytes: Number(row.bytes),
      }
    : {
        ok: false,
        words: `${BEFORE_UPDATE.snapshot} failed: ${String(row.problem ?? 'the backup failed')}`,
      };
}

/** Asks for the snapshot and waits for it. A request already asked for this batch is reused. */
export async function snapshotBeforeUpdate(
  deps: SnapshotWait,
  siteId: string,
  batchId: string,
): Promise<BackupResult> {
  const { db } = deps;
  const recorded = () =>
    db
      .prepare(
        'SELECT * FROM site_snapshots WHERE site_id = ? AND batch_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(siteId, batchId);
  // After a restart, the run picks up where it was: a snapshot already made, or a request waiting.
  const done = recorded();
  if (done) return result(done);
  let request = db
    .prepare(
      `SELECT id, requested_at FROM site_backup_requests
       WHERE site_id = ? AND batch_id = ? AND kind = 'backup' ORDER BY id DESC LIMIT 1`,
    )
    .get(siteId, batchId);
  if (!request) {
    db.prepare(
      `INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by, batch_id)
       VALUES (?, 'backup', ?, 'updater', ?)`,
    ).run(siteId, deps.now(), batchId);
    request = { id: 0, requested_at: deps.now() };
  }
  const deadline = Number(request.requested_at) + (deps.waitMs ?? SNAPSHOT_WAIT_MS);
  for (;;) {
    const row = recorded();
    if (row) return result(row);
    if (deps.now() >= deadline) {
      // Not taken yet: withdrawn, so it doesn't run long after the update has been held.
      db.prepare(
        `UPDATE site_backup_requests SET taken_at = ?
         WHERE site_id = ? AND batch_id = ? AND taken_at IS NULL`,
      ).run(deps.now(), siteId, batchId);
      return {
        ok: false,
        words: `${BEFORE_UPDATE.snapshot} didn’t finish within ${Math.round((deps.waitMs ?? SNAPSHOT_WAIT_MS) / 60_000)} min: the backups process may not be running`,
      };
    }
    await deps.sleep(deps.pollMs ?? SNAPSHOT_POLL_MS, deps.signal);
  }
}
