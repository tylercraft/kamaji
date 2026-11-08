import { migrate, openDb, type Db } from './db.js';

/** A migrated in-memory database. */
export function testDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
