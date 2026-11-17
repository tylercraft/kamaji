import { readFileSync } from 'node:fs';
import { CareReport, NewsResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { storeReport } from './inventory/report.js';
import { raiseIssue } from './issues.js';
import { recordObservation } from './observations.js';
import { testDb } from './testing.js';
import { markSeen, news } from './viewers.js';

const T = Date.UTC(2026, 10, 18, 7, 0);
const MIN = 60_000;
const LOGIN = 'tylercraft@github';
const BASE = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('./inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);

function site(db: Db, id: string, createdAt = 0) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, ?, 'craftish', 'connected', 'done', ?)`,
  ).run(id, id, `https://${id}/`, createdAt);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: id,
    check: 'hello',
    source: 'plugin',
    at: 0,
    ok: true,
    value: {
      ok: true,
      hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
    },
  });
}

/** A report from `id` offering a test plugin `offer`. */
function report(db: Db, id: string, offer: string | null, at: number) {
  const r = structuredClone(BASE);
  r.plugins.push({
    file: 'kamaji-test/kamaji-test.php',
    slug: 'kamaji-test',
    name: 'Kamaji Test',
    version: '5.3',
    active: true,
    auto_update: false,
    offer: offer ? { version: offer, package: true } : null,
  });
  storeReport(db, { id, name: id }, r, at);
}

const down = (id: string) =>
  ({ resourceType: 'site', resourceId: id, kind: 'down', severity: 'urgent' }) as const;

describe('what’s new for a viewer', () => {
  it('nothing on a page never opened: a first visit isn’t a flood of dots', () => {
    const db = testDb();
    site(db, 'a.test', T);
    raiseIssue(db, T, { ...down('a.test'), summary: 'a.test is down' });
    expect(news(db, LOGIN, T).fresh).toEqual({ overview: [], sites: [], updates: [] });
  });

  it('Overview: issues that started since it was opened', () => {
    const db = testDb();
    site(db, 'a.test');
    site(db, 'b.test');
    raiseIssue(db, T - 10 * MIN, { ...down('a.test'), summary: 'a.test is down' });
    markSeen(db, LOGIN, 'overview', T);
    const fresh = raiseIssue(db, T + MIN, { ...down('b.test'), summary: 'b.test is down' });
    expect(news(db, LOGIN, T + 2 * MIN).fresh.overview).toEqual([fresh.issue.id]);
    markSeen(db, LOGIN, 'overview', T + 3 * MIN);
    expect(news(db, LOGIN, T + 4 * MIN).fresh.overview).toEqual([]);
  });

  it('Sites: sites added since, and sites with a problem since', () => {
    const db = testDb();
    site(db, 'old.test');
    site(db, 'troubled.test');
    markSeen(db, LOGIN, 'sites', T);
    site(db, 'added.test', T + MIN);
    raiseIssue(db, T + MIN, { ...down('troubled.test'), summary: 'troubled.test is down' });
    expect(news(db, LOGIN, T + 2 * MIN).fresh.sites.sort()).toEqual([
      'added.test',
      'troubled.test',
    ]);
  });

  it('Updates: offers first made since, and runs finished since; an offer seen again isn’t new', () => {
    const db = testDb();
    site(db, 'a.test');
    report(db, 'a.test', '5.3.1', T - 60 * MIN);
    markSeen(db, LOGIN, 'updates', T);
    // The same offer, reported again: not new.
    report(db, 'a.test', '5.3.1', T + MIN);
    expect(news(db, LOGIN, T + 2 * MIN).fresh.updates).toEqual([]);
    // A newer one: new.
    report(db, 'a.test', '5.3.2', T + 3 * MIN);
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, finished_at)
       VALUES ('b1', ?, ?, 0, 'finished', ?)`,
    ).run(T, LOGIN, T + 4 * MIN);
    expect(news(db, LOGIN, T + 5 * MIN).fresh.updates).toEqual([
      'offer:a.test:plugin:kamaji-test/kamaji-test.php',
      'run:b1',
    ]);
  });

  it('per login: one viewer opening a page doesn’t clear another’s', () => {
    const db = testDb();
    site(db, 'a.test');
    markSeen(db, LOGIN, 'overview', T);
    markSeen(db, 'someone@else', 'overview', T);
    const issue = raiseIssue(db, T + MIN, { ...down('a.test'), summary: 'a.test is down' });
    markSeen(db, 'someone@else', 'overview', T + 2 * MIN);
    expect(news(db, LOGIN, T + 3 * MIN).fresh.overview).toEqual([issue.issue.id]);
    expect(news(db, 'someone@else', T + 3 * MIN).fresh.overview).toEqual([]);
  });

  it('parses as the page reads it', () => {
    const db = testDb();
    expect(() => NewsResponse.parse(news(db, LOGIN, T))).not.toThrow();
  });
});
