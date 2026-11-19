import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';
import { testDb } from '../testing.js';
import { announceRollbacks, recentRollbacks, rollbackLine } from './announce.js';
import { requestRollback } from './request.js';
import { DAY, run, site, T } from './testRollback.js';

const NOW = T + 2 * DAY;

function rollback(db: Db, set: Record<string, unknown>, withDatabase = false) {
  const asked = requestRollback(db, 'one.test', { batchId: 'batch1', withDatabase }, 'tyler', NOW);
  if (!asked.ok) throw new Error(asked.why);
  const fields = { state: 'done', finished_at: NOW + 60_000, checked_at: NOW + 120_000, ...set };
  db.prepare(
    `UPDATE rollbacks SET ${Object.keys(fields)
      .map((k) => `${k} = ?`)
      .join(', ')} WHERE id = ?`,
  ).run(...(Object.values(fields) as (string | number | null)[]), asked.id);
  return db.prepare('SELECT * FROM rollbacks WHERE id = ?').get(asked.id)!;
}

function fresh() {
  const db = testDb();
  site(db);
  run(db, { snapshot: 'relied', exportAt: '20261119T025500Z' });
  return db;
}

describe('a rollback in words', () => {
  it('Discord gets the site and a count, never a component; the toast, the names', () => {
    const db = fresh();
    const r = rollback(db, { changed: 'all', checks_ok: 1 });
    expect(rollbackLine(db, r, false)).toBe(
      '↩️ Rolled back **One**: 2 updates put back, files only, checks passed',
    );
    expect(rollbackLine(db, r, true)).toBe(
      '↩️ Rolled back One: Akismet 5.3.1 → 5.3, Twenty X 1.6.1 → 1.6 put back, files only, checks passed',
    );
  });

  it('names the database’s age, and says when the checks failed', () => {
    const db = fresh();
    const r = rollback(
      db,
      { changed: 'all', checks_ok: 0, checks_problem: 'home page: HTTP 500' },
      true,
    );
    expect(rollbackLine(db, r, false)).toBe(
      '⚠️ **Needs you:** One was rolled back (2 updates, with the database from 2 days ago), but its checks failed',
    );
    expect(rollbackLine(db, r, true)).toContain('but its checks failed: home page: HTTP 500');
  });

  it('says what was left when it stopped', () => {
    const db = fresh();
    expect(
      rollbackLine(
        db,
        rollback(db, { state: 'failed', changed: 'none', step: 'swap', problem: 'x' }),
        false,
      ),
    ).toBe('⚠️ The rollback of **One** stopped at the swap: nothing was changed');
    const db2 = fresh();
    expect(
      rollbackLine(
        db2,
        rollback(db2, { state: 'failed', changed: 'files', step: 'database', checks_ok: 1 }, true),
        false,
      ),
    ).toBe(
      '⚠️ **Needs you:** One was rolled back (2 updates), but its database couldn’t be put back; it’s as it was',
    );
    const db3 = fresh();
    expect(
      rollbackLine(
        db3,
        rollback(db3, { state: 'failed', changed: 'partial', step: 'swap', problem: 'x' }),
        false,
      ),
    ).toBe('⚠️ **Needs you:** the rollback of One stopped at the swap and left it part way');
  });
});

describe('telling', () => {
  const discord = (ok = true) => {
    const sent: string[] = [];
    const d = {
      configured: true,
      send: async (m: string) => {
        sent.push(m);
        return ok;
      },
    } as unknown as Discord;
    return { d, sent };
  };

  it('sends each checked rollback once, with a link to the site; not one that stopped before changing anything', async () => {
    const db = fresh();
    rollback(db, { changed: 'all', checks_ok: 1 });
    const { d, sent } = discord();
    expect(await announceRollbacks(db, d, 'https://kamaji.test/')).toBe(1);
    expect(sent).toEqual([
      '↩️ Rolled back **One**: 2 updates put back, files only, checks passed\n<https://kamaji.test/sites/one.test#updates>',
    ]);
    expect(await announceRollbacks(db, d, 'https://kamaji.test/')).toBe(0);

    const quiet = fresh();
    rollback(quiet, { state: 'failed', changed: 'none', step: 'check', problem: 'x' });
    const q = discord();
    expect(await announceRollbacks(quiet, q.d, 'https://kamaji.test')).toBe(1);
    expect(q.sent).toEqual([]);
  });

  it('tries again when Discord doesn’t take it, and toasts whoever asked', async () => {
    const db = fresh();
    rollback(db, { changed: 'all', checks_ok: 1 });
    const { d } = discord(false);
    expect(await announceRollbacks(db, d, 'https://kamaji.test')).toBe(0);
    expect(recentRollbacks(db, NOW + 5 * 60_000, 30 * 60_000)).toEqual([
      expect.objectContaining({
        approvedBy: 'tyler',
        href: '/sites/one.test#updates',
        lines: [expect.stringContaining('Akismet 5.3.1 → 5.3')],
      }),
    ]);
  });
});
