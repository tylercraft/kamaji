// What the database box would lose, for the dialog before the passkey (Tyler, 2026-11-19): with
// the box ticked, the page asks for a count of orders (WooCommerce only), comments and users
// since the restore point; the backups process, which holds the SSH keys, asks the site's host
// (site-push/push `count`, read only) and keeps the answer here. No passkey: it changes nothing.
import type { RollbackCountView } from '@kamaji/shared';
import type { Db } from '../db.js';
import type { PullHost } from '../sitebackups/eligible.js';
import type { Exec } from '../sitebackups/restore.js';
import { newId, rollbackOffer } from './offer.js';
import { compactTime, readPush } from './push.js';

/** A count this fresh, for the same restore point, is shown again rather than asked again. */
const FRESH_MS = 60_000;
const COUNT_TIMEOUT_MS = 2 * 60_000;

export type CountAsked =
  { ok: true; id: string } | { ok: false; error: 'not_offered' | 'stale'; why: string };

export function requestCount(
  db: Db,
  siteId: string,
  ask: { batchId: string },
  now: number,
): CountAsked {
  const offer = rollbackOffer(db, siteId, now);
  if (!offer.ok) return { ok: false, error: 'not_offered', why: offer.why };
  if (offer.batchId !== ask.batchId)
    return { ok: false, error: 'stale', why: 'The run to roll back has changed; look again' };
  const since = offer.restorePoint.databaseAt;
  const same = db
    .prepare(
      `SELECT id FROM rollback_counts WHERE site_id = ? AND batch_id = ? AND since = ?
         AND (state IN ('waiting', 'running') OR (state = 'done' AND finished_at > ?))
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(siteId, offer.batchId, since, now - FRESH_MS);
  if (same) return { ok: true, id: String(same.id) };
  const id = newId();
  db.prepare(
    `INSERT INTO rollback_counts (id, site_id, batch_id, host, since, requested_at, state)
     VALUES (?, ?, ?, ?, ?, ?, 'waiting')`,
  ).run(id, siteId, offer.batchId, offer.host, since, now);
  return { ok: true, id };
}

export function countView(db: Db, siteId: string, id: string): RollbackCountView | null {
  const r = db
    .prepare('SELECT * FROM rollback_counts WHERE id = ? AND site_id = ?')
    .get(id, siteId);
  if (!r) return null;
  const done = r.state === 'done';
  return {
    id: String(r.id),
    state: String(r.state) as RollbackCountView['state'],
    since: new Date(Number(r.since)).toISOString(),
    counts: done
      ? {
          orders: r.orders === null ? null : Number(r.orders),
          comments: Number(r.comments),
          users: Number(r.users),
        }
      : null,
    problem: r.problem === null ? null : String(r.problem),
  };
}

/** Counts waiting for the backups process. */
export function countsWaiting(db: Db): string[] {
  return db
    .prepare("SELECT id FROM rollback_counts WHERE state = 'waiting' ORDER BY requested_at")
    .all()
    .map((r) => String(r.id));
}

export interface CountDeps {
  db: Db;
  exec: Exec;
  pushCommand: (siteId: string, host: PullHost, words: string[]) => string[] | null;
  now: () => number;
  log: (message: string) => void;
}

/** Asks the site's host for one waiting count. */
export async function runCount(deps: CountDeps, id: string): Promise<void> {
  const { db } = deps;
  const row = db
    .prepare("SELECT * FROM rollback_counts WHERE id = ? AND state = 'waiting'")
    .get(id);
  if (!row) return;
  db.prepare("UPDATE rollback_counts SET state = 'running' WHERE id = ?").run(id);
  const siteId = String(row.site_id);
  const finish = (
    o: { counts: { orders: number | null; comments: number; users: number } } | { problem: string },
  ) => {
    const c = 'counts' in o ? o.counts : null;
    db.prepare(
      `UPDATE rollback_counts SET state = ?, orders = ?, comments = ?, users = ?, problem = ?,
         finished_at = ? WHERE id = ?`,
    ).run(
      c ? 'done' : 'failed',
      c?.orders ?? null,
      c?.comments ?? null,
      c?.users ?? null,
      'problem' in o ? o.problem : null,
      deps.now(),
      id,
    );
    deps.log(`rollback: ${siteId} count ${c ? 'done' : 'failed'}`);
  };
  try {
    const command = deps.pushCommand(siteId, String(row.host) as PullHost, [
      'count',
      siteId,
      id,
      compactTime(Number(row.since)),
    ]);
    if (!command) return finish({ problem: 'its SSH access isn’t set' });
    const [bin, ...args] = command;
    const ran = await deps.exec(bin!, args, { timeoutMs: COUNT_TIMEOUT_MS });
    const read = readPush(ran.stdout);
    if (read.counts) return finish({ counts: read.counts });
    finish({
      problem:
        read.result?.problem ??
        (ran.code === 255
          ? 'SSH couldn’t connect to the host'
          : ran.code === null
            ? 'it took too long'
            : `it ended without a count (exit ${ran.code})`),
    });
  } catch (error) {
    finish({
      problem: `it stopped on the mini (${error instanceof Error ? error.name : 'error'})`,
    });
  }
}

/** Counts a backups process left running when it stopped. */
export function orphanedCounts(db: Db, now: number): void {
  db.prepare(
    `UPDATE rollback_counts SET state = 'failed', finished_at = ?,
       problem = 'the backups process stopped while it counted'
     WHERE state = 'running'`,
  ).run(now);
}
