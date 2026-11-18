import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteDetailResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { detectPlatform, platformOf } from '../checks/platform.js';
import { testAuthenticator } from '../passkeys/testing.js';
import type { CareResult } from '../care/client.js';
import { loadCareKeys, newKeyPair, type CareKeys, type SigningKey } from '../care/keys.js';
import { testDb } from '../testing.js';
import type { CareSend } from './setup.js';
import { recordTest } from '../sitebackups/kinsta.js';

const LOGIN = 'tylercraft@github';
const ORIGIN = 'https://kamaji.test';
const T = Date.UTC(2026, 10, 9, 0, 0);

const report = newKeyPair();
const update = newKeyPair();
const reportOnly = loadCareKeys({
  KAMAJI_CARE_REPORT_KEY: report.seed,
  KAMAJI_CARE_UPDATE_PUBLIC_KEY: update.publicKey,
});
const withUpdate = loadCareKeys({
  KAMAJI_CARE_REPORT_KEY: report.seed,
  KAMAJI_CARE_UPDATE_KEY: update.seed,
});

const HELLO = {
  plugin: '0.1.0',
  protocol: 1,
  wordpress: '6.9',
  php: '8.3.14',
  multisite: false,
  capabilities: {
    can_report: true,
    can_update: false,
    update_blockers: ['filesystem_not_direct'],
    auto_updates: { all_disabled: false, plugins: true, themes: true },
    maintenance: { present: false, age_seconds: null },
    wp_cron_disabled: false,
    loopback: { ok: true },
  },
};

function setup(keys: CareKeys | undefined, answer: (endpoint: string) => CareResult) {
  const db = testDb();
  const sent: { endpoint: string; key: SigningKey; url: string }[] = [];
  const send: CareSend = async (home, key, endpoint) => {
    sent.push({ endpoint, key, url: home.href });
    return answer(endpoint);
  };
  const passkey = testAuthenticator();
  const app = createApp({
    db,
    login: LOGIN,
    webDist: mkdtempSync(join(tmpdir(), 'kamaji-web-')),
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: T,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
    care: {
      keys,
      pluginDir: new URL('../../../../plugin/craftish-care', import.meta.url).pathname,
      send,
    },
    passkeys: passkey.config,
    now: () => T,
  });
  const headers = {
    'Tailscale-User-Login': LOGIN,
    Host: 'kamaji.test',
    Origin: ORIGIN,
    'Content-Type': 'application/json',
  };
  // As the page does: a passkey for the writes that need one (passkeys/), none for the rest.
  const post = (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
    passkey.post(app, path, JSON.stringify(body), { ...headers, ...extra });
  const get = (path: string) => app.request(path, { headers });
  const detail = async (id: string) =>
    SiteDetailResponse.parse(await (await get(`/api/sites/${id}`)).json());
  return { db, app, post, get, detail, sent };
}

const ok = (data: unknown): CareResult => ({ ok: true, status: 200, data });
const NEW = {
  name: 'Test site',
  url: 'https://kamaji-wp.ddev.site',
  hostKind: 'other',
  clientSlug: null,
};

describe('writes', () => {
  it('come only as JSON from Kamaji’s own page', async () => {
    const { post } = setup(reportOnly, () => ok(HELLO));
    expect((await post('/api/sites', NEW, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/sites', NEW, { Origin: '' })).status).toBe(403);
    expect((await post('/api/sites', NEW, { 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await post('/api/sites', NEW)).status).toBe(201);
  });
});

describe('Add site', () => {
  it('saves step 1 as an unfinished setup, once per address', async () => {
    const { post, get } = setup(reportOnly, () => ok(HELLO));
    expect(await (await post('/api/sites', NEW)).json()).toEqual({ id: 'kamaji-wp.ddev.site' });
    expect((await post('/api/sites', { ...NEW, url: 'https://kamaji-wp.ddev.site/' })).status).toBe(
      409,
    );
    const detail = await (await get('/api/sites/kamaji-wp.ddev.site')).json();
    expect(detail).toMatchObject({
      site: { url: 'https://kamaji-wp.ddev.site/', setup: 'connect', mode: 'monitoring' },
      handshake: null,
      canConnect: true,
    });
  });

  it('goes straight to step 3 for monitoring only, and finishes with checks pending', async () => {
    const { post, get, sent } = setup(reportOnly, () => ok(HELLO));
    await post('/api/sites', NEW);
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'monitoring' });
    const done = await post('/api/sites/kamaji-wp.ddev.site/configure', {
      expectedText: 'Kamaji test',
      backupExpectation: 'host',
      notifications: 'digest',
    });
    expect(done.status).toBe(200);
    const detail = await (await get('/api/sites/kamaji-wp.ddev.site')).json();
    expect(detail).toMatchObject({
      site: {
        setup: 'done',
        mode: 'monitoring',
        expectedText: 'Kamaji test',
        availability: { known: false, reason: 'First check pending' },
      },
      backupExpectation: 'host',
      notifications: 'digest',
    });
    expect(sent).toEqual([]);
  });

  it('renames: the display name changes, the id, domain and history don’t', async () => {
    const { db, post, detail } = setup(reportOnly, () => ok(HELLO));
    await post('/api/sites', NEW);
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'monitoring' });
    const config = { expectedText: null, backupExpectation: 'host', notifications: 'normal' };
    await post('/api/sites/kamaji-wp.ddev.site/configure', config);
    const before = (await detail('kamaji-wp.ddev.site')).site.name;
    expect(
      (await post('/api/sites/kamaji-wp.ddev.site/configure', { ...config, name: '  Renamed  ' }))
        .status,
    ).toBe(200);
    expect((await detail('kamaji-wp.ddev.site')).site).toMatchObject({
      id: 'kamaji-wp.ddev.site',
      name: 'Renamed',
      url: 'https://kamaji-wp.ddev.site/',
    });
    // Saving without a name leaves it, and an empty one is refused.
    await post('/api/sites/kamaji-wp.ddev.site/configure', config);
    expect((await detail('kamaji-wp.ddev.site')).site.name).toBe('Renamed');
    expect(
      (await post('/api/sites/kamaji-wp.ddev.site/configure', { ...config, name: ' ' })).status,
    ).toBe(400);
    expect(db.prepare("SELECT summary FROM events WHERE kind = 'site.renamed'").all()).toEqual([
      { summary: `Renamed ${before} to Renamed` },
    ]);
  });

  it('connects: the zip, then the handshake as the report key, then step 3', async () => {
    const { post, get, detail, sent } = setup(reportOnly, () => ok(HELLO));
    await post('/api/sites', NEW);
    expect((await get('/api/sites/kamaji-wp.ddev.site/craftish-care.zip')).status).toBe(404);
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'connected' });
    const zip = await get('/api/sites/kamaji-wp.ddev.site/craftish-care.zip');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(
      Buffer.from(await zip.arrayBuffer())
        .subarray(0, 2)
        .toString(),
    ).toBe('PK');

    const handshake = await (await post('/api/sites/kamaji-wp.ddev.site/handshake')).json();
    expect(handshake).toEqual({
      at: new Date(T).toISOString(),
      result: { ok: true, hello: HELLO },
    });
    expect(sent).toEqual([
      { endpoint: 'hello', key: reportOnly!.report, url: 'https://kamaji-wp.ddev.site/' },
    ]);
    expect((await detail('kamaji-wp.ddev.site')).site.setup).toBe('configure');
  });

  it('stays on step 2 when the handshake fails, saying why', async () => {
    const { post, detail } = setup(reportOnly, () => ({
      ok: false,
      status: 404,
      code: null,
      problem: 'Craftish Care isn’t answering: is it installed and activated?',
    }));
    await post('/api/sites', NEW);
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'connected' });
    await post('/api/sites/kamaji-wp.ddev.site/handshake');
    const site = await detail('kamaji-wp.ddev.site');
    expect(site.site.setup).toBe('connect');
    expect(site.handshake?.result).toEqual({
      ok: false,
      problem: 'Craftish Care isn’t answering: is it installed and activated?',
    });
  });

  it('offers Kamaji’s own backup only to a site hosted on craftish', async () => {
    const { post, detail } = setup(reportOnly, () => ok(HELLO));
    await post('/api/sites', NEW);
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'monitoring' });
    const config = { expectedText: null, backupExpectation: 'kamaji', notifications: 'normal' };
    const refused = await post('/api/sites/kamaji-wp.ddev.site/configure', config);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'not_craftish' });
    expect((await detail('kamaji-wp.ddev.site')).site.setup).toBe('configure');

    await post('/api/sites', {
      ...NEW,
      url: 'https://kamaji-wp-alias.ddev.site',
      hostKind: 'craftish',
    });
    await post('/api/sites/kamaji-wp-alias.ddev.site/mode', { mode: 'monitoring' });
    expect((await post('/api/sites/kamaji-wp-alias.ddev.site/configure', config)).status).toBe(200);
    expect((await detail('kamaji-wp-alias.ddev.site')).backupExpectation).toBe('kamaji');
  });

  it('turns whole-site backups on for a client’s site only with the client’s agreement', async () => {
    const { db, post, detail } = setup(reportOnly, () => ok(HELLO));
    await post('/api/sites', { ...NEW, hostKind: 'craftish' });
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'monitoring' });
    const base = { expectedText: null, backupExpectation: 'kamaji', notifications: 'normal' };
    const configure = (extra: object) =>
      post('/api/sites/kamaji-wp.ddev.site/configure', { ...base, ...extra });

    const refused = await configure({ siteBackups: 'weekly' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'no_consent' });
    expect((await detail('kamaji-wp.ddev.site')).siteBackups.schedule).toBe('off');

    expect((await configure({ siteBackups: 'weekly', clientAgreed: true })).status).toBe(200);
    expect((await detail('kamaji-wp.ddev.site')).siteBackups).toEqual({
      schedule: 'weekly',
      consentAt: new Date(T).toISOString(),
      consentBy: LOGIN,
    });
    // Saved again without the tick (or the field), the agreement stands.
    expect((await configure({ siteBackups: 'fortnightly' })).status).toBe(200);
    expect((await configure({})).status).toBe(200);
    expect((await detail('kamaji-wp.ddev.site')).siteBackups.schedule).toBe('fortnightly');

    // Off clears it, so turning them on again asks again.
    await configure({ siteBackups: 'off' });
    expect((await detail('kamaji-wp.ddev.site')).siteBackups.consentAt).toBeNull();
    expect((await configure({ siteBackups: 'weekly' })).status).toBe(400);
    expect(
      db
        .prepare("SELECT kind FROM events WHERE kind LIKE 'site.backup%' ORDER BY id")
        .all()
        .map((r) => r.kind),
    ).toEqual([
      'site.backup-consent',
      'site.backup-schedule',
      'site.backup-schedule',
      'site.backup-consent-cleared',
      'site.backup-schedule',
    ]);
  });

  it('asks no agreement on Tyler’s own site, and none off craftish at all', async () => {
    const { post, detail } = setup(reportOnly, () => ok(HELLO));
    const base = { expectedText: null, backupExpectation: null, notifications: 'normal' };
    await post('/api/sites', { ...NEW, hostKind: 'craftish' });
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'monitoring' });
    const own = await post('/api/sites/kamaji-wp.ddev.site/configure', {
      ...base,
      own: true,
      siteBackups: 'weekly',
    });
    expect(own.status).toBe(200);
    expect(await detail('kamaji-wp.ddev.site')).toMatchObject({
      own: true,
      siteBackups: { schedule: 'weekly', consentAt: null },
    });

    await post('/api/sites', { ...NEW, url: 'https://elsewhere.test' });
    await post('/api/sites/elsewhere.test/mode', { mode: 'monitoring' });
    const elsewhere = await post('/api/sites/elsewhere.test/configure', {
      ...base,
      own: true,
      siteBackups: 'weekly',
    });
    expect(await elsewhere.json()).toEqual({ error: 'not_craftish' });
  });

  it('on Kinsta: access saved with a passkey, Test connection without; backups on once it worked', async () => {
    const { db, app, post, detail } = setup(reportOnly, () => ok(HELLO));
    await post('/api/sites', { ...NEW, url: 'https://photogravure.com', hostKind: 'kinsta' });
    await post('/api/sites/photogravure.com/mode', { mode: 'monitoring' });
    const configure = (extra: object) =>
      post('/api/sites/photogravure.com/configure', {
        expectedText: null,
        backupExpectation: null,
        notifications: 'normal',
        own: true,
        ...extra,
      });
    // Kamaji's own backup before an update, there, is a whole-site snapshot: backups on first.
    expect(await (await configure({ backupExpectation: 'kamaji' })).json()).toEqual({
      error: 'kinsta_needs_backups',
    });
    expect(await (await configure({ siteBackups: 'weekly' })).json()).toEqual({
      error: 'kinsta_not_ready',
      problem: 'set its SSH host, port and user, then Test connection',
    });
    const access = { host: 'ssh.example.net', port: 12345, user: 'photogravure' };
    // Unsigned, it's refused: where Kamaji connects is a passkey's decision.
    const unsigned = await app.request('/api/sites/photogravure.com/kinsta', {
      method: 'POST',
      body: JSON.stringify(access),
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
    });
    expect(unsigned.status).toBe(401);
    expect((await post('/api/sites/photogravure.com/kinsta', access)).status).toBe(200);
    expect(
      (await post('/api/sites/photogravure.com/kinsta', { ...access, user: 'x; rm' })).status,
    ).toBe(400);
    const test = await app.request('/api/sites/photogravure.com/kinsta/test', {
      method: 'POST',
      body: '{}',
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
    });
    expect(test.status).toBe(202);
    expect((await detail('photogravure.com')).kinsta).toMatchObject({
      ...access,
      testPending: new Date(T).toISOString(),
      blocked: 'Test connection first',
    });
    // The backups process answers.
    recordTest(
      db,
      'photogravure.com',
      {
        ok: true,
        path: '/www/photogravure_123/public',
        wordpress: '6.8.3',
        wpCli: '2.11.0',
        wpContentBytes: 1024 ** 3,
        databaseBytes: 1024 ** 2,
      },
      T,
    );
    expect((await configure({ siteBackups: 'weekly', backupExpectation: 'kamaji' })).status).toBe(
      200,
    );
    expect(await detail('photogravure.com')).toMatchObject({
      backupExpectation: 'kamaji',
      siteBackups: { schedule: 'weekly' },
      kinsta: { blocked: null, test: { ok: true, path: '/www/photogravure_123/public' } },
    });
  });

  it('connects a site already set up as monitoring only, keeping its settings', async () => {
    let answer: CareResult = { ok: false, status: 404, code: null, problem: 'Not installed' };
    const { post, get, detail, sent } = setup(reportOnly, () => answer);
    await post('/api/sites', NEW);
    await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'monitoring' });
    await post('/api/sites/kamaji-wp.ddev.site/configure', {
      expectedText: 'Kamaji test',
      backupExpectation: 'host',
      notifications: 'digest',
    });
    expect((await get('/api/sites/kamaji-wp.ddev.site/craftish-care.zip')).status).toBe(200);

    await post('/api/sites/kamaji-wp.ddev.site/handshake');
    expect((await detail('kamaji-wp.ddev.site')).site).toMatchObject({
      mode: 'monitoring',
      setup: 'done',
    });

    answer = ok(HELLO);
    await post('/api/sites/kamaji-wp.ddev.site/handshake');
    const site = await detail('kamaji-wp.ddev.site');
    expect(site.site).toMatchObject({
      mode: 'connected',
      setup: 'done',
      expectedText: 'Kamaji test',
    });
    expect(site.backupExpectation).toBe('host');
    expect(sent.map((s) => s.endpoint)).toEqual(['hello', 'hello']);
  });

  it('can’t connect where this Kamaji has no keys', async () => {
    const { post, detail } = setup(undefined, () => ok(HELLO));
    await post('/api/sites', NEW);
    expect((await post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'connected' })).status).toBe(
      409,
    );
    expect((await detail('kamaji-wp.ddev.site')).canConnect).toBe(false);
  });
});

describe('Remove', () => {
  async function connected(
    keys: CareKeys | undefined,
    answer: (endpoint: string) => CareResult = () => ok(HELLO),
  ) {
    const s = setup(keys, answer);
    await s.post('/api/sites', NEW);
    await s.post('/api/sites/kamaji-wp.ddev.site/mode', { mode: 'connected' });
    await s.post('/api/sites/kamaji-wp.ddev.site/handshake');
    return s;
  }

  it('needs the site’s name typed back', async () => {
    const { post } = await connected(withUpdate);
    expect((await post('/api/sites/kamaji-wp.ddev.site/remove', { confirm: 'test' })).status).toBe(
      400,
    );
  });

  it('signs disconnect with the update key, then keeps the history', async () => {
    const { post, get, sent, db } = await connected(withUpdate);
    const removed = await post('/api/sites/kamaji-wp.ddev.site/remove', { confirm: 'Test site' });
    expect(await removed.json()).toEqual({ removed: true, disconnect: 'done', problem: null });
    expect(sent.map((s) => [s.endpoint, s.key.id])).toEqual([
      ['hello', 'r1'],
      ['disconnect', 'u1'],
    ]);
    expect((await get('/api/sites/kamaji-wp.ddev.site')).status).toBe(404);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM observations WHERE check_name = 'hello'").get(),
    ).toEqual({
      n: 1,
    });
  });

  it('says what’s left to do where it can’t sign a disconnect', async () => {
    const { post, sent } = await connected(reportOnly);
    const removed = await post('/api/sites/kamaji-wp.ddev.site/remove', { confirm: 'Test site' });
    expect(await removed.json()).toEqual({
      removed: true,
      disconnect: 'no-update-key',
      problem: 'This Kamaji can’t sign a disconnect yet: remove Craftish Care in wp-admin',
    });
    expect(sent.map((s) => s.endpoint)).toEqual(['hello']);
  });

  it('says what’s left to do when the disconnect fails', async () => {
    const { post } = await connected(withUpdate, (endpoint: string) =>
      endpoint === 'hello'
        ? ok(HELLO)
        : { ok: false, status: null, code: null, problem: 'Couldn’t reach the site' },
    );
    const removed = await post('/api/sites/kamaji-wp.ddev.site/remove', { confirm: 'Test site' });
    expect(await removed.json()).toEqual({
      removed: true,
      disconnect: 'failed',
      problem: 'Couldn’t reach the site: remove Craftish Care in wp-admin',
    });
  });
});

describe('Platforms', () => {
  const STATIC = { ...NEW, name: 'Static', url: 'https://static.test', platform: 'static' };

  it('takes a static site or an app straight to Configure, never connecting', async () => {
    const { post, detail, sent } = setup(reportOnly, () => ok(HELLO));
    expect((await post('/api/sites', STATIC)).status).toBe(201);
    expect((await detail('static.test')).site).toMatchObject({
      platform: 'static',
      setup: 'configure',
      mode: 'monitoring',
    });
    // Nothing to connect: no zip, no handshake, no choosing to connect.
    expect((await post('/api/sites/static.test/mode', { mode: 'connected' })).status).toBe(404);
    expect((await post('/api/sites/static.test/handshake')).status).toBe(404);
    expect(sent).toEqual([]);
    // WordPress stays the default.
    await post('/api/sites', NEW);
    expect((await detail('kamaji-wp.ddev.site')).site).toMatchObject({
      platform: 'wordpress',
      setup: 'connect',
    });
  });

  it('keeps no backup expectation or backups for a static site, whatever is asked', async () => {
    const { db, post, get, detail } = setup(reportOnly, () => ok(HELLO));
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('romaji.craftish.dev', 'Romaji', 'https://romaji.craftish.dev/', 'craftish',
         'monitoring', 'done', 0)`,
    ).run();
    const saved = await post('/api/sites/romaji.craftish.dev/configure', {
      platform: 'static',
      expectedText: null,
      backupExpectation: 'kamaji',
      notifications: 'normal',
      own: true,
      siteBackups: 'weekly',
    });
    expect(saved.status).toBe(200);
    const d = await detail('romaji.craftish.dev');
    expect(d.site.platform).toBe('static');
    expect(d.backupExpectation).toBeNull();
    expect(d.siteBackups.schedule).toBe('off');
    expect((await post('/api/sites/romaji.craftish.dev/backups')).status).toBe(404);
    expect(
      (await post('/api/sites/romaji.craftish.dev/backups/whole-site', { kind: 'backup' })).status,
    ).toBe(404);
    expect((await get('/api/sites/romaji.craftish.dev/craftish-care.zip')).status).toBe(404);
    const activity = db
      .prepare("SELECT summary FROM events WHERE kind = 'site.platform'")
      .all()
      .map((r) => r.summary);
    expect(activity).toEqual(['Romaji is a static site (was WordPress)']);
  });

  it('won’t make a connected site static until it’s disconnected', async () => {
    const { db, post } = setup(reportOnly, () => ok(HELLO));
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('wp.test', 'WP', 'https://wp.test/', 'other', 'connected', 'done', 0)`,
    ).run();
    const refused = await post('/api/sites/wp.test/configure', {
      platform: 'app',
      expectedText: null,
      backupExpectation: null,
      notifications: 'normal',
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'connected' });
  });
});

describe('Add site’s platform guess', () => {
  const page = (html: string) =>
    (async () =>
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

  it('reads WordPress from its paths or generator tag, and static from anything else', async () => {
    expect(platformOf('<link rel="stylesheet" href="/wp-content/themes/x/style.css">')).toBe(
      'wordpress',
    );
    expect(platformOf('<link rel="https://api.w.org/" href="https://a.test/wp-json/">')).toBe(
      'wordpress',
    );
    expect(platformOf('<meta name="generator" content="WordPress 6.9">')).toBe('wordpress');
    expect(platformOf('<meta content="WordPress 6.9" name="generator">')).toBe('wordpress');
    expect(platformOf('<meta name="generator" content="Astro v5">')).toBe('static');
    expect(await detectPlatform('https://a.test/', { fetch: page('<h1>Hi</h1>') })).toEqual({
      platform: 'static',
      problem: null,
    });
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect(await detectPlatform('https://a.test/', { fetch: down })).toEqual({
      platform: null,
      problem: 'HTTP 503',
    });
  });

  it('is asked without a passkey', async () => {
    const { app } = setup(reportOnly, () => ok(HELLO));
    const res = await app.request('/api/sites/detect', {
      method: 'POST',
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://127.0.0.1:9/' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ platform: null });
  });
});

describe('Pages to check', () => {
  const site = (db: ReturnType<typeof setup>['db'], platform = 'wordpress') =>
    db
      .prepare(
        `INSERT INTO sites (id, name, url, host_kind, mode, platform, setup, created_at)
         VALUES ('minton.test', 'Minton', 'https://minton.test/', 'other', 'monitoring', ?, 'done', 0)`,
      )
      .run(platform);
  const configure = (
    pages: { page: string; expectedText: string | null }[],
    platform?: string,
  ) => ({
    ...(platform ? { platform } : {}),
    expectedText: null,
    backupExpectation: null,
    notifications: 'normal',
    pages,
  });

  it('saves each page with its own text, and shows them on the site', async () => {
    const { db, post, detail } = setup(reportOnly, () => ok(HELLO));
    site(db);
    const saved = await post(
      '/api/sites/minton.test/configure',
      configure([
        { page: '/shop/', expectedText: 'Add to cart' },
        { page: 'https://www.minton.test/contact/', expectedText: null },
      ]),
    );
    expect(saved.status).toBe(200);
    expect((await detail('minton.test')).pages).toEqual([
      { url: 'https://minton.test/shop/', expectedText: 'Add to cart' },
      { url: 'https://www.minton.test/contact/', expectedText: null },
    ]);
    // Left as they were when a save doesn't send them.
    await post('/api/sites/minton.test/configure', {
      expectedText: 'Minton',
      backupExpectation: null,
      notifications: 'normal',
    });
    expect((await detail('minton.test')).pages).toHaveLength(2);
  });

  it('refuses a page off the site, or not https, and saves nothing', async () => {
    const { db, post, detail } = setup(reportOnly, () => ok(HELLO));
    site(db);
    for (const page of ['https://evil.test/', 'http://minton.test/shop/']) {
      const refused = await post(
        '/api/sites/minton.test/configure',
        configure([
          { page: '/shop/', expectedText: null },
          { page, expectedText: null },
        ]),
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'bad_page', page });
    }
    expect((await detail('minton.test')).pages).toEqual([]);
    const six = Array.from({ length: 6 }, (_, i) => ({ page: `/p${i}/`, expectedText: null }));
    expect((await post('/api/sites/minton.test/configure', configure(six))).status).toBe(400);
  });

  it('keeps none for a static site or an app: they have no updates', async () => {
    const { db, post, detail } = setup(reportOnly, () => ok(HELLO));
    site(db);
    await post(
      '/api/sites/minton.test/configure',
      configure([{ page: '/shop/', expectedText: null }]),
    );
    await post(
      '/api/sites/minton.test/configure',
      configure([{ page: '/shop/', expectedText: null }], 'static'),
    );
    expect((await detail('minton.test')).pages).toEqual([]);
  });
});

describe('time zones and the update time', () => {
  const craftish = (db: ReturnType<typeof setup>['db']) =>
    db
      .prepare(
        `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule, created_at)
         VALUES ('own.test', 'Own', 'https://own.test/', 'craftish', 'monitoring', 'done', 1, 'weekly', 0)`,
      )
      .run();
  const configure = (timeZone?: string) => ({
    expectedText: null,
    backupExpectation: 'kamaji',
    notifications: 'normal',
    own: true,
    siteBackups: 'weekly',
    ...(timeZone ? { timeZone } : {}),
  });

  it('a site starts in NZ time, takes an IANA zone, and refuses anything else', async () => {
    const { db, post, detail, get } = setup(reportOnly, () => ok(HELLO));
    craftish(db);
    expect((await detail('own.test')).timeZone).toBe('Pacific/Auckland');
    expect((await post('/api/sites/own.test/configure', configure('America/Chicago'))).status).toBe(
      200,
    );
    expect((await detail('own.test')).timeZone).toBe('America/Chicago');
    const refused = await post('/api/sites/own.test/configure', configure('Mars/Olympus'));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'bad_zone' });
    // Left as it was when a save doesn't send one.
    await post('/api/sites/own.test/configure', configure());
    expect((await detail('own.test')).timeZone).toBe('America/Chicago');
    const backups = (await (await get('/api/sites/own.test/backups')).json()) as {
      wholeSite: { timeZone: string; nextDueAt: string };
    };
    expect(backups.wholeSite.timeZone).toBe('America/Chicago');
    expect(db.prepare("SELECT summary FROM events WHERE kind = 'site.time-zone'").all()).toEqual([
      { summary: 'Own’s time zone: America/Chicago' },
    ]);
  });

  it('the update time is Tuesday 19:00 until set, and setting it takes a passkey', async () => {
    const { app, post, get, db } = setup(reportOnly, () => ok(HELLO));
    expect(await (await get('/api/settings')).json()).toEqual({
      updateTime: { weekday: 2, hour: 19 },
      // T is Monday 9 November 2026, 13:00 NZDT.
      nextUpdateAt: new Date(Date.UTC(2026, 10, 10, 6, 0)).toISOString(),
    });
    const unsigned = await app.request('/api/settings/update-time', {
      method: 'POST',
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ weekday: 4, hour: 9 }),
    });
    expect(unsigned.status).toBe(401);
    expect((await post('/api/settings/update-time', { weekday: 7, hour: 9 })).status).toBe(400);
    const saved = await post('/api/settings/update-time', { weekday: 4, hour: 9 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      updateTime: { weekday: 4, hour: 9 },
      nextUpdateAt: new Date(Date.UTC(2026, 10, 11, 20, 0)).toISOString(),
    });
    expect(
      db.prepare("SELECT summary FROM events WHERE kind = 'kamaji.update-time'").all(),
    ).toEqual([{ summary: `Update time set to Thursday 09:00 NZ time (by ${LOGIN})` }]);
  });
});

describe('what’s new', () => {
  it('opening a page is marked seen with no passkey; news says when, for this login', async () => {
    const { app, get } = setup(reportOnly, () => ok(HELLO));
    const seen = await app.request('/api/me/seen', {
      method: 'POST',
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page: 'sites' }),
    });
    expect(seen.status).toBe(200);
    const news = (await (await get('/api/me/news')).json()) as {
      login: string;
      seen: Record<string, string | null>;
    };
    expect(news.login).toBe(LOGIN);
    expect(news.seen).toEqual({ overview: null, sites: new Date(T).toISOString(), updates: null });
  });
});
