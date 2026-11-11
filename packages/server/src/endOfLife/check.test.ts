import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { recordObservation } from '../observations.js';
import { testDb } from '../testing.js';
import { checkEndOfLife, databaseEndOfLife, phpEndOfLife } from './check.js';
import { END_OF_LIFE } from './list.js';

const NOW = Date.parse('2026-11-11T09:00:00Z');
const DAY = 86_400_000;

const openIssues = (db: Db) =>
  db
    .prepare(
      `SELECT resource_id, kind, severity, summary FROM issues WHERE resolved_at IS NULL
       ORDER BY resource_id, kind`,
    )
    .all()
    .map((r) => ({ ...r }));

function site(db: Db, php: string, database: string, at = NOW) {
  db.prepare(
    `INSERT OR IGNORE INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES ('minton.test', 'Minton test', 'https://minton.test/', 'other', 'connected', 'done', 0)`,
  ).run();
  recordObservation(db, {
    resourceType: 'site',
    resourceId: 'minton.test',
    check: 'report',
    source: 'plugin',
    at,
    ok: true,
    value: { ok: true, php, database },
  });
}

describe('release lines', () => {
  it('reads PHP by major and minor, as php.net lists it', () => {
    expect(phpEndOfLife('8.2.35', NOW)).toEqual({
      product: 'PHP',
      line: '8.2',
      endsOn: '2026-12-31',
      state: 'ending',
    });
    expect(phpEndOfLife('8.3.6', NOW).state).toBe('supported');
    expect(phpEndOfLife('8.1.31', NOW).state).toBe('ended');
    expect(phpEndOfLife('9.0.0', NOW)).toEqual({
      product: 'PHP',
      line: '9.0',
      endsOn: null,
      state: 'unknown',
    });
  });

  it('reads the database from the server strings the pilot reports', () => {
    expect(databaseEndOfLife('5.7.44-48', NOW)).toEqual({
      product: 'MySQL',
      line: '5.7',
      endsOn: '2023-10-25',
      state: 'ended',
    });
    expect(databaseEndOfLife('10.11.14-MariaDB-0ubuntu0.24.04.1', NOW)).toMatchObject({
      product: 'MariaDB',
      line: '10.11',
      state: 'supported',
    });
    expect(databaseEndOfLife('11.4.12-MariaDB-ubu2404', NOW).state).toBe('supported');
    // Older MariaDB behind MySQL's replication prefix.
    expect(databaseEndOfLife('5.5.5-10.6.12-MariaDB', NOW)).toMatchObject({
      line: '10.6',
      state: 'ended',
    });
    // Not on the list yet: unknown, never supported.
    expect(databaseEndOfLife('8.4.3', NOW).state).toBe('unknown');
    expect(databaseEndOfLife('', NOW)).toMatchObject({ line: null, state: 'unknown' });
  });

  it('counts the last day as supported, and 90 days before it as ending', () => {
    const lastDay = Date.parse('2026-12-31T23:59:59Z');
    expect(phpEndOfLife('8.2.0', lastDay).state).toBe('ending');
    expect(phpEndOfLife('8.2.0', lastDay + 1000).state).toBe('ended');
    const end = Date.parse('2027-01-01T00:00:00Z');
    expect(phpEndOfLife('8.2.0', end - 90 * DAY).state).toBe('ending');
    expect(phpEndOfLife('8.2.0', end - 90 * DAY - 1).state).toBe('supported');
  });
});

describe('the cycle', () => {
  it('raises digest issues for Minton’s PHP 8.2 and MySQL 5.7 straight away, and resolves them', () => {
    const db = testDb();
    site(db, '8.2.35', '5.7.44-48');
    checkEndOfLife(db, NOW);
    expect(openIssues(db)).toEqual([
      {
        resource_id: 'minton.test',
        kind: 'end-of-life:database',
        severity: 'normal',
        summary:
          'Minton test: MySQL 5.7 has been past the end of security support since 2023-10-25',
      },
      {
        resource_id: 'minton.test',
        kind: 'end-of-life:php',
        severity: 'normal',
        summary: 'Minton test: PHP 8.2 reaches the end of security support on 2026-12-31',
      },
    ]);

    site(db, '8.3.14', '10.11.14-MariaDB', NOW + DAY);
    checkEndOfLife(db, NOW + DAY);
    expect(openIssues(db)).toEqual([]);
  });

  it('raises one of its own when the list hasn’t been checked in 6 months', () => {
    const db = testDb();
    checkEndOfLife(db, NOW);
    expect(openIssues(db)).toEqual([]);
    const later = Date.parse(`${END_OF_LIFE.checked}T00:00:00Z`) + 183 * DAY;
    checkEndOfLife(db, later);
    expect(openIssues(db)).toEqual([
      {
        resource_id: 'end-of-life',
        kind: 'list-stale',
        severity: 'normal',
        summary: `Kamaji’s end-of-life list was last checked on ${END_OF_LIFE.checked}: recheck php.net and the vendors`,
      },
    ]);
  });
});
