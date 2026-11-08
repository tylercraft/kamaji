import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db.js';

describe('migrate', () => {
  it('applies every migration once', () => {
    const db = openDb(':memory:');
    expect(migrate(db).map((m) => m.version)).toEqual([1, 2, 3]);
    expect(migrate(db)).toEqual([]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['events', 'issues', 'jobs', 'servers', 'sites', 'state']),
    );
  });

  it('rolls back a migration that fails, leaving it unapplied', () => {
    const db = openDb(':memory:');
    const bad = [{ version: 1, name: 'bad', sql: 'CREATE TABLE a (x); CREATE TABLE a (x);' }];
    expect(() => migrate(db, bad)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(0);
  });
});
