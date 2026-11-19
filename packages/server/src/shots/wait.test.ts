import { describe, expect, it } from 'vitest';
import { writeState } from '../state.js';
import { testDb } from '../testing.js';
import { HEARTBEAT } from './sets.js';
import { batch, site, T } from './testShots.js';
import { shootAndWait, type ShotsWait } from './wait.js';

function setup(process: (db: ReturnType<typeof testDb>, now: number) => void = () => {}) {
  const db = testDb();
  site(db);
  batch(db);
  let now = T;
  const starts: number[] = [];
  const deps: ShotsWait = {
    db,
    start: () => starts.push(now),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      process(db, now);
    },
  };
  const set = () => db.prepare('SELECT kind, state, problem FROM screenshot_sets').get();
  return { db, deps, starts, set };
}

describe('the updater waiting for a set', () => {
  it('asks, starts the process, and returns once it’s done', async () => {
    const { deps, starts, set } = setup((db, now) => {
      writeState(db, HEARTBEAT, { pid: 1 }, now);
      if (now >= T + 10_000) db.prepare("UPDATE screenshot_sets SET state = 'done'").run();
    });
    expect(await shootAndWait(deps, 'one.test', 'b1', 'before')).toBe('done');
    expect(starts).toEqual([T]);
    expect(set()).toMatchObject({ kind: 'before', state: 'done' });
  });

  it('doesn’t wait for a process that never started', async () => {
    const { deps, set } = setup();
    expect(await shootAndWait(deps, 'one.test', 'b1', 'before')).toBe('failed');
    expect(set()).toMatchObject({
      state: 'failed',
      problem: 'the screenshots process didn’t start',
    });
    expect(deps.now() - T).toBeLessThan(60_000);
  });

  it('gives up at its cap, 4 minutes before and 3 after, and fails the set so it never lands late', async () => {
    const working = (db: ReturnType<typeof testDb>, now: number) =>
      writeState(db, HEARTBEAT, { pid: 1 }, now);
    for (const [kind, minutes] of [
      ['before', 4],
      ['after', 3],
    ] as const) {
      const { deps, set } = setup(working);
      expect(await shootAndWait(deps, 'one.test', 'b1', kind)).toBe('failed');
      expect(deps.now() - T).toBe(minutes * 60_000);
      expect(set()).toMatchObject({
        state: 'failed',
        problem: `it took longer than ${minutes} minutes, so the run went on without it`,
      });
    }
  });
});
