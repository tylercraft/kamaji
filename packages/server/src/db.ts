import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations as allMigrations, type Migration } from './migrations.js';

export type Db = DatabaseSync;

/** Opens (creating if needed) the database. Pass ':memory:' in tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE … COMMIT, rolling back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Applies any migrations not yet recorded. Returns the ones it applied. */
export function migrate(db: Db, migrations: Migration[] = allMigrations): Migration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row.version)),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));
  for (const m of pending) {
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
  }
  return pending;
}
