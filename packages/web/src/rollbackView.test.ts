import type { RollbackView } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import {
  ago,
  countsWords,
  inProgress,
  itemLine,
  latestWords,
  rollbackPollMs,
} from './rollbackView';

const latest = (over: Partial<RollbackView> = {}): RollbackView => ({
  id: 'r1',
  kind: 'rollback',
  state: 'done',
  requestedAt: '2026-11-21T03:00:00.000Z',
  requestedBy: 'tyler',
  finishedAt: '2026-11-21T03:02:00.000Z',
  withDatabase: false,
  databaseAt: null,
  step: 'done',
  problem: null,
  changed: 'all',
  counts: null,
  warnings: [],
  checksOk: true,
  checksProblem: null,
  items: [],
  ...over,
});

describe('the Rollback section’s words', () => {
  it('names what goes back, core from wordpress.org', () => {
    expect(itemLine({ type: 'plugin', name: 'Akismet', now: '5.3.1', back: '5.3' })).toBe(
      'Akismet 5.3 (now 5.3.1)',
    );
    expect(itemLine({ type: 'core', name: 'core', now: '7.1.5', back: '7.1.4' })).toBe(
      'WordPress 7.1.4 (now 7.1.5), from wordpress.org, checked against its checksums',
    );
  });

  it('says what the database lost, orders only on a shop', () => {
    expect(countsWords({ orders: 12, comments: 3, users: 1 })).toBe(
      '12 orders, 3 comments and 1 new user',
    );
    expect(countsWords({ orders: null, comments: 1, users: 0 })).toBe('1 comment and 0 new users');
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-11-21T03:00:00Z');
    expect(ago('2026-11-21T02:30:00Z', now)).toBe('under an hour ago');
    expect(ago('2026-11-20T22:00:00Z', now)).toBe('5 hours ago');
    expect(ago('2026-11-19T03:00:00Z', now)).toBe('2 days ago');
  });

  it('follows a rollback from asked to checked, polling quickly until then', () => {
    expect(
      latestWords(latest({ state: 'waiting', finishedAt: null, changed: null, checksOk: null }))
        .label,
    ).toBe('Rollback asked for');
    const pushed = latest({ checksOk: null });
    expect(latestWords(pushed)).toMatchObject({ label: 'Checking' });
    expect(inProgress(pushed)).toBe(true);
    expect(
      rollbackPollMs({ offer: null, why: null, latest: pushed, undo: null, undoWhy: null }),
    ).toBe(5_000);
    expect(
      latestWords(latest({ withDatabase: true, counts: { orders: 2, comments: 0, users: 0 } })),
    ).toEqual({
      tone: 'green',
      label: 'Rolled back',
      detail:
        'Checks passed. Put back with the database, losing 2 orders, 0 comments and 0 new users since then.',
    });
    expect(inProgress(latest())).toBe(false);
  });

  it('says plainly when it stopped, and whether anything changed', () => {
    expect(
      latestWords(
        latest({
          state: 'failed',
          changed: 'none',
          step: 'snapshot',
          problem: 'x',
          checksOk: null,
        }),
      ),
    ).toEqual({
      tone: 'amber',
      label: 'Rollback stopped',
      detail: 'Stopped at reading the restore point, with nothing changed: x.',
    });
    expect(
      latestWords(
        latest({
          state: 'failed',
          changed: 'partial',
          step: 'swap',
          problem: 'y',
          checksOk: false,
          checksProblem: 'home page: HTTP 500',
        }),
      ),
    ).toMatchObject({
      tone: 'red',
      label: 'Rollback stopped part way',
    });
    expect(latestWords(latest({ kind: 'undo' })).label).toBe('Rollback undone');
  });
});
