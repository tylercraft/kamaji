import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';
import { testDb } from '../testing.js';
import { announceRuns, recentRuns, runLines, unannounced } from './announce.js';
import { carryOn } from './batches.js';

const T = Date.UTC(2026, 10, 18, 7, 0);
const MIN = 60_000;

function site(db: Db, id: string, name: string) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, ?, 'craftish', 'connected', 'done', 0)`,
  ).run(id, name, `https://${id}/`);
}

/** A run of `sites`, each with its items, as the updater leaves it. */
function run(
  db: Db,
  id: string,
  sites: {
    id: string;
    state: 'done' | 'held';
    backupKind?: string;
    backup?: string | null;
    held?: string;
    items: { name: string; from: string; to: string; state?: string; outcome?: string | null }[];
  }[],
  finishedAt = T,
) {
  db.prepare(
    `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, finished_at)
     VALUES (?, ?, 'tylercraft@github', 0, 'finished', ?)`,
  ).run(id, finishedAt - 30 * MIN, finishedAt);
  sites.forEach((s, position) => {
    db.prepare(
      `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state,
         held_reason, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      s.id,
      position,
      s.backupKind ?? 'kamaji',
      s.backup === undefined
        ? 'Database export before update: Kamaji exported the database'
        : s.backup,
      s.state,
      s.held ?? null,
      finishedAt - MIN,
    );
    s.items.forEach((i, n) => {
      db.prepare(
        `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version,
           to_version, state, outcome)
         VALUES (?, ?, ?, ?, 'plugin', ?, ?, ?, ?, ?, ?)`,
      ).run(
        `${id}-${s.id}-${n}`,
        id,
        s.id,
        n,
        `${i.name}/${i.name}.php`,
        i.name,
        i.from,
        i.to,
        i.state ?? 'done',
        i.outcome === undefined ? 'passed' : i.outcome,
      );
    });
  });
}

function outbox(ok = true) {
  const sent: string[] = [];
  const discord: Discord = {
    configured: true,
    send: async (content) => {
      sent.push(content);
      return ok;
    },
  };
  return { sent, discord };
}

describe('a finished run, in words', () => {
  it('for Discord, counts instead of names', () => {
    const db = testDb();
    site(db, 'a.test', 'Aleya Hoerlein');
    site(db, 'p.test', 'Photogravure');
    run(db, 'b1', [
      {
        id: 'a.test',
        state: 'done',
        items: [{ name: 'Admin Menu Editor', from: '1.15.2', to: '1.15.3' }],
      },
      {
        id: 'p.test',
        state: 'held',
        held: 'Held: the checks failed after an update.',
        items: [
          { name: 'Yoast SEO', from: '25.1', to: '25.2' },
          { name: 'Akismet', from: '5.3', to: '5.3.1' },
          { name: 'WooCommerce', from: '9.9.1', to: '10.0.0', state: 'held', outcome: null },
        ],
      },
    ]);
    expect(runLines(db, 'b1')).toEqual([
      '✅ Updated Aleya Hoerlein: 1 update, checks passed (database export first)',
      '⚠️ **Needs you:** Photogravure is held: the checks failed after an update. Updated before the hold: 2 updates.',
    ]);
  });

  it('a site that went through: what changed, checks passed, which backup came first', () => {
    const db = testDb();
    site(db, 'aleyahoerlein.com', 'Aleya Hoerlein');
    run(db, 'b1', [
      {
        id: 'aleyahoerlein.com',
        state: 'done',
        items: [{ name: 'Admin Menu Editor', from: '1.15.2', to: '1.15.3' }],
      },
    ]);
    expect(runLines(db, 'b1', null, true)).toEqual([
      '✅ Updated Aleya Hoerlein: Admin Menu Editor 1.15.2 → 1.15.3, checks passed (database export first)',
    ]);
  });

  it('a held site leads with ⚠️ and the reason, marked as needing you; one line per site', () => {
    const db = testDb();
    site(db, 'a.test', 'Aleya Hoerlein');
    site(db, 'p.test', 'Photogravure');
    run(db, 'b1', [
      {
        id: 'a.test',
        state: 'done',
        backup: 'Whole-site backup before update: snapshot cccccccc, 184.0 MB, read back whole',
        items: [
          { name: 'Admin Menu Editor', from: '1.15.2', to: '1.15.3' },
          { name: 'Akismet', from: '5.3', to: '5.3.1' },
        ],
      },
      {
        id: 'p.test',
        state: 'held',
        backupKind: 'host',
        held: 'Held: the home page didn’t contain “Photogravure” after WooCommerce 10.0.0',
        items: [
          { name: 'Yoast SEO', from: '25.1', to: '25.2' },
          { name: 'WooCommerce', from: '9.9.1', to: '10.0.0', state: 'held', outcome: null },
        ],
      },
    ]);
    expect(runLines(db, 'b1', null, true)).toEqual([
      '✅ Updated Aleya Hoerlein: Admin Menu Editor 1.15.2 → 1.15.3, Akismet 5.3 → 5.3.1, checks passed (whole-site backup first)',
      '⚠️ **Needs you:** Photogravure is held: the home page didn’t contain “Photogravure” after WooCommerce 10.0.0. Updated before the hold: Yoast SEO 25.1 → 25.2.',
    ]);
  });

  it('each backup in a few words', () => {
    const db = testDb();
    for (const [id, kind, backup] of [
      ['host.test', 'host', 'Handled by the host'],
      ['client.test', 'client', 'Handled by the client'],
      ['tyler.test', 'tyler', 'Tyler confirmed'],
      ['carried.test', 'kamaji', 'Tyler carried on without fresh backup evidence, 2026-11-18'],
    ] as const) {
      site(db, id, id);
      run(db, `run-${id}`, [
        { id, state: 'done', backupKind: kind, backup, items: [{ name: 'X', from: '1', to: '2' }] },
      ]);
    }
    expect(
      ['host.test', 'client.test', 'tyler.test', 'carried.test'].map(
        (id) => /\((.+)\)$/.exec(runLines(db, `run-${id}`, null, true)[0]!)?.[1],
      ),
    ).toEqual([
      'the host’s backups',
      'the client’s backups',
      'your word there was a backup',
      'carried on without a fresh backup',
    ]);
  });
});

describe('telling Discord', () => {
  it('one message per run, once, with a link to it', async () => {
    const db = testDb();
    site(db, 'a.test', 'Aleya Hoerlein');
    site(db, 'p.test', 'Photogravure');
    const items = [{ name: 'Akismet', from: '5.3', to: '5.3.1' }];
    run(db, 'b1', [
      { id: 'a.test', state: 'done', items },
      { id: 'p.test', state: 'done', items },
    ]);
    run(db, 'b2', [{ id: 'p.test', state: 'done', items }], T + 10 * MIN);
    const { sent, discord } = outbox();
    expect(await announceRuns(db, T + 11 * MIN, discord, 'https://kamaji.test/')).toBe(2);
    expect(await announceRuns(db, T + 12 * MIN, discord, 'https://kamaji.test/')).toBe(0);
    expect(sent).toEqual([
      [
        '✅ Updated Aleya Hoerlein: 1 update, checks passed (database export first)',
        '✅ Updated Photogravure: 1 update, checks passed (database export first)',
        '<https://kamaji.test/updates#run-b1-a-test>',
      ].join('\n'),
      [
        '✅ Updated Photogravure: 1 update, checks passed (database export first)',
        '<https://kamaji.test/updates#run-b2-p-test>',
      ].join('\n'),
    ]);
  });

  it('a send Discord didn’t take is tried again next cycle', async () => {
    const db = testDb();
    site(db, 'a.test', 'A');
    run(db, 'b1', [{ id: 'a.test', state: 'done', items: [{ name: 'X', from: '1', to: '2' }] }]);
    await announceRuns(db, T, outbox(false).discord, 'https://k');
    const working = outbox();
    await announceRuns(db, T + 5 * MIN, working.discord, 'https://k');
    expect(working.sent).toHaveLength(1);
  });

  it('carried on after a hold: told again, about the site it finished', async () => {
    const db = testDb();
    site(db, 'a.test', 'Aleya Hoerlein');
    site(db, 'p.test', 'Photogravure');
    run(db, 'b1', [
      { id: 'a.test', state: 'done', items: [{ name: 'Akismet', from: '5.3', to: '5.3.1' }] },
      {
        id: 'p.test',
        state: 'held',
        held: 'Held: no backup evidence.',
        // Held before any backup was recorded, as a failed export leaves it.
        backup: null,
        items: [{ name: 'Akismet', from: '5.3', to: '5.3.1', state: 'held', outcome: null }],
      },
    ]);
    const { sent, discord } = outbox();
    await announceRuns(db, T, discord, 'https://k');
    expect(sent[0]).toContain('⚠️ **Needs you:** Photogravure is held: no backup evidence.');
    // Tyler carries on; the updater finishes the site and the run again.
    expect(carryOn(db, 'b1', 'p.test', 'tylercraft@github', T + 10 * MIN)).toBe(true);
    db.prepare(
      "UPDATE batch_sites SET state = 'done', finished_at = ? WHERE batch_id = 'b1' AND site_id = 'p.test'",
    ).run(T + 20 * MIN);
    db.prepare(
      "UPDATE batch_items SET state = 'done', outcome = 'passed' WHERE batch_id = 'b1' AND site_id = 'p.test'",
    ).run();
    expect(unannounced(db)).toEqual([]);
    db.prepare("UPDATE batches SET state = 'finished', finished_at = ? WHERE id = 'b1'").run(
      T + 21 * MIN,
    );
    await announceRuns(db, T + 22 * MIN, discord, 'https://k');
    expect(sent[1]?.split('\n')[0]).toBe(
      '✅ Updated Photogravure: 1 update, checks passed (carried on without a fresh backup)',
    );
    expect(sent[1]?.split('\n')).toHaveLength(2);
  });

  it('runs from before this are never announced', () => {
    const db = testDb();
    // Migration 24 marks finished runs as told; a run finished and told has nothing new.
    site(db, 'a.test', 'A');
    run(db, 'old', [{ id: 'a.test', state: 'done', items: [{ name: 'X', from: '1', to: '2' }] }]);
    db.prepare("UPDATE batches SET announced_at = finished_at WHERE id = 'old'").run();
    expect(unannounced(db)).toEqual([]);
    // The toast's list still has it, while it's recent.
    // …by name.
    expect(recentRuns(db, T + MIN, 6 * 60 * MIN)).toMatchObject([
      { id: 'old', lines: ['✅ Updated A: X 1 → 2, checks passed (database export first)'] },
    ]);
  });
});
