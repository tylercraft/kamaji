// The updater's side of screenshot checks (ops/screenshots-plan.md, "The flow"): ask for a set,
// start the screenshots process, and wait for it, up to 4 minutes for "before" and 3 for "after"
// (Tyler, 2026-11-19). Report-only: whatever happens here, the run goes on, and a set it stopped
// waiting for is failed, so it never lands after the updates have started.
import type { Db } from '../db.js';
import { HEARTBEAT, requestSet } from './sets.js';

export interface ShotsWait {
  db: Db;
  /** Starts the screenshots process (updates/launcher.ts). */
  start: () => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  capMs?: { before: number; after: number };
}

export const WAIT_MS = { before: 4 * 60_000, after: 3 * 60_000 };
/** A process that hasn't shown itself by now isn't coming. */
const START_MS = 45_000;
const POLL_MS = 2_000;

/** The set's state when the wait ended: done, failed, or failed for the wait. */
export async function shootAndWait(
  deps: ShotsWait,
  siteId: string,
  batchId: string,
  kind: 'before' | 'after',
): Promise<'done' | 'failed'> {
  const { db } = deps;
  const asked = deps.now();
  const id = requestSet(db, { siteId, batchId, kind, by: null }, asked);
  if (!id) return 'failed';
  deps.start();
  const cap = (deps.capMs ?? WAIT_MS)[kind];
  const giveUp = (problem: string): 'failed' => {
    db.prepare(
      `UPDATE screenshot_sets SET state = 'failed', problem = ?, finished_at = ?
       WHERE id = ? AND state IN ('waiting', 'running')`,
    ).run(problem, deps.now(), id);
    return 'failed';
  };
  for (;;) {
    const set = db.prepare('SELECT state FROM screenshot_sets WHERE id = ?').get(id);
    const state = String(set?.state ?? 'failed');
    if (state === 'done' || state === 'failed') return state;
    const waited = deps.now() - asked;
    if (state === 'waiting' && waited >= START_MS) {
      const beat = db.prepare('SELECT updated_at FROM state WHERE key = ?').get(HEARTBEAT);
      if (!beat || deps.now() - Number(beat.updated_at) >= START_MS)
        return giveUp('the screenshots process didn’t start');
    }
    if (waited >= cap)
      return giveUp(
        `it took longer than ${Math.round(cap / 60_000)} minutes, so the run went on without it`,
      );
    await deps.sleep(POLL_MS);
  }
}
