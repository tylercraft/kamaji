// End of security support for each site's PHP and database (calcifer explore/kamaji/plan.md,
// after M3): a line within 90 days of its end, or past it, is a digest issue naming the version
// and the date, never an urgent one. The list itself (list.ts) is a digest issue once it hasn't
// been checked in 6 months.
import type { EndOfLife } from '@kamaji/shared';
import type { Db } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { END_OF_LIFE } from './list.js';

const DAY = 86_400_000;
export const ENDING_WITHIN_DAYS = 90;
export const LIST_STALE_AFTER_DAYS = 183;

type List = {
  checked: string;
  php: Record<string, string>;
  mysql: Record<string, string>;
  mariadb: Record<string, string>;
};

const lineOf = (version: string) => /^(\d+)\.(\d+)/.exec(version)?.slice(1, 3).join('.') ?? null;

function judge(
  product: EndOfLife['product'],
  line: string | null,
  dates: Record<string, string>,
  now: number,
): EndOfLife {
  const endsOn = line === null ? null : (dates[line] ?? null);
  if (endsOn === null) return { product, line, endsOn, state: 'unknown' };
  // Supported through the whole of its last day.
  const end = Date.parse(`${endsOn}T00:00:00Z`) + DAY;
  const state =
    now >= end ? 'ended' : end - now <= ENDING_WITHIN_DAYS * DAY ? 'ending' : 'supported';
  return { product, line, endsOn, state };
}

export function phpEndOfLife(version: string, now: number, list: List = END_OF_LIFE): EndOfLife {
  return judge('PHP', lineOf(version), list.php, now);
}

/**
 * The database from WordPress's server string: MariaDB always names itself ("10.11.14-MariaDB-…",
 * older ones behind MySQL's "5.5.5-" replication prefix); anything else is read as MySQL,
 * Percona's "5.7.44-48" included.
 */
export function databaseEndOfLife(
  server: string,
  now: number,
  list: List = END_OF_LIFE,
): EndOfLife {
  if (/mariadb/i.test(server)) {
    return judge('MariaDB', lineOf(server.replace(/^5\.5\.5-/, '')), list.mariadb, now);
  }
  return judge('MySQL', lineOf(server), list.mysql, now);
}

function summary(site: string, e: EndOfLife): string {
  return e.state === 'ended'
    ? `${site}: ${e.product} ${e.line} has been past the end of security support since ${e.endsOn}`
    : `${site}: ${e.product} ${e.line} reaches the end of security support on ${e.endsOn}`;
}

/** The cycle's part: every connected site's last good report, and the list's own age. */
export function checkEndOfLife(db: Db, now: number, list: List = END_OF_LIFE): void {
  const sites = db
    .prepare(
      `SELECT s.id, s.name, o.value FROM sites s
       JOIN observations o ON o.id = (
         SELECT id FROM observations WHERE resource_type = 'site' AND resource_id = s.id
         AND check_name = 'report' AND source = 'plugin' AND ok = 1 ORDER BY at DESC, id DESC LIMIT 1)
       WHERE s.mode = 'connected' AND s.setup = 'done' AND s.removed_at IS NULL`,
    )
    .all();
  for (const row of sites) {
    const report = JSON.parse(String(row.value)) as { php: string; database: string };
    const site = String(row.name);
    for (const [kind, e] of [
      ['end-of-life:php', phpEndOfLife(report.php, now, list)],
      ['end-of-life:database', databaseEndOfLife(report.database, now, list)],
    ] as const) {
      const key = { resourceType: 'site', resourceId: String(row.id), kind } as const;
      if (e.state === 'ending' || e.state === 'ended') {
        raiseIssue(db, now, { ...key, severity: 'normal', summary: summary(site, e) });
      } else {
        clearIssue(
          db,
          now,
          key,
          e.state === 'supported'
            ? `${site}: ${e.product} ${e.line} is supported`
            : `${site}: ${e.product} ${e.line ?? ''} isn’t on Kamaji’s end-of-life list`,
        );
      }
    }
  }

  const key = { resourceType: 'kamaji', resourceId: 'end-of-life', kind: 'list-stale' } as const;
  const checked = Date.parse(`${list.checked}T00:00:00Z`);
  if (now - checked >= LIST_STALE_AFTER_DAYS * DAY) {
    raiseIssue(db, now, {
      ...key,
      severity: 'normal',
      summary: `Kamaji’s end-of-life list was last checked on ${list.checked}: recheck php.net and the vendors`,
    });
  } else {
    clearIssue(db, now, key, 'Kamaji’s end-of-life list is current again');
  }
}
