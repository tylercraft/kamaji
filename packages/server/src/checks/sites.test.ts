import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { findOpenIssue } from '../issues.js';
import { siteSummaries } from '../queries.js';
import { testDb } from '../testing.js';
import type { CertificateResult, HomePageResult } from './http.js';
import { checkSites, mapLimit, type SiteCheckers } from './sites.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9);

const up: HomePageResult = {
  ok: true,
  status: 200,
  responseMs: 300,
  finalUrl: 'https://a.test/',
  expectedText: true,
  phpError: false,
  problem: null,
  errorCode: null,
};
const down: HomePageResult = { ...up, ok: false, status: 503, problem: 'HTTP 503' };
const unreachable: HomePageResult = {
  ...up,
  ok: false,
  status: null,
  responseMs: null,
  problem: 'Connection refused',
  errorCode: 'ECONNREFUSED',
};
const cert = (daysLeft: number): CertificateResult => ({
  validTo: T0 + daysLeft * DAY,
  daysLeft,
  problem: null,
});

function addSite(db: Db, id: string, name = id) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, expected_text, created_at)
     VALUES (?, ?, ?, 'craftish', 'monitoring', 'done', 'Hello', ?)`,
  ).run(id, name, `https://${id}/`, T0);
}

/** Checkers that answer from a table, keyed by host. */
function fake(home: Record<string, HomePageResult>, certs: Record<string, CertificateResult> = {}) {
  const checkers: SiteCheckers = {
    homePage: async (url) => home[new URL(url).hostname] ?? up,
    certificate: async (host) => certs[host] ?? cert(60),
  };
  return checkers;
}

const signal = new AbortController().signal;
let clock = T0;
const run = (db: Db, checkers: SiteCheckers) =>
  checkSites(db, { now: () => (clock += 300_000), signal, checkers });

const events = (db: Db) =>
  db
    .prepare("SELECT kind, summary FROM events WHERE kind LIKE 'issue.%' ORDER BY id")
    .all()
    .map((r) => `${String(r.kind)}: ${String(r.summary)}`);

describe('checkSites', () => {
  it('opens one down issue after two failures, and resolves it on the next pass', async () => {
    const db = testDb();
    addSite(db, 'a.test', 'Alpha');
    addSite(db, 'b.test');
    addSite(db, 'c.test');

    await run(db, fake({ 'a.test': down }));
    expect(findOpenIssue(db, { resourceType: 'site', resourceId: 'a.test', kind: 'down' })).toBe(
      null,
    );
    expect(siteSummaries(db)[0]?.availability).toMatchObject({
      known: true,
      value: { state: 'failing', problem: 'HTTP 503' },
    });

    await run(db, fake({ 'a.test': down }));
    await run(db, fake({ 'a.test': unreachable }));
    expect(siteSummaries(db)[0]?.availability).toMatchObject({ value: { state: 'down' } });

    await run(db, fake({}));
    expect(siteSummaries(db)[0]?.availability).toMatchObject({ value: { state: 'up' } });
    expect(events(db)).toEqual([
      'issue.opened: Alpha is down: HTTP 503',
      'issue.resolved: Alpha is back up',
    ]);
  });

  it('blames the mini’s connection, not the sites, when every site fails at once', async () => {
    const db = testDb();
    for (const id of ['a.test', 'b.test', 'c.test']) addSite(db, id);
    const offline = fake({ 'a.test': unreachable, 'b.test': unreachable, 'c.test': unreachable });
    await run(db, offline);
    await run(db, offline);
    expect(siteSummaries(db).map((s) => s.availability.known)).toEqual([false, false, false]);
    await run(db, fake({}));
    expect(events(db)).toEqual([
      'issue.opened: The mini can’t reach any site: its connection looks down',
      'issue.resolved: The mini can reach sites again',
    ]);
  });

  it('warns about a certificate at 14 days, and makes it urgent at 7', async () => {
    const db = testDb();
    addSite(db, 'a.test', 'Alpha');
    const key = { resourceType: 'site', resourceId: 'a.test', kind: 'certificate' } as const;

    await run(db, fake({}, { 'a.test': cert(15) }));
    expect(findOpenIssue(db, key)).toBe(null);
    await run(db, fake({}, { 'a.test': cert(14) }));
    expect(findOpenIssue(db, key)).toMatchObject({ severity: 'normal' });
    await run(db, fake({}, { 'a.test': cert(7) }));
    expect(findOpenIssue(db, key)).toMatchObject({
      severity: 'urgent',
      summary: 'Alpha’s certificate expires in 7 days',
      notifiedAt: null,
    });
    await run(db, fake({}, { 'a.test': cert(90) }));
    expect(findOpenIssue(db, key)).toBe(null);
    expect(siteSummaries(db)[0]?.certificate).toMatchObject({
      known: true,
      value: { daysLeft: 90 },
    });
  });

  it('skips paused sites and says so', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    db.prepare('UPDATE sites SET paused_at = ?').run(T0);
    expect(await run(db, fake({}))).toBe(0);
    expect(siteSummaries(db)[0]?.availability).toEqual({
      known: false,
      reason: 'Paused: not being checked',
    });
  });
});

describe('the estate', () => {
  it('seeds fourteen monitoring-only sites, first check pending', () => {
    const sites = siteSummaries(testDb({ estate: true }));
    expect(sites).toHaveLength(14);
    expect(sites.every((s) => s.mode === 'monitoring' && s.expectedText)).toBe(true);
    expect(sites.filter((s) => s.tailnetOnly).map((s) => s.id)).toEqual([
      'accounting.firstandlastrecords.com',
      'accounting.prettyearpublishing.com',
    ]);
    expect(sites[0]?.availability).toEqual({ known: false, reason: 'First check pending' });
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit', async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });
});
