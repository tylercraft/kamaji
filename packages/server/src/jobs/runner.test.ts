import { describe, expect, it } from 'vitest';
import { testDb } from '../testing.js';
import { Runner } from './runner.js';
import { claim, enqueue, getJob } from './store.js';

const events = (db: ReturnType<typeof testDb>) =>
  db
    .prepare('SELECT kind FROM events ORDER BY id')
    .all()
    .map((r) => r.kind);

describe('Runner', () => {
  it('runs a due job and records its result', async () => {
    const db = testDb();
    const id = enqueue(db, Date.now(), 'cycle')!;
    const runner = new Runner(db, { handlers: { cycle: async () => ({ checks: 0 }) } });
    expect(await runner.tick()).toBe(true);
    expect(getJob(db, id)?.state).toBe('succeeded');
    expect(db.prepare('SELECT result FROM jobs WHERE id = ?').get(id)?.result).toBe('{"checks":0}');
    expect(await runner.tick()).toBe(false);
  });

  it('records a failure with its message and an event', async () => {
    const db = testDb();
    const id = enqueue(db, Date.now(), 'cycle')!;
    const runner = new Runner(db, {
      handlers: {
        cycle: async () => {
          throw new Error('boom');
        },
      },
    });
    await runner.tick();
    expect(getJob(db, id)?.state).toBe('failed');
    expect(db.prepare('SELECT error FROM jobs WHERE id = ?').get(id)?.error).toBe('boom');
    expect(events(db)).toEqual(['job.failed']);
  });

  it('after a restart, marks a dead process’s job interrupted and does not rerun it', async () => {
    const db = testDb();
    let now = 0;
    const id = enqueue(db, now, 'update')!;
    claim(db, now, 'previous-process', 60_000, ['update']);

    let ran = 0;
    const runner = new Runner(db, {
      now: () => now,
      handlers: { update: async () => void ran++ },
    });
    now = 30_000;
    expect(await runner.tick()).toBe(false);
    expect(getJob(db, id)?.state).toBe('running');

    now = 60_001;
    expect(await runner.tick()).toBe(false);
    expect(getJob(db, id)?.state).toBe('interrupted');
    expect(ran).toBe(0);
    expect(events(db)).toEqual(['job.interrupted']);
  });

  it('aborts the running job on stop and marks it interrupted', async () => {
    const db = testDb();
    const id = enqueue(db, Date.now(), 'cycle')!;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const runner = new Runner(db, {
      pollMs: 5,
      handlers: {
        cycle: (_job, { signal }) =>
          new Promise((_resolve, reject) => {
            started();
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      },
    });
    runner.start();
    await begun;
    await runner.stop();
    expect(getJob(db, id)?.state).toBe('interrupted');
    expect(db.prepare('SELECT error FROM jobs WHERE id = ?').get(id)?.error).toBe('shutdown');
  });

  it('on stop, marks a job that ignores the signal interrupted without waiting for it', async () => {
    const db = testDb();
    const id = enqueue(db, Date.now(), 'cycle')!;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const runner = new Runner(db, {
      pollMs: 5,
      handlers: {
        // Like a check deaf to the signal: it settles long after a restart should be done.
        cycle: () => {
          started();
          return new Promise((resolve) => setTimeout(resolve, 60_000).unref());
        },
      },
    });
    runner.start();
    await begun;
    const before = Date.now();
    await runner.stop();
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(getJob(db, id)?.state).toBe('interrupted');
    expect(db.prepare('SELECT error FROM jobs WHERE id = ?').get(id)?.error).toBe('shutdown');
  });

  it('aborts a job whose lease was taken away', async () => {
    const db = testDb();
    const id = enqueue(db, Date.now(), 'cycle')!;
    const runner = new Runner(db, {
      leaseMs: 30,
      handlers: {
        cycle: (_job, { signal }) =>
          new Promise((_resolve, reject) => {
            db.prepare("UPDATE jobs SET lease_owner = 'someone-else' WHERE id = ?").run(id);
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      },
    });
    await runner.tick();
    // The other owner holds it now; this runner wrote nothing.
    expect(getJob(db, id)).toMatchObject({ state: 'running', leaseOwner: 'someone-else' });
  });
});
