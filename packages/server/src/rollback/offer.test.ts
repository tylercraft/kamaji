import { describe, expect, it } from 'vitest';
import { testDb } from '../testing.js';
import { rollbackOffer, siteBusy, undoOffer } from './offer.js';
import { requestRollback, requestUndo, siteRollback } from './request.js';
import {
  AKISMET,
  CORE,
  DAY,
  HOUR,
  installed,
  run,
  site,
  SNAPSHOT,
  T,
  THEME,
} from './testRollback.js';

const NOW = T + 2 * DAY;

/** A rollback that went through and was checked: the site as the rollback left it. */
function rolledBack(db: ReturnType<typeof testDb>, withDatabase = false) {
  const asked = requestRollback(db, 'one.test', { batchId: 'batch1', withDatabase }, 'tyler', NOW);
  if (!asked.ok) throw new Error(asked.why);
  db.prepare(
    `UPDATE rollbacks SET state = 'done', changed = 'all', finished_at = ?, checked_at = ?, checks_ok = 1
     WHERE id = ?`,
  ).run(NOW + 60_000, NOW + 120_000, asked.id);
  installed(db, 'one.test', 'plugin', AKISMET.item, AKISMET.from);
  installed(db, 'one.test', 'theme', THEME.item, THEME.from);
  return asked.id;
}

describe('what Roll back offers', () => {
  it('puts back what the latest run changed, from the snapshot it made first', () => {
    const db = testDb();
    site(db);
    run(db);
    const offer = rollbackOffer(db, 'one.test', NOW);
    expect(offer).toMatchObject({
      ok: true,
      host: 'craftish',
      batchId: 'batch1',
      restorePoint: { snapshotId: SNAPSHOT, exportTime: null, databaseAt: T - 10 * 60_000 },
      items: [
        { type: 'plugin', item: 'akismet/akismet.php', name: 'Akismet', now: '5.3.1', back: '5.3' },
        { type: 'theme', item: 'twentyx', name: 'Twenty X', now: '1.6.1', back: '1.6' },
      ],
      majorCore: false,
      prominent: false,
    });
  });

  it('uses the snapshot a run relied on, and on craftish the export taken just before', () => {
    const db = testDb();
    site(db);
    run(db, { snapshot: 'relied', exportAt: '20261119T025500Z' });
    expect(rollbackOffer(db, 'one.test', NOW)).toMatchObject({
      ok: true,
      restorePoint: {
        snapshotId: SNAPSHOT,
        snapshotAt: T - 5 * HOUR,
        exportTime: '20261119T025500Z',
        databaseAt: Date.UTC(2026, 10, 19, 2, 55),
      },
    });
    // Past craftish's 14 days, the export may be gone: the snapshot's dump instead.
    const later = rollbackOffer(db, 'one.test', T + 13.5 * DAY);
    expect(later).toMatchObject({
      ok: true,
      restorePoint: { exportTime: null, databaseAt: T - 5 * HOUR },
    });
  });

  it('isn’t offered without SSH, or on Kinsta untested', () => {
    const db = testDb();
    site(db, 'wpe.test', 'wpengine');
    expect(rollbackOffer(db, 'wpe.test', NOW)).toEqual({
      ok: false,
      why: 'Rollback needs SSH, which Kamaji has only on craftish and Kinsta. This host’s own backups are the way back',
    });
    site(db, 'k.test', 'kinsta');
    db.prepare('UPDATE kinsta_access SET test_ok = 0').run();
    expect(rollbackOffer(db, 'k.test', NOW)).toMatchObject({
      ok: false,
      why: expect.stringContaining('tested first'),
    });
  });

  it('needs a whole-site backup from before the run, still kept', () => {
    for (const [snapshot, why] of [
      ['none', 'No whole-site backup came before this run'],
      ['old', 'No whole-site backup came before this run'],
      ['forgotten', 'has been pruned'],
    ] as const) {
      const db = testDb();
      site(db);
      run(db, { snapshot });
      expect(rollbackOffer(db, 'one.test', NOW)).toMatchObject({
        ok: false,
        why: expect.stringContaining(why),
      });
    }
  });

  it('only while the site is the way the run left it', () => {
    const db = testDb();
    site(db);
    run(db);
    installed(db, 'one.test', 'plugin', AKISMET.item, '5.3.2');
    expect(rollbackOffer(db, 'one.test', NOW)).toEqual({
      ok: false,
      why: 'Since this run, Akismet went from 5.3.1 to 5.3.2 outside Kamaji, so the site isn’t the way the run left it',
    });
  });

  it('leaves out what didn’t go in, and passes over a run that changed nothing', () => {
    const db = testDb();
    site(db);
    run(db, { id: 'old', at: T - DAY, items: [THEME] });
    run(db, {
      id: 'new',
      at: T,
      items: [{ ...AKISMET, outcome: 'update_failed' }],
      snapshot: 'none',
    });
    expect(rollbackOffer(db, 'one.test', NOW)).toMatchObject({
      ok: true,
      batchId: 'old',
      items: [{ name: 'Twenty X' }],
    });
  });

  it('is prominent for a run held or carried on past a failure; says when core goes back a major', () => {
    const db = testDb();
    site(db);
    run(db, {
      items: [
        { ...CORE, from: '7.0.3', to: '7.1.5' },
        { ...AKISMET, outcome: 'checks_failed' },
      ],
    });
    expect(rollbackOffer(db, 'one.test', NOW)).toMatchObject({
      ok: true,
      prominent: true,
      majorCore: true,
    });
  });

  it('only the latest run not rolled back: after one, the run before; after its undo, it again', () => {
    const db = testDb();
    site(db);
    run(db, { id: 'batch0', at: T - DAY, items: [{ ...AKISMET, from: '5.2', to: '5.3' }] });
    run(db, { id: 'batch1', at: T });
    expect(rollbackOffer(db, 'one.test', NOW)).toMatchObject({ ok: true, batchId: 'batch1' });
    const id = rolledBack(db);
    expect(rollbackOffer(db, 'one.test', NOW + DAY)).toMatchObject({
      ok: true,
      batchId: 'batch0',
      items: [{ now: '5.3', back: '5.2' }],
    });
    const undo = requestUndo(
      db,
      'one.test',
      { rollbackId: id, withDatabase: false },
      'tyler',
      NOW + DAY,
    );
    expect(undo.ok).toBe(true);
    db.prepare(
      `UPDATE rollbacks SET state = 'done', changed = 'all', finished_at = ?, checked_at = ? WHERE kind = 'undo'`,
    ).run(NOW + DAY, NOW + DAY);
    installed(db, 'one.test', 'plugin', AKISMET.item, AKISMET.to);
    installed(db, 'one.test', 'theme', THEME.item, THEME.to);
    expect(rollbackOffer(db, 'one.test', NOW + 2 * DAY)).toMatchObject({
      ok: true,
      batchId: 'batch1',
    });
  });

  it('after a rollback, names the run before when it can’t be rolled back, not “this run”', () => {
    const db = testDb();
    site(db);
    // 15 Nov in Christchurch, with no whole-site backup before it.
    run(db, {
      id: 'batch0',
      at: T - 4 * DAY,
      items: [{ ...THEME, from: '1.5', to: '1.6' }],
      snapshot: 'none',
    });
    run(db, { id: 'batch1', at: T, items: [AKISMET] });
    expect(rollbackOffer(db, 'one.test', NOW)).toMatchObject({ ok: true, batchId: 'batch1' });
    rolledBack(db);
    installed(db, 'one.test', 'theme', THEME.item, '1.6');
    expect(rollbackOffer(db, 'one.test', NOW + DAY)).toEqual({
      ok: false,
      why: 'The run on 15 Nov can’t be rolled back: no whole-site backup came before it',
    });
    // The same for a site that's moved on since that run.
    installed(db, 'one.test', 'theme', THEME.item, '1.6.2');
    expect(rollbackOffer(db, 'one.test', NOW + DAY)).toEqual({
      ok: false,
      why: 'The run on 15 Nov can’t be rolled back: Twenty X went from 1.6 to 1.6.2 outside Kamaji since',
    });
    // The latest run's own reasons still say “this run”.
    const fresh = testDb();
    site(fresh);
    run(fresh, { snapshot: 'none' });
    expect(rollbackOffer(fresh, 'one.test', NOW)).toEqual({
      ok: false,
      why: 'No whole-site backup came before this run, so Kamaji has no files to put back',
    });
  });
});

describe('one thing at a time', () => {
  it('waits for a run, a backup request, a rollback, and a rollback’s checks', () => {
    const db = testDb();
    site(db);
    run(db, { id: 'done1' });
    expect(siteBusy(db, 'one.test')).toBeNull();
    run(db, { id: 'going', state: 'running', snapshot: 'none' });
    expect(siteBusy(db, 'one.test')).toBe('An update run is waiting or running for this site');
    db.prepare("UPDATE batch_sites SET state = 'done' WHERE batch_id = 'going'").run();
    db.prepare(
      "INSERT INTO site_backup_requests (site_id, kind, requested_at, requested_by) VALUES ('one.test', 'backup', 0, 'tyler')",
    ).run();
    expect(siteBusy(db, 'one.test')).toBe('A backup or restore check is waiting for this site');
    db.prepare('UPDATE site_backup_requests SET taken_at = 1').run();
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by, with_database, state)
       VALUES ('r1', 'rollback', 'one.test', 'done1', 'craftish', 0, 'tyler', 0, 'running')`,
    ).run();
    expect(siteBusy(db, 'one.test')).toBe('A rollback is already waiting or running for this site');
    expect(siteBusy(db, 'one.test', 'r1')).toBeNull();
    db.prepare("UPDATE rollbacks SET state = 'done', changed = 'all'").run();
    expect(siteBusy(db, 'one.test')).toBe('The last rollback’s checks are still running');
    db.prepare('UPDATE rollbacks SET checked_at = 1').run();
    expect(siteBusy(db, 'one.test')).toBeNull();
  });
});

describe('asking for a rollback', () => {
  it('records what it will do, as offered, and refuses a stale or missing offer', () => {
    const db = testDb();
    site(db);
    run(db, { snapshot: 'relied', exportAt: '20261119T025500Z' });
    expect(
      requestRollback(db, 'one.test', { batchId: 'other', withDatabase: false }, 'tyler', NOW),
    ).toMatchObject({
      ok: false,
      error: 'stale',
    });
    const asked = requestRollback(
      db,
      'one.test',
      { batchId: 'batch1', withDatabase: true },
      'tyler',
      NOW,
    );
    expect(asked.ok).toBe(true);
    expect(
      db
        .prepare(
          'SELECT kind, state, with_database, snapshot_id, export_time, database_at FROM rollbacks',
        )
        .get(),
    ).toEqual({
      kind: 'rollback',
      state: 'waiting',
      with_database: 1,
      snapshot_id: SNAPSHOT,
      export_time: '20261119T025500Z',
      database_at: Date.UTC(2026, 10, 19, 2, 55),
    });
    expect(
      db
        .prepare(
          'SELECT type, item, now_version, back_version FROM rollback_items ORDER BY position',
        )
        .all(),
    ).toEqual([
      { type: 'plugin', item: 'akismet/akismet.php', now_version: '5.3.1', back_version: '5.3' },
      { type: 'theme', item: 'twentyx', now_version: '1.6.1', back_version: '1.6' },
    ]);
    // A second while the first waits.
    expect(
      requestRollback(db, 'one.test', { batchId: 'batch1', withDatabase: false }, 'tyler', NOW),
    ).toMatchObject({
      ok: false,
      error: 'not_offered',
      why: 'A rollback is already waiting or running for this site',
    });
  });
});

describe('undo', () => {
  it('is offered once the rollback is checked, with the database only if it put the database back', () => {
    const db = testDb();
    site(db);
    run(db);
    const id = rolledBack(db, true);
    expect(undoOffer(db, 'one.test', NOW + DAY)).toMatchObject({
      ok: true,
      rollbackId: id,
      canDatabase: true,
    });
    const asked = requestUndo(
      db,
      'one.test',
      { rollbackId: id, withDatabase: true },
      'tyler',
      NOW + DAY,
    );
    expect(asked.ok).toBe(true);
    // It puts the rollback's items back the other way round.
    expect(
      db
        .prepare(
          'SELECT now_version, back_version FROM rollback_items WHERE rollback_id = ? ORDER BY position',
        )
        .all(asked.ok ? asked.id : ''),
    ).toEqual([
      { now_version: '5.3', back_version: '5.3.1' },
      { now_version: '1.6', back_version: '1.6.1' },
    ]);
  });

  it('only while nothing has changed since: no newer run, versions as left, within 14 days', () => {
    const db = testDb();
    site(db);
    run(db);
    const id = rolledBack(db);
    installed(db, 'one.test', 'theme', THEME.item, '1.6.2');
    expect(undoOffer(db, 'one.test', NOW + DAY)).toMatchObject({
      ok: false,
      why: expect.stringContaining('Twenty X went from 1.6 to 1.6.2'),
    });
    installed(db, 'one.test', 'theme', THEME.item, THEME.from);
    expect(undoOffer(db, 'one.test', NOW + 15 * DAY)).toMatchObject({
      ok: false,
      why: expect.stringContaining('over 14 days'),
    });
    run(db, { id: 'later', at: NOW + 2 * DAY, items: [], snapshot: 'none' });
    expect(undoOffer(db, 'one.test', NOW + 3 * DAY)).toEqual({
      ok: false,
      why: 'An update run since the rollback has changed the site',
    });
    expect(
      requestUndo(db, 'one.test', { rollbackId: id, withDatabase: false }, 'tyler', NOW + 3 * DAY)
        .ok,
    ).toBe(false);
  });

  it('refuses the database when the rollback didn’t put it back', () => {
    const db = testDb();
    site(db);
    run(db);
    const id = rolledBack(db, false);
    expect(
      requestUndo(db, 'one.test', { rollbackId: id, withDatabase: true }, 'tyler', NOW + DAY),
    ).toMatchObject({
      ok: false,
      why: 'That rollback didn’t put the database back',
    });
  });
});

describe('the site page’s view', () => {
  it('says what Roll back would do, or why not, and the latest with its undo', () => {
    const db = testDb();
    site(db);
    run(db, { snapshot: 'relied', exportAt: '20261119T025500Z' });
    const before = siteRollback(db, 'one.test', NOW);
    expect(before).toMatchObject({
      offer: {
        batchId: 'batch1',
        databaseFrom: 'export',
        items: [{ name: 'Akismet', now: '5.3.1', back: '5.3' }, {}],
      },
      why: null,
      latest: null,
      undo: null,
    });
    rolledBack(db);
    const after = siteRollback(db, 'one.test', NOW + DAY);
    expect(after.offer).toBeNull();
    expect(after.why).toBe('Nothing its update runs changed is left to put back');
    expect(after.latest).toMatchObject({
      kind: 'rollback',
      state: 'done',
      changed: 'all',
      checksOk: true,
    });
    expect(after.undo).toMatchObject({ canDatabase: false });
  });
});
