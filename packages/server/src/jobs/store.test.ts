import { describe, expect, it } from 'vitest';
import { testDb } from '../testing.js';
import { claim, enqueue, finish, getJob, interruptExpired, renew } from './store.js';

describe('job store', () => {
  it('keeps one pending job per dedupe key, and frees the key when it finishes', () => {
    const db = testDb();
    const first = enqueue(db, 1000, 'cycle', {}, { dedupeKey: 'cycle' });
    expect(first).toBeTruthy();
    expect(enqueue(db, 1001, 'cycle', {}, { dedupeKey: 'cycle' })).toBeNull();

    const job = claim(db, 1002, 'a', 60_000, ['cycle']);
    expect(job?.id).toBe(first);
    expect(enqueue(db, 1003, 'cycle', {}, { dedupeKey: 'cycle' })).toBeNull();

    finish(db, 1004, first!, 'a', { state: 'succeeded', result: {} });
    expect(enqueue(db, 1005, 'cycle', {}, { dedupeKey: 'cycle' })).toBeTruthy();
  });

  it('refuses a second enqueue with the same id', () => {
    const db = testDb();
    expect(enqueue(db, 1, 'update', {}, { id: 'job-1' })).toBe('job-1');
    expect(enqueue(db, 2, 'update', {}, { id: 'job-1' })).toBeNull();
  });

  it('claims a job only once, only when due, and only for the kinds asked', () => {
    const db = testDb();
    enqueue(db, 1000, 'cycle', {}, { runAfter: 2000 });
    enqueue(db, 1000, 'update', {});
    expect(claim(db, 1500, 'a', 60_000, ['cycle'])).toBeNull();
    const job = claim(db, 2000, 'a', 60_000, ['cycle']);
    expect(job).toMatchObject({
      kind: 'cycle',
      state: 'running',
      leaseOwner: 'a',
      leaseUntil: 62_000,
    });
    expect(claim(db, 2000, 'b', 60_000, ['cycle'])).toBeNull();
  });

  it('ignores finish and renew from a process that no longer holds the lease', () => {
    const db = testDb();
    const id = enqueue(db, 0, 'cycle')!;
    claim(db, 0, 'a', 1000, ['cycle']);
    expect(renew(db, id, 'b', 5000)).toBe(false);
    expect(finish(db, 10, id, 'b', { state: 'succeeded', result: {} })).toBe(false);
    expect(getJob(db, id)?.state).toBe('running');
  });

  it('marks expired leases interrupted and never hands them out again', () => {
    const db = testDb();
    const id = enqueue(db, 0, 'update')!;
    claim(db, 0, 'dead', 1000, ['update']);
    expect(interruptExpired(db, 999)).toEqual([]);
    expect(interruptExpired(db, 1001).map((j) => j.id)).toEqual([id]);
    expect(getJob(db, id)?.state).toBe('interrupted');
    expect(claim(db, 2000, 'b', 1000, ['update'])).toBeNull();
    // The stalled owner waking up can't overwrite the interruption.
    expect(finish(db, 2001, id, 'dead', { state: 'succeeded', result: {} })).toBe(false);
  });
});
