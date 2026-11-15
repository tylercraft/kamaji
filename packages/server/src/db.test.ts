import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db.js';
import { testDb } from './testing.js';

describe('migrate', () => {
  it('applies every migration once', () => {
    const db = openDb(':memory:');
    expect(migrate(db).map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
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
        'domains',
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

  it('makes every site so far WordPress, and takes only the three platforms', () => {
    const db = testDb({ seed: true });
    const platforms = db.prepare('SELECT DISTINCT platform FROM sites').all();
    expect(platforms).toEqual([{ platform: 'wordpress' }]);
    const set = (platform: string) =>
      db.prepare("UPDATE sites SET platform = ? WHERE id = 'craftish.dev'").run(platform);
    expect(() => set('static')).not.toThrow();
    expect(() => set('app')).not.toThrow();
    expect(() => set('drupal')).toThrow();
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
