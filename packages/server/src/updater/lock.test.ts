import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readState, writeState } from '../state.js';
import { testDb } from '../testing.js';
import { LOCK, releaseLock, takeLock } from './lock.js';

const held = (db: ReturnType<typeof testDb>) => readState<{ pid: number }>(db, LOCK)?.pid;

describe("the updater's lock", () => {
  it('runs after a released lock (pid 0)', () => {
    const db = testDb();
    releaseLock(db, 1);
    expect(takeLock(db, process.pid, 2)).toBeUndefined();
    expect(held(db)).toBe(process.pid);
  });

  it('runs after a run that died holding it', () => {
    const db = testDb();
    const { pid } = spawnSync('/usr/bin/true');
    expect(pid).toBeGreaterThan(0);
    writeState(db, LOCK, { pid, at: 1 }, 1);
    expect(takeLock(db, process.pid, 2)).toBeUndefined();
    expect(held(db)).toBe(process.pid);
  });

  it('runs with no lock yet', () => {
    const db = testDb();
    expect(takeLock(db, process.pid, 1)).toBeUndefined();
  });

  it('exits while another live run holds it', () => {
    const db = testDb();
    writeState(db, LOCK, { pid: process.ppid, at: 1 }, 1);
    expect(takeLock(db, process.pid, 2)).toBe(process.ppid);
    expect(held(db)).toBe(process.ppid);
  });
});
