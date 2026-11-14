// Proposed batches (TY-151): only what's in the queue, never an approval, stale once the queue
// moves on; and the one write a caller without the page's Origin may make.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CareReport, ProposeResponse, UpdatesResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { storeReport } from '../inventory/report.js';
import { recordObservation } from '../observations.js';
import { testDb } from '../testing.js';
import { queue } from './queue.js';

const T = Date.UTC(2026, 10, 14, 0, 0);
const LOGIN = 'tylercraft@github';
const REPORT = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('../inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);

/** Two connected sites, each offering the fixture's Akismet update. */
function queued() {
  const db = testDb();
  for (const [id, name] of [
    ['a.test', 'Alpha'],
    ['b.test', 'Bravo'],
  ] as const) {
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES (?, ?, ?, 'craftish', 'connected', 'done', ?)`,
    ).run(id, name, `https://${id}/`, T);
    recordObservation(db, {
      resourceType: 'site',
      resourceId: id,
      check: 'hello',
      source: 'plugin',
      at: T,
      ok: true,
      value: {
        ok: true,
        hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
      },
    });
    storeReport(db, { id, name }, REPORT, T);
  }
  return db;
}

function app(db = queued()) {
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Kamaji</title>');
  let at = T + 60_000;
  const a = createApp({
    db,
    login: LOGIN,
    webDist,
    now: () => at,
    statusInput: () => ({
      version: '0.1.0',
      commit: 'abc1234',
      startedAt: 0,
      now: at,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    a.request(path, {
      method: 'POST',
      headers: { 'Tailscale-User-Login': LOGIN, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const updates = async () =>
    UpdatesResponse.parse(
      await (
        await a.request('/api/updates', { headers: { 'Tailscale-User-Login': LOGIN } })
      ).json(),
    );
  return { db, post, updates, later: (ms: number) => (at += ms) };
}

const pick = (db: ReturnType<typeof queued>, note = '') =>
  queue(db).items.map(({ siteId, type, item, from, to }) => ({
    siteId,
    type,
    item,
    from,
    to,
    note,
  }));

describe('proposing a batch', () => {
  it('saves items from the current queue with their notes, and Updates shows it ticked', async () => {
    const { db, post, updates } = app();
    const items = pick(db, 'Routine; no known vulnerabilities');
    expect(items).toHaveLength(2);
    const res = await post('/api/proposals', { items, firstSite: 'b.test' });
    expect(res.status).toBe(201);
    expect(ProposeResponse.parse(await res.json())).toMatchObject({ ok: true });

    const { proposal } = await updates();
    expect(proposal).toMatchObject({ by: 'Calcifer', firstSite: 'b.test', stale: false });
    expect(proposal!.items).toEqual(items);
  });

  it('approves, starts and changes nothing else', async () => {
    const { db, post } = app();
    const count = (table: string) =>
      Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
    const before = ['batches', 'batch_items', 'jobs', 'components'].map(count);
    await post('/api/proposals', { items: pick(db) });
    expect(['batches', 'batch_items', 'jobs', 'components'].map(count)).toEqual(before);
    expect(count('proposals')).toBe(1);
    expect(db.prepare("SELECT kind FROM events WHERE kind LIKE 'batch.%'").all()).toEqual([
      { kind: 'batch.proposed' },
    ]);
  });

  it('refuses anything not in the current queue, a repeat, or a first site with nothing in it', async () => {
    const { db, post } = app();
    const [one] = pick(db);
    const wrong = { ...one!, to: '9.9.9' };
    const res = await post('/api/proposals', {
      items: [one, one, wrong],
      firstSite: 'elsewhere.test',
    });
    expect(res.status).toBe(409);
    const body = ProposeResponse.parse(await res.json());
    expect(body.ok).toBe(false);
    expect(!body.ok && body.problems).toEqual([
      `a.test akismet/akismet.php ${one!.from} → ${one!.to} is listed twice`,
      `a.test akismet/akismet.php ${one!.from} → 9.9.9 isn’t in the current queue`,
      'the first site, elsewhere.test, has none of the proposed updates',
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n).toBe(0);
  });

  it('refuses a malformed request or an overlong note', async () => {
    const { db, post } = app();
    expect((await post('/api/proposals', { items: [] })).status).toBe(400);
    expect((await post('/api/proposals', { items: pick(db, 'x'.repeat(201)) })).status).toBe(400);
  });

  it('goes stale when the queue changes, and away once a batch is approved after it', async () => {
    const { db, post, updates, later } = app();
    await post('/api/proposals', { items: pick(db).slice(0, 1) });
    expect((await updates()).proposal?.stale).toBe(false);

    db.prepare("UPDATE components SET offer_version = '5.8.0' WHERE site_id = 'b.test'").run();
    expect((await updates()).proposal?.stale).toBe(true);

    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state)
       VALUES ('x', ?, ?, 0, 'approved')`,
    ).run(later(60_000), LOGIN);
    expect((await updates()).proposal).toBeNull();
  });
});

describe('who may propose', () => {
  it('lets a caller with no Origin propose, and do no other write', async () => {
    const { db, post } = app();
    expect((await post('/api/proposals', { items: pick(db) })).status).toBe(201);
    const approve = {
      items: queue(db).items.map(({ siteId, type, item, from, to }) => ({
        siteId,
        type,
        item,
        from,
        to,
      })),
      confirmedBackups: [],
      oneSiteFirst: false,
    };
    expect((await post('/api/batches', approve)).status).toBe(403);
    expect((await post('/api/sites/a.test/mode', { mode: 'monitoring' })).status).toBe(403);
    expect((await post('/api/proposals/', { items: pick(db) })).status).toBe(403);
  });

  it('refuses a proposal from a foreign Origin or without the login', async () => {
    const { db, post } = app();
    const items = pick(db);
    const foreign = { Origin: 'https://evil.example', Host: 'molcajete.tailb3044a.ts.net' };
    expect((await post('/api/proposals', { items }, foreign)).status).toBe(403);
    expect((await post('/api/proposals', { items }, { Origin: 'null' })).status).toBe(403);
    expect(
      (await post('/api/proposals', { items }, { 'Tailscale-User-Login': 'x@y' })).status,
    ).toBe(403);
  });

  it('still takes a proposal from Kamaji’s own page', async () => {
    const { db, post } = app();
    const own = {
      Origin: 'https://molcajete.tailb3044a.ts.net:10002',
      Host: 'molcajete.tailb3044a.ts.net:10002',
    };
    expect((await post('/api/proposals', { items: pick(db) }, own)).status).toBe(201);
  });
});
