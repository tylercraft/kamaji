import type { Db } from './db.js';

export interface NewEvent {
  kind: string;
  summary: string;
  resourceType?: string;
  resourceId?: string;
  /** Kept with the event, never shown in Discord. No secrets. */
  detail?: Record<string, unknown>;
}

/** Appends to the activity log. */
export function recordEvent(db: Db, at: number, event: NewEvent): void {
  db.prepare(
    'INSERT INTO events (at, kind, summary, resource_type, resource_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    at,
    event.kind,
    event.summary,
    event.resourceType ?? null,
    event.resourceId ?? null,
    JSON.stringify(event.detail ?? {}),
  );
}
