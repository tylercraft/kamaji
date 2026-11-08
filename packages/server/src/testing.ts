import { migrate, openDb, type Db } from './db.js';
import { migrations } from './migrations.js';

/** A migrated in-memory database, empty unless asked for the seeds (the estate and servers). */
export function testDb({ seed = false }: { seed?: boolean } = {}): Db {
  const db = openDb(':memory:');
  migrate(
    db,
    migrations.filter((m) => seed || !m.seed),
  );
  return db;
}
