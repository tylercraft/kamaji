import type { Db } from './db.js';

/** Reads a JSON value from the state table, or null when it was never written. */
export function readState<T>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? (JSON.parse(String(row.value)) as T) : null;
}

export function writeState(db: Db, key: string, value: unknown, at: number): void {
  db.prepare(
    `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), at);
}
