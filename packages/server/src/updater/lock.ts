// A process's one-at-a-time lock, in the state table: the pid of the run holding it, or 0 once
// that run has released it. The updater's is LOCK; the backups process has its own.
import type { Db } from '../db.js';
import { readState, writeState } from '../state.js';

export const LOCK = 'updater.process';

/**
 * Whether `pid` is a running process. Never for 0 or below: kill(0, 0) signals this process's own
 * group and kill(-n, 0) group n, so those would always look alive, and a released lock (pid 0)
 * would hold off every run after it.
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Takes the lock for `pid`, unless another live run holds it: then returns that run's pid. */
export function takeLock(db: Db, pid: number, now: number, name = LOCK): number | undefined {
  const held = readState<{ pid: number; at: number }>(db, name);
  if (held && held.pid > 0 && held.pid !== pid && alive(held.pid)) return held.pid;
  writeState(db, name, { pid, at: now }, now);
  return undefined;
}

export function releaseLock(db: Db, now: number, name = LOCK): void {
  writeState(db, name, { pid: 0, at: now }, now);
}
