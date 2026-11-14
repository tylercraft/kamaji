import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db.js';
import { testDb } from './testing.js';

describe('migrate', () => {
  it('applies every migration once', () => {
    const db = openDb(':memory:');
    expect(migrate(db).map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect(migrate(db)).toEqual([]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'backup_evidence',
        'crash_groups',
        'crashes',
        'events',
        'issues',
        'jobs',
        'restore_checks',
        'server_updates',
        'servers',
        'site_backup_requests',
        'site_snapshots',
        'sites',
        'state',
      ]),
    );
  });

  it('marks Tyler’s own sites, and only those, in the estate', () => {
    const db = testDb({ seed: true });
    expect(
      db
        .prepare('SELECT id FROM sites WHERE own = 1 ORDER BY id')
        .all()
        .map((r) => r.id),
    ).toEqual([
      'accounting.firstandlastrecords.com',
      'accounting.prettyearpublishing.com',
      'firstandlastrecords.com',
      'yogarecords.com',
    ]);
  });

  it('rolls back a migration that fails, leaving it unapplied', () => {
    const db = openDb(':memory:');
    const bad = [{ version: 1, name: 'bad', sql: 'CREATE TABLE a (x); CREATE TABLE a (x);' }];
    expect(() => migrate(db, bad)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(0);
  });
});
