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
  const d: BackupsDeps = {
    db,
    restic: fake.restic,
    restore: async (s, snapshotId) => {
      restored.push(s.id);
      restoredSnapshots.push(snapshotId);
      return result.value;
    },
    pullCommand: (id) => ['/usr/bin/ssh', id],
    now: () => now,
    log: () => {},
  };
  return { d, ...fake, restored, restoredSnapshots, result };
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
