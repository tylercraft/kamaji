import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { findOpenIssue } from '../issues.js';
import { siteSummaries } from '../queries.js';
import { testDb } from '../testing.js';
import { readOutside, STALE_MS, syncOutside, workerFresh } from './outside.js';

const T0 = Date.UTC(2026, 10, 9);
const MIN = 60_000;
const STALE = { resourceType: 'kamaji', resourceId: 'worker', kind: 'stale' } as const;

function addSite(db: Db, id: string, tailnetOnly = false) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, expected_text, tailnet_only, created_at)
     VALUES (?, ?, ?, 'craftish', 'monitoring', 'done', 'Hello', ?, ?)`,
  ).run(id, id, `https://${id}/`, tailnetOnly ? 1 : 0, T0);
}

/** A fake Worker: records what Kamaji sends, answers with `results`. */
function fakeWorker(results: () => unknown, up = () => true) {
  const calls: { method: string; path: string; auth: string | null; body?: unknown }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!up()) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      auth: new Headers(init?.headers).get('Authorization'),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const body = method === 'PUT' ? { sites: 1 } : results();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, client: { url: 'https://watch.test', token: 'tok', fetch: fake } };
}

const signal = new AbortController().signal;
const entry = (t: number, ok = true) => ({
  t,
  ok,
  status: ok ? 200 : 503,
  ms: 100,
  problem: ok ? null : 'HTTP 503',
});

describe('syncOutside', () => {
  it('sends public sites once, and records each result once', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    addSite(db, 'private.test', true);
    let checkedAt = T0;
    const history = [entry(T0 - 5 * MIN), entry(T0, false)];
    const worker = fakeWorker(() => ({ checkedAt, results: { 'a.test': { history } } }));

    await syncOutside(db, worker.client, { now: () => T0, signal });
    checkedAt = T0 + 5 * MIN;
    history.push(entry(T0 + 5 * MIN));
    await syncOutside(db, worker.client, { now: () => T0 + 5 * MIN, signal });

    expect(worker.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /v1/sites',
      'GET /v1/results',
      'GET /v1/results',
    ]);
    expect(worker.calls[0]?.auth).toBe('Bearer tok');
    expect(worker.calls[0]?.body).toEqual([
      { id: 'a.test', name: 'a.test', url: 'https://a.test/', expectedText: 'Hello' },
    ]);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE source = 'worker'").get();
    expect(Number(rows?.n)).toBe(3);
    expect(siteSummaries(db, true)[0]?.outside).toMatchObject({ known: true, value: { ok: true } });
    expect(workerFresh(readOutside(db), T0 + 5 * MIN)).toBe(true);
  });

  it('raises an urgent issue when the Worker stops running passes, and clears it', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    let checkedAt = T0;
    const worker = fakeWorker(() => ({ checkedAt, results: {} }));
    await syncOutside(db, worker.client, { now: () => T0, signal });
    await syncOutside(db, worker.client, { now: () => T0 + STALE_MS, signal });
    expect(findOpenIssue(db, STALE)).toMatchObject({ severity: 'urgent' });
    checkedAt = T0 + STALE_MS + MIN;
    await syncOutside(db, worker.client, { now: () => T0 + STALE_MS + 2 * MIN, signal });
    expect(findOpenIssue(db, STALE)).toBe(null);
  });

  it('gives a new Worker the same grace, then says it can’t reach it', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    const worker = fakeWorker(
      () => ({}),
      () => false,
    );
    await syncOutside(db, worker.client, { now: () => T0, signal });
    await syncOutside(db, worker.client, { now: () => T0 + 10 * MIN, signal });
    expect(findOpenIssue(db, STALE)).toBe(null);
    await syncOutside(db, worker.client, { now: () => T0 + STALE_MS, signal });
    expect(findOpenIssue(db, STALE)?.summary).toContain('can’t reach');
  });

  it('says why a site has no outside result', () => {
    const db = testDb();
    addSite(db, 'a.test');
    addSite(db, 'private.test', true);
    expect(siteSummaries(db, false).map((s) => s.outside)).toEqual([
      { known: false, reason: 'Outside checks aren’t set up' },
      { known: false, reason: 'Tailnet only: not visible from outside' },
    ]);
  });
});
