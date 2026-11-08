import { migrate, openDb, type Db } from './db.js';
import { migrations } from './migrations.js';

/** A migrated in-memory database, empty unless asked for the estate (migration 3's sites). */
export function testDb({ estate = false }: { estate?: boolean } = {}): Db {
  const db = openDb(':memory:');
  migrate(
    db,
    migrations.filter((m) => estate || m.name !== 'estate'),
  );
  return db;
}
