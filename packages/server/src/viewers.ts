// What's new for each viewer (Tyler, 2026-11-18): Kamaji remembers when each login last opened
// Overview, Sites and Updates, and counts what appeared on each since, for a dot on its tab and on
// the items themselves. Opening the page marks it seen. A login that has never opened a page has
// nothing new there: a first visit isn't a flood of dots.
import { offerKey, type NewsResponse, type SeenPage } from '@kamaji/shared';
import type { Db } from './db.js';
import { recentRuns } from './updates/announce.js';
import { queue } from './updates/queue.js';

/** The toast's reach: a run that finished longer ago than this isn't news. */
export const RUNS_WITHIN = 6 * 60 * 60_000;
const PAGES: SeenPage[] = ['overview', 'sites', 'updates'];
const iso = (ms: number) => new Date(ms).toISOString();

export function markSeen(db: Db, login: string, page: SeenPage, now: number): void {
  db.prepare(
    `INSERT INTO viewer_seen (login, page, seen_at) VALUES (?, ?, ?)
     ON CONFLICT (login, page) DO UPDATE SET seen_at = excluded.seen_at`,
  ).run(login, page, now);
}

export function seenAt(db: Db, login: string): Record<SeenPage, number | null> {
  const rows = new Map(
    db
      .prepare('SELECT page, seen_at FROM viewer_seen WHERE login = ?')
      .all(login)
      .map((r) => [String(r.page), Number(r.seen_at)] as const),
  );
  return Object.fromEntries(PAGES.map((p) => [p, rows.get(p) ?? null])) as Record<
    SeenPage,
    number | null
  >;
}

/** Overview: open issues (not dismissed) that started since. */
export function freshIssues(db: Db, since: number): string[] {
  return db
    .prepare(
      `SELECT id FROM issues
       WHERE resolved_at IS NULL AND dismissed_at IS NULL AND first_seen_at > ?`,
    )
    .all(since)
    .map((r) => String(r.id));
}

/** Sites: those added since, or with an issue that started since. */
export function freshSites(db: Db, since: number): string[] {
  return db
    .prepare(
      `SELECT s.id FROM sites s WHERE s.removed_at IS NULL AND (s.created_at > ?
         OR EXISTS (SELECT 1 FROM issues i WHERE i.resource_type = 'site' AND i.resource_id = s.id
           AND i.resolved_at IS NULL AND i.dismissed_at IS NULL AND i.first_seen_at > ?))`,
    )
    .all(since, since)
    .map((r) => String(r.id));
}

/** Updates: offers WordPress first made since, and runs that finished since. */
export function freshUpdates(db: Db, since: number): string[] {
  const offers = queue(db)
    .items.filter((i) => i.offerSeenAt && Date.parse(i.offerSeenAt) > since)
    .map(offerKey);
  const runs = db
    .prepare('SELECT id FROM batches WHERE finished_at > ?')
    .all(since)
    .map((r) => `run:${String(r.id)}`);
  return [...offers, ...runs];
}

export function news(db: Db, login: string, now: number): NewsResponse {
  const seen = seenAt(db, login);
  return {
    login,
    seen: {
      overview: seen.overview === null ? null : iso(seen.overview),
      sites: seen.sites === null ? null : iso(seen.sites),
      updates: seen.updates === null ? null : iso(seen.updates),
    },
    fresh: {
      overview: seen.overview === null ? [] : freshIssues(db, seen.overview),
      sites: seen.sites === null ? [] : freshSites(db, seen.sites),
      updates: seen.updates === null ? [] : freshUpdates(db, seen.updates),
    },
    runs: recentRuns(db, now, RUNS_WITHIN).map((r) => ({
      id: r.id,
      approvedBy: r.approvedBy,
      finishedAt: iso(r.finishedAt),
      lines: r.lines,
      anchor: r.anchor,
    })),
  };
}
