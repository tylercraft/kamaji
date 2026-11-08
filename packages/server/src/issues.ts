// Open problems. At most one open issue per resource and kind (a unique index): a problem that
// keeps happening updates the one issue, so it's noticed once and resolved once.
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { recordEvent } from './events.js';
import type { ResourceType } from './observations.js';

export type Severity = 'urgent' | 'normal';

export interface IssueKey {
  resourceType: ResourceType;
  resourceId: string;
  kind: string;
}

export interface OpenIssue extends IssueKey {
  id: string;
  severity: Severity;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
  notifiedAt: number | null;
}

type Row = Record<string, unknown>;

const toIssue = (r: Row): OpenIssue => ({
  id: String(r.id),
  resourceType: String(r.resource_type) as ResourceType,
  resourceId: String(r.resource_id),
  kind: String(r.kind),
  severity: String(r.severity) as Severity,
  summary: String(r.summary),
  firstSeenAt: Number(r.first_seen_at),
  lastSeenAt: Number(r.last_seen_at),
  notifiedAt: r.notified_at === null ? null : Number(r.notified_at),
});

export function findOpenIssue(db: Db, key: IssueKey): OpenIssue | null {
  const row = db
    .prepare(
      `SELECT * FROM issues WHERE resource_type = ? AND resource_id = ? AND kind = ?
       AND resolved_at IS NULL`,
    )
    .get(key.resourceType, key.resourceId, key.kind);
  return row ? toIssue(row) : null;
}

/**
 * The problem is happening now. Opens the issue, or updates the open one's summary, severity and
 * last seen. A severity change to urgent clears notified_at, so it's announced as urgent.
 */
export function raiseIssue(
  db: Db,
  now: number,
  issue: IssueKey & { severity: Severity; summary: string },
): { issue: OpenIssue; opened: boolean } {
  const open = findOpenIssue(db, issue);
  if (open) {
    const escalated = open.severity === 'normal' && issue.severity === 'urgent';
    db.prepare(
      `UPDATE issues SET severity = ?, summary = ?, last_seen_at = ?,
       notified_at = CASE WHEN ? THEN NULL ELSE notified_at END WHERE id = ?`,
    ).run(issue.severity, issue.summary, now, escalated ? 1 : 0, open.id);
    return { issue: findOpenIssue(db, issue) as OpenIssue, opened: false };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO issues (id, resource_type, resource_id, kind, severity, summary, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    issue.resourceType,
    issue.resourceId,
    issue.kind,
    issue.severity,
    issue.summary,
    now,
    now,
  );
  recordEvent(db, now, {
    kind: 'issue.opened',
    summary: issue.summary,
    resourceType: issue.resourceType,
    resourceId: issue.resourceId,
    detail: { issue: id, kind: issue.kind, severity: issue.severity },
  });
  return { issue: findOpenIssue(db, issue) as OpenIssue, opened: true };
}

/** The problem has stopped. Returns the issue it resolved, or null if none was open. */
export function clearIssue(db: Db, now: number, key: IssueKey, summary: string): OpenIssue | null {
  const open = findOpenIssue(db, key);
  if (!open) return null;
  db.prepare('UPDATE issues SET resolved_at = ? WHERE id = ?').run(now, open.id);
  recordEvent(db, now, {
    kind: 'issue.resolved',
    summary,
    resourceType: key.resourceType,
    resourceId: key.resourceId,
    detail: { issue: open.id, kind: key.kind, openForMs: now - open.firstSeenAt },
  });
  return open;
}
