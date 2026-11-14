import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteDetailResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { testAuthenticator } from '../passkeys/testing.js';
import type { CareResult } from '../care/client.js';
import { loadCareKeys, newKeyPair, type CareKeys, type SigningKey } from '../care/keys.js';
import { testDb } from '../testing.js';
import type { CareSend } from './setup.js';

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
