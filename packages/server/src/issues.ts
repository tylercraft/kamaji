// Open problems. At most one open issue per resource and kind (a unique index): a problem that
// keeps happening updates the one issue, so it's noticed once and resolved once.
//
// Dismissed: Tyler hid an issue Kamaji can't check again (issueActions.ts). It stays hidden, and
// out of Discord, until something new happens: its fingerprint moves on (a new crash, a new
// version, a date that passes), it turns urgent, or it resolves and opens again as a new issue.
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { recordEvent } from './events.js';
import { dismissable, type IssueKind } from './issueActions.js';
import type { ResourceType } from './observations.js';

export type Severity = 'urgent' | 'normal';

export interface IssueKey {
  resourceType: ResourceType;
  resourceId: string;
  kind: string;
}

/** What raiseIssue takes: only a kind that has an action (issueActions.ts). */
export interface NewIssue extends IssueKey {
  kind: IssueKind;
  severity: Severity;
  summary: string;
  /**
   * What it's about right now, for kinds that can be dismissed: when it moves on, a dismissed
   * issue comes back. Left out, it only comes back by turning urgent or opening again.
   */
  fingerprint?: string;
}

export interface OpenIssue extends IssueKey {
  id: string;
  severity: Severity;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
  notifiedAt: number | null;
  dismissedAt: number | null;
  dismissedBy: string | null;
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
  dismissedAt:
    r.dismissed_at === null || r.dismissed_at === undefined ? null : Number(r.dismissed_at),
  dismissedBy:
    r.dismissed_by === null || r.dismissed_by === undefined ? null : String(r.dismissed_by),
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
 * last seen. A severity change to urgent clears notified_at, so it's announced as urgent. A
 * dismissed issue comes back, announced again, when it turns urgent or its fingerprint moves on.
 */
export function raiseIssue(
  db: Db,
  now: number,
  issue: NewIssue,
): { issue: OpenIssue; opened: boolean } {
  const fingerprint = issue.fingerprint ?? '';
  const open = findOpenIssue(db, issue);
  if (open) {
    const escalated = open.severity === 'normal' && issue.severity === 'urgent';
    const row = db.prepare('SELECT dismissed_fingerprint FROM issues WHERE id = ?').get(open.id);
    const back =
      open.dismissedAt !== null &&
      (escalated || String(row?.dismissed_fingerprint ?? '') !== fingerprint);
    db.prepare(
      `UPDATE issues SET severity = ?, summary = ?, last_seen_at = ?, fingerprint = ?,
       notified_at = CASE WHEN ? THEN NULL ELSE notified_at END,
       digested_at = CASE WHEN ? THEN NULL ELSE digested_at END,
       dismissed_at = CASE WHEN ? THEN NULL ELSE dismissed_at END,
       dismissed_by = CASE WHEN ? THEN NULL ELSE dismissed_by END,
       dismissed_fingerprint = CASE WHEN ? THEN NULL ELSE dismissed_fingerprint END
       WHERE id = ?`,
    ).run(
      issue.severity,
      issue.summary,
      now,
      fingerprint,
      escalated || back ? 1 : 0,
      back ? 1 : 0,
      back ? 1 : 0,
      back ? 1 : 0,
      back ? 1 : 0,
      open.id,
    );
    if (back) {
      recordEvent(db, now, {
        kind: 'issue.back',
        summary: `Back after it was dismissed: ${issue.summary}`,
        resourceType: issue.resourceType,
        resourceId: issue.resourceId,
        detail: { issue: open.id, kind: issue.kind, severity: issue.severity },
      });
    }
    return { issue: findOpenIssue(db, issue) as OpenIssue, opened: false };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO issues (id, resource_type, resource_id, kind, severity, summary, first_seen_at, last_seen_at, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    issue.resourceType,
    issue.resourceId,
    issue.kind,
    issue.severity,
    issue.summary,
    now,
    now,
    fingerprint,
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

/**
 * Dismiss: hides an open issue Kamaji can't check again, recording who and when, in Activity too.
 * One it can check again isn't dismissable: it clears by passing.
 */
export function dismissIssue(
  db: Db,
  now: number,
  id: string,
  by: string,
): 'dismissed' | 'not-found' | 'not-dismissable' {
  const row = db.prepare('SELECT * FROM issues WHERE id = ? AND resolved_at IS NULL').get(id);
  if (!row) return 'not-found';
  const issue = toIssue(row);
  if (!dismissable(issue)) return 'not-dismissable';
  if (issue.dismissedAt !== null) return 'dismissed';
  db.prepare(
    `UPDATE issues SET dismissed_at = ?, dismissed_by = ?, dismissed_fingerprint = fingerprint
     WHERE id = ?`,
  ).run(now, by, id);
  recordEvent(db, now, {
    kind: 'issue.dismissed',
    summary: `Dismissed by ${by}: ${issue.summary}`,
    resourceType: issue.resourceType,
    resourceId: issue.resourceId,
    detail: { issue: id, kind: issue.kind, by },
  });
  return 'dismissed';
}

/** Undo: the dismissed issue shows again. */
export function undismissIssue(db: Db, now: number, id: string, by: string): boolean {
  const row = db
    .prepare(
      'SELECT * FROM issues WHERE id = ? AND resolved_at IS NULL AND dismissed_at IS NOT NULL',
    )
    .get(id);
  if (!row) return false;
  const issue = toIssue(row);
  db.prepare(
    `UPDATE issues SET dismissed_at = NULL, dismissed_by = NULL, dismissed_fingerprint = NULL
     WHERE id = ?`,
  ).run(id);
  recordEvent(db, now, {
    kind: 'issue.undismissed',
    summary: `Shown again by ${by}: ${issue.summary}`,
    resourceType: issue.resourceType,
    resourceId: issue.resourceId,
    detail: { issue: id, kind: issue.kind, by },
  });
  return true;
}
