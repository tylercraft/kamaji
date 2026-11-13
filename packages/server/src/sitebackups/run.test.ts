import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { readState } from '../state.js';
import { testDb } from '../testing.js';
import { fakeRestic } from './fakeRestic.js';
import type { RestoreResult } from './restore.js';
import {
  backUpSite,
  dueSites,
  REPOSITORY,
  restoreDue,
  runBackups,
  type BackupsDeps,
} from './run.js';
import { DB, pullOf } from './testTar.js';

const DAY = 24 * 60 * 60_000;
// A Saturday in NZ and UTC alike: no upkeep unless a test asks.
const T = Date.UTC(2026, 10, 14, 3, 0);

function site(
  db: Db,
  id: string,
  options: { schedule?: string; own?: boolean; consent?: boolean; host?: string } = {},
) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule,
       site_backup_consent_at, site_backup_consent_by, expected_text, created_at)
     VALUES (?, ?, ?, ?, 'connected', 'done', ?, ?, ?, ?, 'Hello', 0)`,
  ).run(
    id,
    id,
    `https://${id}/`,
    options.host ?? 'craftish',
    options.own ? 1 : 0,
    options.schedule ?? 'weekly',
    options.consent === false ? null : 1,
    options.consent === false ? null : 'tylercraft@github',
  );
}

function snapshot(db: Db, siteId: string, at: number, id = 'a'.repeat(64)) {
  db.prepare(
    `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(siteId, at, at, id);
}

function deps(
  db: Db,
  pull: (site: string) => Buffer | { problem: string } = (s) => pullOf(s),
  now = T,
) {
  const fake = fakeRestic(pull);
  const restored: string[] = [];
  const result: { value: RestoreResult } = { value: { ok: true } };
  const d: BackupsDeps = {
    db,
    restic: fake.restic,
    restore: async (s) => {
      restored.push(s.id);
      return result.value;
    },
    pullCommand: (id) => ['/usr/bin/ssh', id],
    now: () => now,
    log: () => {},
  };
  return { d, ...fake, restored, result };
}

const rows = (db: Db, sql: string) => db.prepare(sql).all();

describe('which sites are due', () => {
  it('only sites on craftish, switched on, with the client’s agreement or Tyler’s own', () => {
    const db = testDb();
    site(db, 'never.test');
    site(db, 'week-old.test');
    snapshot(db, 'week-old.test', T - 7 * DAY);
    site(db, 'recent.test');
    snapshot(db, 'recent.test', T - 6 * DAY);
    site(db, 'fortnight.test', { schedule: 'fortnightly' });
    snapshot(db, 'fortnight.test', T - 10 * DAY);
    site(db, 'off.test', { schedule: 'off' });
    site(db, 'unagreed.test', { consent: false });
    site(db, 'own.test', { consent: false, own: true });
    site(db, 'kinsta.test', { host: 'kinsta' });
    expect(dueSites(db, T)).toEqual(['never.test', 'own.test', 'week-old.test']);
  });

  it('a restore check for the site checked longest ago, once a month, only with a snapshot', () => {
    const db = testDb();
    site(db, 'a.test');
    site(db, 'b.test');
    site(db, 'none.test');
    snapshot(db, 'a.test', T - DAY);
    snapshot(db, 'b.test', T - DAY);
    const check = (siteId: string, at: number) =>
      db
        .prepare(
          `INSERT INTO restore_checks (site_id, started_at, finished_at, ok) VALUES (?, ?, ?, 1)`,
        )
        .run(siteId, at, at);
    check('a.test', T - 40 * DAY);
    check('b.test', T - 35 * DAY);
    expect(restoreDue(db, T)).toBe('a.test');
    check('a.test', T - DAY);
    expect(restoreDue(db, T)).toBe('b.test');
    check('b.test', T - DAY);
    expect(restoreDue(db, T)).toBeNull();
  });
});

describe('backing up a site', () => {
  it('keeps a snapshot that reads back whole, then applies retention', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { d, calls, snapshots } = deps(db);
    // An older snapshot restic has already let go of.
    snapshot(db, 'one.test', T - 30 * DAY, 'f'.repeat(64));
    expect(await backUpSite(d, 'one.test')).toBe(true);
    expect(calls).toEqual(['backup one.test', 'keep one.test']);
    expect(snapshots.size).toBe(1);
    expect(
      rows(
        db,
        'SELECT ok, database_bytes, wordpress, forgotten_at FROM site_snapshots ORDER BY id',
      ),
    ).toEqual([
      { ok: 1, database_bytes: null, wordpress: null, forgotten_at: T },
      { ok: 1, database_bytes: DB.length, wordpress: '6.8.3', forgotten_at: null },
    ]);
    expect(rows(db, 'SELECT kind, summary FROM events')).toEqual([
      { kind: 'site.backup', summary: expect.stringMatching(/^Whole-site backup of one.test: /) },
    ]);
  });

  it('discards a snapshot that doesn’t match its manifest, and records why', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { d, calls, snapshots } = deps(db, () => pullOf('other.test'));
    expect(await backUpSite(d, 'one.test')).toBe(false);
    expect(calls).toEqual(['backup one.test', 'forget 1']);
    expect(snapshots.size).toBe(0);
    expect(rows(db, 'SELECT ok, snapshot_id, problem FROM site_snapshots')).toEqual([
      {
        ok: 0,
        snapshot_id: null,
        problem: 'the backup is of another site; the snapshot was discarded',
      },
    ]);
  });

  it('records craftish’s refusal', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { d } = deps(db, () => ({ problem: 'craftish: not on the allowlist' }));
    expect(await backUpSite(d, 'one.test')).toBe(false);
    expect(rows(db, 'SELECT summary FROM events')).toEqual([
      { summary: 'Whole-site backup of one.test failed: craftish: not on the allowlist' },
    ]);
  });
});

describe('a night’s run', () => {
  it('takes the panel’s requests first, skips what isn’t switched on, then what’s due', async () => {
    const db = testDb();
    site(db, 'asked.test');
    snapshot(db, 'asked.test', T - DAY);
    site(db, 'due.test');
    site(db, 'off.test', { schedule: 'off' });
    const ask = (siteId: string, kind: string) =>
      db
        .prepare(
          `INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by)
           VALUES (?, ?, ?, 'tylercraft@github')`,
        )
        .run(siteId, kind, T);
    ask('asked.test', 'backup');
    ask('asked.test', 'backup');
    ask('asked.test', 'restore');
    ask('off.test', 'backup');
    const { d, calls, restored } = deps(db);
    await runBackups(d);
    expect(calls).toEqual([
      'backup asked.test',
      'keep asked.test',
      'backup due.test',
      'keep due.test',
    ]);
    // The requested check stands in for the nightly one.
    expect(restored).toEqual(['asked.test']);
    expect(
      rows(db, 'SELECT COUNT(*) AS n FROM site_backup_requests WHERE taken_at IS NULL'),
    ).toEqual([{ n: 0 }]);
    expect(readState(db, REPOSITORY)).toEqual({ bytes: 4096, at: T });
  });

  it('records a failed restore check with its step, and prunes once on a Sunday', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', T - DAY);
    const sunday = T + DAY;
    const { d, calls, result } = deps(db, undefined, sunday);
    result.value = {
      ok: false,
      step: 'home page',
      problem: 'the test copy’s home page gave HTTP 500',
    };
    await runBackups(d);
    await runBackups(d);
    expect(calls.filter((c) => c === 'prune')).toEqual(['prune']);
    expect(rows(db, 'SELECT ok, failed_step, problem FROM restore_checks')).toEqual([
      { ok: 0, failed_step: 'home page', problem: 'the test copy’s home page gave HTTP 500' },
    ]);
  });
});
