// Check results. Every one is kept (decided 2026-11-08); issues are worked out from them.
import type { Db } from './db.js';

export type ResourceType = 'site' | 'server' | 'kamaji';
export type Source = 'mini' | 'worker' | 'plugin' | 'ssh';

export interface Observation<V = unknown> {
  resourceType: ResourceType;
  resourceId: string;
  check: string;
  source: Source;
  at: number;
  ok: boolean;
  value: V;
}

export function recordObservation(db: Db, o: Observation): void {
  db.prepare(
    `INSERT INTO observations (resource_type, resource_id, check_name, source, at, ok, value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.resourceType,
    o.resourceId,
    o.check,
    o.source,
    o.at,
    o.ok ? 1 : 0,
    JSON.stringify(o.value),
  );
}

/** The newest observations of one check from one source, newest first. */
export function latestObservations<V>(
  db: Db,
  resourceType: ResourceType,
  resourceId: string,
  check: string,
  source: Source,
  limit: number,
): Observation<V>[] {
  return db
    .prepare(
      `SELECT * FROM observations
       WHERE resource_type = ? AND resource_id = ? AND check_name = ? AND source = ?
       ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(resourceType, resourceId, check, source, limit)
    .map((r) => ({
      resourceType: String(r.resource_type) as ResourceType,
      resourceId: String(r.resource_id),
      check: String(r.check_name),
      source: String(r.source) as Source,
      at: Number(r.at),
      ok: Number(r.ok) === 1,
      value: JSON.parse(String(r.value)) as V,
    }));
}
