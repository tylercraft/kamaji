import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchView, SiteScreenshotsResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { testDb } from '../testing.js';
import { runShots } from './run.js';
import { batch, fakeDocker, site, T } from './testShots.js';
import { requestSet } from './sets.js';

const LOGIN = 'tylercraft@github';

function app() {
  const db = testDb();
  site(db);
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
  const shotsDir = mkdtempSync(join(tmpdir(), 'kamaji-shots-'));
  let started = 0;
  const passkey = testAuthenticator();
  const a = createApp({
    db,
    login: LOGIN,
    webDist,
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: T,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
    startShots: () => void started++,
    shotsDir,
    log: () => {},
    passkeys: passkey.config,
    now: () => T,
  });
  const headers = { 'Tailscale-User-Login': LOGIN, Host: 'kamaji.test' };
  const write = { ...headers, Origin: 'https://kamaji.test', 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, signed = false) =>
    signed
      ? passkey.post(a, path, JSON.stringify(body), write)
      : a.request(path, { method: 'POST', headers: write, body: JSON.stringify(body) });
  const shoot = () =>
    runShots({
      db,
      exec: fakeDocker().exec,
      docker: 'docker',
      dir: shotsDir,
      seccomp: 's.json',
      image: 'kamaji-shots:abcdef012345',
      now: () => T,
      log: () => {},
    });
  return { db, a, headers, post, shoot, started: () => started };
}

describe('screenshots over the API', () => {
  it('Take screenshots now needs no passkey, and wakes the screenshots process', async () => {
    const { db, a, headers, post, started } = app();
    const res = await post('/api/sites/one.test/screenshots', {});
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(started()).toBe(1);
    expect(db.prepare('SELECT kind, requested_by FROM screenshot_sets').get()).toEqual({
      kind: 'manual',
      requested_by: LOGIN,
    });
    const view = SiteScreenshotsResponse.parse(
      await (await a.request('/api/sites/one.test/screenshots', { headers })).json(),
    );
    expect(view.pending).toMatchObject({ id, state: 'waiting' });
    expect((await post('/api/sites/nope.test/screenshots', {})).status).toBe(404);
  });

  it('what’s hidden and masked takes the passkey, and refuses a selector that could be CSS', async () => {
    const { db, post } = app();
    const settings = { hide: ['#cookie-banner', '.chat'], mask: ['.cart-count'] };
    expect((await post('/api/sites/one.test/screenshots/settings', settings)).status).toBe(401);
    expect((await post('/api/sites/one.test/screenshots/settings', settings, true)).status).toBe(
      200,
    );
    expect(db.prepare('SELECT screenshot_hide, screenshot_mask FROM sites').get()).toEqual({
      screenshot_hide: '["#cookie-banner",".chat"]',
      screenshot_mask: '[".cart-count"]',
    });
    const bad = await post(
      '/api/sites/one.test/screenshots/settings',
      { hide: ['body{display:none}'], mask: [] },
      true,
    );
    expect(bad.status).toBe(400);
  });

  it('serves a set’s images behind the login, and nothing else', async () => {
    const { db, a, headers, shoot } = app();
    const id = requestSet(db, { siteId: 'one.test', batchId: null, kind: 'manual', by: null }, T)!;
    await shoot();
    const image = await a.request(`/api/screenshots/${id}/r1-p0-desktop.png`, { headers });
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(
      (
        await a.request(`/api/screenshots/${id}/r1-p0-desktop.png`, {
          headers: { Host: 'kamaji.test' },
        })
      ).status,
    ).not.toBe(200);
    expect((await a.request(`/api/screenshots/${id}/..%2Fkamaji.db`, { headers })).status).toBe(
      404,
    );
  });

  it('a run’s record carries its screenshots', async () => {
    const { db, a, headers, shoot } = app();
    batch(db);
    db.prepare(
      `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, state) VALUES ('b1', 'one.test', 0, 'host', 'done')`,
    ).run();
    requestSet(db, { siteId: 'one.test', batchId: 'b1', kind: 'before', by: null }, T);
    await shoot();
    requestSet(db, { siteId: 'one.test', batchId: 'b1', kind: 'after', by: null }, T + 1);
    await shoot();
    const body = (await (await a.request('/api/updates', { headers })).json()) as {
      batches: unknown[];
    };
    const run = BatchView.parse(body.batches[0]);
    expect(run.sites[0]!.screenshots).toMatchObject({
      before: { state: 'done' },
      after: { state: 'done' },
    });
    expect(run.sites[0]!.screenshots!.comparisons).toHaveLength(4);
  });
});
