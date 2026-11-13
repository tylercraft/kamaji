import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActivityResponse,
  OverviewResponse,
  ServersResponse,
  SitesResponse,
  StatusResponse,
} from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { CYCLE } from './cycle.js';
import type { Db } from './db.js';
import { recordEvent } from './events.js';
import { claim, enqueue, finish } from './jobs/store.js';
import { testDb } from './testing.js';

const LOGIN = 'tylercraft@github';

function setup(options: { login?: string; db?: Db } = {}) {
  const db = options.db ?? testDb();
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Kamaji</title>');
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const app = createApp({
    db,
    login: options.login ?? LOGIN,
    webDist,
    statusInput: () => ({
      version: '0.1.0',
      commit: 'abc1234',
      startedAt: 0,
      now: 60_000,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
  });
  const get = (path: string, login: string | null = LOGIN) =>
    app.request(path, { headers: login === null ? {} : { 'Tailscale-User-Login': login } });
  return { db, get };
}

describe('the login gate', () => {
  it('refuses a request with no login, another login, or when no login is configured', async () => {
    const { get } = setup();
    expect((await get('/api/status', null)).status).toBe(403);
    expect((await get('/api/status', 'j_nilsson@me.com')).status).toBe(403);
    expect((await get('/', null)).status).toBe(403);
    const open = setup({ login: '' });
    expect((await open.get('/api/status', '')).status).toBe(403);
    expect((await open.get('/api/status', LOGIN)).status).toBe(403);
  });

  it('lets the configured login in, ignoring case and spaces', async () => {
    const { get } = setup();
    expect((await get('/api/status', ' TylerCraft@GitHub ')).status).toBe(200);
  });

  it('sends security headers, even on refusals', async () => {
    const { get } = setup();
    const res = await get('/api/status', null);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('the API on an empty database', () => {
  it('says unknown, never zero, for what nothing is watching', async () => {
    const { get } = setup();
    const body = OverviewResponse.parse(await (await get('/api/overview')).json());
    expect(body.sites.total).toBe(0);
    expect(body.attention).toEqual({ known: false, reason: 'Nothing is being watched yet' });
    expect(body.updatesWaiting).toEqual({ known: false, reason: 'No connected sites' });
  });

  it('lists no sites or servers', async () => {
    const { get } = setup();
    expect(SitesResponse.parse(await (await get('/api/sites')).json()).sites).toEqual([]);
    expect(ServersResponse.parse(await (await get('/api/servers')).json()).servers).toEqual([]);
  });

  it('reports no cycle yet and the heartbeat as not configured', async () => {
    const { get } = setup();
    const body = StatusResponse.parse(await (await get('/api/status')).json());
    expect(body.cycle.last).toBeNull();
    expect(body.heartbeat).toEqual({ configured: false });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const { get } = setup();
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('status', () => {
  it('shows the last cycle that started, not one still queued', async () => {
    const db = testDb();
    const id = enqueue(db, 1000, CYCLE, {}, { dedupeKey: CYCLE })!;
    claim(db, 1000, 'a', 60_000, [CYCLE]);
    finish(db, 2000, id, 'a', { state: 'succeeded', result: {} });
    enqueue(db, 3000, CYCLE, {}, { dedupeKey: CYCLE });
    const { get } = setup({ db });
    const body = StatusResponse.parse(await (await get('/api/status')).json());
    expect(body.cycle.last).toEqual({
      startedAt: new Date(1000).toISOString(),
      finishedAt: new Date(2000).toISOString(),
      state: 'succeeded',
    });
  });
});

describe('activity', () => {
  it('pages newest first', async () => {
    const db = testDb();
    for (let i = 1; i <= 5; i++) recordEvent(db, i * 1000, { kind: 'test', summary: `event ${i}` });
    const { get } = setup({ db });
    const first = ActivityResponse.parse(await (await get('/api/activity?limit=2')).json());
    expect(first.events.map((e) => e.summary)).toEqual(['event 5', 'event 4']);
    const second = ActivityResponse.parse(
      await (await get(`/api/activity?limit=2&before=${first.nextBefore}`)).json(),
    );
    expect(second.events.map((e) => e.summary)).toEqual(['event 3', 'event 2']);
    const last = ActivityResponse.parse(
      await (await get(`/api/activity?limit=2&before=${second.nextBefore}`)).json(),
    );
    expect(last.events.map((e) => e.summary)).toEqual(['event 1']);
    expect(last.nextBefore).toBeNull();
  });
  it('orders by when events happened, ties by the order they were written, across pages', async () => {
    const db = testDb();
    // Written out of order, as a backup's events are when its process finishes later.
    for (const [at, summary] of [
      [4000, 'four'],
      [1000, 'one'],
      [5000, 'five, first written'],
      [2000, 'two'],
      [5000, 'five, second written'],
      [3000, 'three'],
    ] as const)
      recordEvent(db, at, { kind: 'test', summary });
    const { get } = setup({ db });
    const pages: string[][] = [];
    let before: number | null = null;
    do {
      const page = ActivityResponse.parse(
        await (await get(`/api/activity?limit=2${before ? `&before=${before}` : ''}`)).json(),
      );
      pages.push(page.events.map((e) => e.summary));
      before = page.nextBefore;
    } while (before !== null);
    expect(pages).toEqual([
      ['five, second written', 'five, first written'],
      ['four', 'three'],
      ['two', 'one'],
    ]);
  });
});

describe('the web app', () => {
  it('serves index.html for app paths and caches hashed assets', async () => {
    const { get } = setup();
    for (const path of ['/', '/sites', '/rules']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>Kamaji</title>');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
    const asset = await get('/assets/app-abc123.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('404s a missing asset instead of caching the page under its name', async () => {
    const { get } = setup();
    const res = await get('/assets/app-old999.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('does not serve files outside the build', async () => {
    const { get } = setup();
    const res = await get('/../../package.json');
    expect(await res.text()).not.toContain('"workspaces"');
  });
});
