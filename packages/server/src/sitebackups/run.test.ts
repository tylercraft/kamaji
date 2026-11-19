import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { readState } from '../state.js';
import { testDb } from '../testing.js';
import { fakeRestic, kept } from './fakeRestic.js';
import type { RestoreResult } from './restore.js';
import {
  backUpSite,
  dueSites,
  REPOSITORY,
  requestsWaiting,
  restoreDue,
  runBackups,
  type BackupsDeps,
} from './run.js';
import { kinstaView, okSize, requestTest, type TestResult } from './kinsta.js';
import { DB, pullOf } from './testTar.js';

const DAY = 24 * 60 * 60_000;
// Saturday 14 November 2026, 03:15 in NZ: the run that does the night's restore check. The
// update time is Tuesday 19:00, so the backup night in force began Tuesday 10 November, 03:00.
const T = Date.UTC(2026, 10, 13, 14, 15);

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
  const restoredSnapshots: string[] = [];
  const result: { value: RestoreResult } = { value: { ok: true } };
  const tested: string[] = [];
  const rolled: string[] = [];
  const counted: string[] = [];
  const test: { value: TestResult } = {
    value: {
      ok: true,
      path: '/www/site_123/public',
      wordpress: '6.8.3',
      wpCli: '2.11.0',
      wpContentBytes: 2 * 1024 ** 3,
      databaseBytes: 50 * 1024 ** 2,
    },
  };
  const d: BackupsDeps = {
    db,
    restic: fake.restic,
    restore: async (s, snapshotId) => {
      restored.push(s.id);
      restoredSnapshots.push(snapshotId);
      return result.value;
    },
    pullCommand: (id, host) => ['/usr/bin/ssh', host, id],
    kinstaTest: async (id) => {
      tested.push(id);
      return test.value;
    },
    // As the push does: taken, so it isn't taken again.
    rollback: async (id) => {
      rolled.push(id);
      db.prepare("UPDATE rollbacks SET state = 'done' WHERE id = ?").run(id);
    },
    count: async (id) => {
      counted.push(id);
      db.prepare("UPDATE rollback_counts SET state = 'done' WHERE id = ?").run(id);
    },
    now: () => now,
    log: () => {},
  };
  return { d, ...fake, restored, restoredSnapshots, result, tested, test, rolled, counted };
}

const rows = (db: Db, sql: string) => db.prepare(sql).all();

describe('which sites are due', () => {
  it('only sites on craftish, switched on, with the client’s agreement or Tyler’s own, without a snapshot since their night', () => {
    const db = testDb();
    site(db, 'never.test');
    site(db, 'week-old.test');
    snapshot(db, 'week-old.test', T - 7 * DAY);
    site(db, 'recent.test');
    snapshot(db, 'recent.test', T - 3 * DAY);
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
    expect(rows(db, "SELECT summary FROM events WHERE kind = 'site.backup-failed'")).toEqual([
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
    // The asked-for check, and the scheduled backup's own; the asked-for one stands in for the
    // night's fallback.
    expect(restored).toEqual(['asked.test', 'due.test']);
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

  it('keeps a passed check’s note, for the site page', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', T - DAY);
    const { d, result } = deps(db);
    const note = 'checked on wordpress:7.1-apache (7.1.5 not on Docker Hub yet)';
    result.value = { ok: true, note };
    await runBackups(d);
    expect(rows(db, 'SELECT ok, note FROM restore_checks')).toEqual([{ ok: 1, note }]);
  });

  it('keeps a failed import’s last lines with the check, never in Activity', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', T - DAY);
    const { d, result } = deps(db);
    result.value = {
      ok: false,
      step: 'database',
      problem: 'database.sql didn’t import',
      detail: 'ERROR 1146 (42S02) at line 88: Table doesn’t exist',
    };
    await runBackups(d);
    expect(rows(db, 'SELECT problem, problem_detail FROM restore_checks')).toEqual([
      {
        problem: 'database.sql didn’t import',
        problem_detail: 'ERROR 1146 (42S02) at line 88: Table doesn’t exist',
      },
    ]);
    const said = rows(db, 'SELECT summary, detail FROM events').map((e) => JSON.stringify(e));
    expect(said.join('\n')).not.toContain('ERROR 1146');
  });
});

describe('hourly runs', () => {
  const HOUR = 60 * 60_000;
  // Tuesday 17 November 2026, 03:15 NZDT: a site in NZ's backup night, before the update time.
  const NIGHT = Date.UTC(2026, 10, 16, 14, 15);
  const at = (db: Db, now: number, pull?: (site: string) => Buffer | { problem: string }) => {
    const made = deps(db, pull, now);
    return { ...made, run: () => runBackups(made.d) };
  };

  it('backs a site up in its own night: a Los Angeles site waits for 03:00 there', async () => {
    const db = testDb();
    site(db, 'nz.test');
    site(db, 'la.test');
    db.prepare("UPDATE sites SET time_zone = 'America/Los_Angeles' WHERE id = 'la.test'").run();
    // Both backed up in last week's nights.
    snapshot(db, 'nz.test', NIGHT - 7 * DAY);
    snapshot(db, 'la.test', NIGHT - 7 * DAY - 3 * HOUR);
    // Monday 16 November, 03:00 in Los Angeles, is Tuesday 00:00 in NZ: it goes first.
    const la = Date.UTC(2026, 10, 16, 11, 15);
    expect(dueSites(db, la - HOUR)).toEqual([]);
    expect(dueSites(db, la)).toEqual(['la.test']);
    expect(dueSites(db, NIGHT)).toEqual(['la.test', 'nz.test']);
  });

  it('catches up a missed hour, then leaves the site until next week', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', NIGHT - 7 * DAY);
    // 03:15 never ran; 04:15 does.
    const late = at(db, NIGHT + HOUR);
    await late.run();
    expect(late.calls).toEqual(['backup one.test', 'keep one.test']);
    const next = at(db, NIGHT + 2 * HOUR);
    await next.run();
    expect(next.calls).toEqual([]);
    expect(dueSites(db, NIGHT + 6 * DAY)).toEqual([]);
    expect(dueSites(db, NIGHT + 7 * DAY)).toEqual(['one.test']);
  });

  it('tries a failing site three times in a night, then waits for the next', async () => {
    const db = testDb();
    site(db, 'one.test');
    const refused = () => ({ problem: 'craftish: not on the allowlist' });
    for (let h = 0; h < 5; h++) await at(db, NIGHT + h * HOUR, refused).run();
    expect(rows(db, 'SELECT ok FROM site_snapshots')).toEqual([{ ok: 0 }, { ok: 0 }, { ok: 0 }]);
    expect(dueSites(db, NIGHT + 7 * DAY)).toEqual(['one.test']);
  });

  it('leaves sites with backups off alone, whatever the hour', async () => {
    const db = testDb();
    site(db, 'off.test', { schedule: 'off' });
    for (let h = 0; h < 24; h++) expect(dueSites(db, NIGHT + h * HOUR)).toEqual([]);
  });

  it('does at most one restore check a night, in the 03:15 run', async () => {
    const db = testDb();
    site(db, 'a.test');
    site(db, 'b.test');
    snapshot(db, 'a.test', NIGHT - 30 * 60_000);
    snapshot(db, 'b.test', NIGHT - 30 * 60_000);
    const restored: string[] = [];
    // A whole day of hourly runs, from 00:15 NZ.
    for (let h = -3; h < 21; h++) {
      const run = at(db, NIGHT + h * HOUR);
      await run.run();
      restored.push(...run.restored);
    }
    expect(restored).toEqual(['a.test']);
    const tomorrow = at(db, NIGHT + DAY);
    await tomorrow.run();
    expect(tomorrow.restored).toEqual(['b.test']);
  });
});

describe('before an update', () => {
  it('records the batch with its snapshot, and takes it between the night’s sites', async () => {
    const db = testDb();
    site(db, 'a.test');
    site(db, 'b.test');
    site(db, 'updating.test');
    snapshot(db, 'updating.test', T - DAY);
    const { d, calls } = deps(db);
    // The updater asks while a.test is being backed up.
    const restic = d.restic;
    d.restic = {
      ...restic,
      backup: async (siteId, command, signal) => {
        if (siteId === 'a.test')
          db.prepare(
            `INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by, batch_id)
             VALUES ('updating.test', 'backup', ?, 'updater', 'batch-1')`,
          ).run(T);
        return restic.backup(siteId, command, signal);
      },
    };
    await runBackups(d);
    expect(calls.filter((c) => c.startsWith('backup '))).toEqual([
      'backup a.test',
      'backup updating.test',
      'backup b.test',
    ]);
    expect(
      rows(db, "SELECT batch_id FROM site_snapshots WHERE site_id = 'updating.test' AND ok = 1"),
    ).toEqual([{ batch_id: null }, { batch_id: 'batch-1' }]);
    expect(
      rows(
        db,
        "SELECT summary FROM events WHERE resource_id = 'updating.test' AND kind = 'site.backup'",
      ).map((e) => e.summary),
    ).toEqual([expect.stringMatching(/^Whole-site backup of updating.test before update: /)]);
  });
});

describe('a restore check after each scheduled backup', () => {
  const HOUR = 60 * 60_000;
  // Tuesday 17 November 2026, 04:15 NZDT: an hour after the night's own run, so not the 03:15
  // one that does the 30-day fallback.
  const LATE = Date.UTC(2026, 10, 16, 15, 15);

  it('checks each scheduled backup straight away, that snapshot, as many as there are', async () => {
    const db = testDb();
    site(db, 'a.test');
    site(db, 'b.test');
    const { d, restored, restoredSnapshots } = deps(db, undefined, LATE);
    await runBackups(d);
    expect(restored).toEqual(['a.test', 'b.test']);
    const made = rows(db, 'SELECT snapshot_id FROM site_snapshots WHERE ok = 1 ORDER BY id').map(
      (r) => String(r.snapshot_id),
    );
    expect(restoredSnapshots).toEqual(made);
    expect(rows(db, 'SELECT site_id, snapshot_id, ok FROM restore_checks ORDER BY id')).toEqual([
      { site_id: 'a.test', snapshot_id: made[0], ok: 1 },
      { site_id: 'b.test', snapshot_id: made[1], ok: 1 },
    ]);
  });

  it('Back up site now is checked straight after too, once the backups taken with it are done', async () => {
    const db = testDb();
    site(db, 'asked.test');
    site(db, 'updating.test');
    // Neither is due: both backed up since their night.
    snapshot(db, 'asked.test', LATE - HOUR);
    snapshot(db, 'updating.test', LATE - HOUR);
    const ask = db.prepare(
      `INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by, batch_id)
       VALUES (?, 'backup', ?, ?, ?)`,
    );
    ask.run('asked.test', LATE, 'tylercraft@github', null);
    ask.run('updating.test', LATE, 'updater', 'batch-1');
    const { d, calls, restored, restoredSnapshots } = deps(db, undefined, LATE);
    let order: string[] = [];
    const restore = d.restore;
    d.restore = async (s, id) => {
      order = [...calls];
      return restore(s, id);
    };
    await runBackups(d);
    // Only the panel's backup is checked, and after the updater's backup.
    expect(restored).toEqual(['asked.test']);
    expect(order.filter((c) => c.startsWith('backup '))).toEqual([
      'backup asked.test',
      'backup updating.test',
    ]);
    const made = rows(
      db,
      "SELECT snapshot_id FROM site_snapshots WHERE site_id = 'asked.test' ORDER BY id DESC LIMIT 1",
    )[0]!.snapshot_id;
    expect(restoredSnapshots).toEqual([made]);
  });

  it('a failed backup gets no check', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', LATE - 8 * 24 * HOUR);
    const { d, restored } = deps(db, () => ({ problem: 'craftish: not on the allowlist' }), LATE);
    await runBackups(d);
    expect(restored).toEqual([]);
  });

  it('a snapshot made before an update gets no check: the update shouldn’t wait', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', LATE - HOUR);
    db.prepare(
      `INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by, batch_id)
       VALUES ('one.test', 'backup', ?, 'updater', 'batch-1')`,
    ).run(LATE);
    const { d, calls, restored } = deps(db, undefined, LATE);
    await runBackups(d);
    expect(calls).toContain('backup one.test');
    expect(restored).toEqual([]);
  });

  it('a check that fails raises the usual issue', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { d, result } = deps(db, undefined, LATE);
    result.value = {
      ok: false,
      step: 'home page',
      problem: 'the test copy’s home page gave HTTP 500',
    };
    await runBackups(d);
    expect(
      rows(db, 'SELECT kind, severity, summary FROM issues WHERE resolved_at IS NULL'),
    ).toEqual([
      {
        kind: 'restore-check-failed',
        severity: 'urgent',
        summary:
          'one.test’s restore check failed at “home page”: the test copy’s home page gave HTTP 500',
      },
    ]);
  });
});

describe('retention keeps the rollback point', () => {
  // Wednesday 18 November 2026, before an update; then Thursday, the same ISO week.
  const WEDNESDAY = Date.UTC(2026, 10, 18, 6, 0);
  const THURSDAY = WEDNESDAY + DAY;

  function moving(db: Db) {
    const clock = { now: WEDNESDAY };
    const fake = fakeRestic(
      (s) => pullOf(s),
      () => clock.now,
    );
    const d: BackupsDeps = { ...deps(db).d, restic: fake.restic, now: () => clock.now };
    return { d, clock, fake };
  }

  it('a before-update snapshot and a manual one the next day: both kept', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { d, clock, fake } = moving(db);
    expect(await backUpSite(d, 'one.test', 'batch-1')).toBe(true);
    clock.now = THURSDAY;
    expect(await backUpSite(d, 'one.test')).toBe(true);
    expect(fake.snapshots.size).toBe(2);
    expect(
      rows(db, 'SELECT batch_id, forgotten_at FROM site_snapshots WHERE ok = 1 ORDER BY id'),
    ).toEqual([
      { batch_id: 'batch-1', forgotten_at: null },
      { batch_id: null, forgotten_at: null },
    ]);
  });

  it('weekly alone would have let the before-update one go', () => {
    const both = [
      { id: 'before-update', at: WEDNESDAY },
      { id: 'manual', at: THURSDAY },
    ];
    expect(kept(both, ['--keep-weekly', '4', '--keep-monthly', '6'])).toEqual(new Set(['manual']));
    expect(kept(both)).toEqual(new Set(['before-update', 'manual']));
  });

  it('after 14 days, the week’s newest is the one kept', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { d, clock, fake } = moving(db);
    await backUpSite(d, 'one.test', 'batch-1');
    clock.now = THURSDAY;
    await backUpSite(d, 'one.test');
    clock.now = THURSDAY + 15 * DAY;
    await backUpSite(d, 'one.test');
    expect(fake.snapshots.size).toBe(2);
    expect(
      rows(db, 'SELECT batch_id, forgotten_at FROM site_snapshots WHERE ok = 1 ORDER BY id'),
    ).toEqual([
      { batch_id: 'batch-1', forgotten_at: THURSDAY + 15 * DAY },
      { batch_id: null, forgotten_at: null },
      { batch_id: null, forgotten_at: null },
    ]);
  });
});

describe('Kinsta sites (pulled over SSH)', () => {
  function kinsta(db: Db, id: string, tested: { bytes?: number } | false = {}) {
    site(db, id, { host: 'kinsta' });
    db.prepare(
      `INSERT INTO kinsta_access (site_id, host, port, user, updated_at, updated_by)
       VALUES (?, '203.0.113.7', 12345, 'site', 0, 'tylercraft@github')`,
    ).run(id);
    if (tested)
      db.prepare(
        `UPDATE kinsta_access SET tested_at = 0, test_ok = 1, wordpress_path = '/www/site_1/public',
           wordpress = '6.8.3', wp_cli = '2.11.0', wp_content_bytes = ?, database_bytes = 0
         WHERE site_id = ?`,
      ).run(tested.bytes ?? 1024 ** 3, id);
  }

  it('due like craftish’s once their access is saved; pulled with Kinsta’s command, read back, restore-checked', async () => {
    const db = testDb();
    kinsta(db, 'photogravure.test');
    site(db, 'unset.test', { host: 'kinsta' });
    expect(dueSites(db, T)).toEqual(['photogravure.test']);
    const { d, commands, restored } = deps(db);
    await runBackups(d);
    expect(commands).toEqual([
      {
        site: 'photogravure.test',
        host: 'kinsta',
        command: ['/usr/bin/ssh', 'kinsta', 'photogravure.test'],
      },
    ]);
    expect(rows(db, 'SELECT site_id, ok FROM site_snapshots')).toEqual([
      { site_id: 'photogravure.test', ok: 1 },
    ]);
    expect(restored).toEqual(['photogravure.test']);
  });

  it('the first pull waits for a good test', async () => {
    const db = testDb();
    kinsta(db, 'untested.test', false);
    const { d, calls } = deps(db);
    await runBackups(d);
    expect(calls.filter((c) => c.startsWith('backup'))).toEqual([]);
    expect(rows(db, 'SELECT ok, problem FROM site_snapshots')).toEqual([
      { ok: 0, problem: 'Test connection first, under Configure → Backups' },
    ]);
  });

  it('over 20 GB, the first pull waits for Tyler’s okay; after it, the pull goes', async () => {
    const db = testDb();
    kinsta(db, 'photoseed.test', { bytes: 34 * 1024 ** 3 });
    const first = deps(db);
    await runBackups(first.d);
    expect(first.calls.filter((c) => c.startsWith('backup'))).toEqual([]);
    expect(rows(db, 'SELECT problem FROM site_snapshots')).toEqual([
      {
        problem: 'it measured 34.0 GB, over 20 GB: okay that size first, under Configure → Backups',
      },
    ]);
    expect(okSize(db, 'photoseed.test', 'tylercraft@github', T)).toBe('okayed');
    const second = deps(db, undefined, T + 60 * 60_000);
    await backUpSite(second.d, 'photoseed.test');
    expect(second.calls).toContain('backup photoseed.test');
  });

  it('once it has a snapshot, a failed test later doesn’t stop the pulls', async () => {
    const db = testDb();
    kinsta(db, 'p.test');
    snapshot(db, 'p.test', T - 8 * DAY);
    db.prepare("UPDATE kinsta_access SET test_ok = 0, test_problem = 'x'").run();
    const { d, calls } = deps(db);
    await backUpSite(d, 'p.test');
    expect(calls).toContain('backup p.test');
  });

  it('Test connection: taken first, recorded with what it found, and it starts the process', async () => {
    const db = testDb();
    kinsta(db, 'p.test', false);
    expect(requestTest(db, 'p.test', T)).toBe('queued');
    expect(requestTest(db, 'p.test', T)).toBe('already');
    expect(requestsWaiting(db)).toBe(true);
    const { d, tested } = deps(db, undefined, T + 60_000);
    // Tested before anything is pulled; this site's first pull then goes in the same run.
    await runBackups(d);
    expect(tested).toEqual(['p.test']);
    expect(requestsWaiting(db)).toBe(false);
    expect(kinstaView(db, 'p.test')).toMatchObject({
      testPending: null,
      test: { ok: true, path: '/www/site_123/public', wpContentBytes: 2 * 1024 ** 3 },
      blocked: null,
    });
    expect(
      rows(db, "SELECT summary FROM events WHERE kind = 'site.kinsta-test'").map((r) => r.summary),
    ).toEqual([
      'Kinsta connection to p.test works: WordPress 6.8.3 at /www/site_123/public, wp-content 2.0 GB, database 50 MB',
    ]);
  });
});

describe('rollbacks in the backups process', () => {
  it('wakes for one waiting, takes it before anything else, and marks one a stopped run left', async () => {
    const db = testDb();
    site(db, 'one.test');
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES ('b', 0, 'tyler', 0, 'finished')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by, with_database, state)
       VALUES (?, 'rollback', 'one.test', 'b', 'craftish', ?, 'tyler', 0, ?)`,
    );
    insert.run('left', 0, 'running');
    expect(requestsWaiting(db)).toBe(false);
    insert.run('asked', 1, 'waiting');
    expect(requestsWaiting(db)).toBe(true);
    const { d, rolled } = deps(db, () => pullOf('one.test'));
    await runBackups(d);
    expect(rolled).toEqual(['asked']);
    expect(db.prepare("SELECT state, changed FROM rollbacks WHERE id = 'left'").get()).toEqual({
      state: 'failed',
      changed: 'unknown',
    });
  });
});

describe('counts in the backups process', () => {
  it('wakes for one waiting and takes it first; one a stopped run left says so', async () => {
    const db = testDb();
    site(db, 'one.test');
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES ('b', 0, 'tyler', 0, 'finished')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO rollback_counts (id, site_id, batch_id, host, since, requested_at, state)
       VALUES (?, 'one.test', 'b', 'craftish', 0, ?, ?)`,
    );
    insert.run('left', 0, 'running');
    expect(requestsWaiting(db)).toBe(false);
    insert.run('asked', 1, 'waiting');
    expect(requestsWaiting(db)).toBe(true);
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by, with_database, state)
       VALUES ('r', 'rollback', 'one.test', 'b', 'craftish', 2, 'tyler', 0, 'waiting')`,
    ).run();
    const order: string[] = [];
    const { d } = deps(db, () => pullOf('one.test'));
    await runBackups({
      ...d,
      count: async (id) => {
        order.push(`count ${id}`);
        await d.count(id);
      },
      rollback: async (id) => {
        order.push(`rollback ${id}`);
        await d.rollback(id);
      },
    });
    expect(order).toEqual(['count asked', 'rollback r']);
    expect(
      db.prepare("SELECT state, problem FROM rollback_counts WHERE id = 'left'").get(),
    ).toEqual({
      state: 'failed',
      problem: 'the backups process stopped while it counted',
    });
  });
});
