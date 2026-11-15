// Domain renewals through RDAP: one read per registrable domain, IANA's list kept for a week, and
// the issues on the domain's first site only. RDAP answers are captured fixtures (example.com from
// Verisign, web.dev from Google's registry, a .dev that doesn't exist).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { findOpenIssue } from '../issues.js';
import { siteSummaries } from '../queries.js';
import { testDb } from '../testing.js';
import {
  BOOTSTRAP_URL,
  checkDomain,
  checkDomains,
  expirationOf,
  NOT_AVAILABLE,
  rdapServer,
  registrableDomain,
} from './domains.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DAY = 86_400_000;
const BOOTSTRAP = fixture('rdap-bootstrap-dns.json');
const WEB_DEV = fixture('rdap-web.dev.json');
/** web.dev's expiration, as the fixture says it. */
const EXPIRES = Date.parse('2027-10-29T15:57:39.435Z');

/** web.dev's answer with another expiration date. */
const expiringOn = (iso: string) =>
  WEB_DEV.replace('"2027-10-29T15:57:39.435Z"', JSON.stringify(iso));

interface Web {
  /** The answer for each domain's RDAP query, or a status code. */
  answers: Record<string, string | number>;
  bootstrap: string | number;
  asked: string[];
}

function web(answers: Web['answers'] = {}): Web & { fetch: typeof fetch } {
  const w: Web = { answers, bootstrap: BOOTSTRAP, asked: [] };
  const reply = (body: string | number, type: string) =>
    typeof body === 'number'
      ? new Response('no', { status: body })
      : new Response(body, { status: 200, headers: { 'content-type': type } });
  const fetchFake = (async (input: URL | string | Request) => {
    const url = String(input);
    w.asked.push(url);
    if (url === BOOTSTRAP_URL) return reply(w.bootstrap, 'application/json');
    const domain = decodeURIComponent(url.split('/domain/')[1] ?? '');
    return reply(w.answers[domain] ?? 404, 'application/rdap+json');
  }) as typeof fetch;
  return Object.assign(w, { fetch: fetchFake });
}

function site(db: Db, id: string, name = id) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, ?, 'other', 'monitoring', 'done', 0)`,
  ).run(id, name, `https://${id}/`);
}

const issue = (db: Db, siteId: string, kind: string) =>
  findOpenIssue(db, { resourceType: 'site', resourceId: siteId, kind });
const renewal = (db: Db, id: string) => siteSummaries(db).find((s) => s.id === id)?.renewal;

describe('registrable domains', () => {
  it('shares one domain between a site and its subdomains, and skips addresses', () => {
    expect(registrableDomain('craftish.dev')).toBe('craftish.dev');
    expect(registrableDomain('romaji.craftish.dev')).toBe('craftish.dev');
    expect(registrableDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('127.0.0.1')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
  });

  it('finds the registry’s RDAP server in IANA’s list, by the longest suffix', () => {
    const services = JSON.parse(BOOTSTRAP).services;
    expect(rdapServer(services, 'example.com')).toBe('https://rdap.verisign.com/com/v1/');
    expect(rdapServer(services, 'craftish.dev')).toBe('https://pubapi.registry.google/rdap/');
    expect(rdapServer(services, 'example.co.uk')).toBe('https://rdap.nominet.uk/uk/');
    expect(rdapServer(services, 'example.nz')).toBeNull();
  });

  it('reads the expiration event and nothing else', () => {
    expect(expirationOf(JSON.parse(fixture('rdap-example.com.json')))).toBe(
      Date.parse('2027-08-13T04:00:00Z'),
    );
    expect(expirationOf(JSON.parse(WEB_DEV))).toBe(EXPIRES);
    expect(
      expirationOf({ events: [{ eventAction: 'registration', eventDate: '2020-01-01' }] }),
    ).toBe(null);
    expect(expirationOf('nonsense')).toBeNull();
  });
});

describe('domain checks', () => {
  it('reads a shared domain once, shows it on both sites, and warns on the first only', async () => {
    const db = testDb();
    site(db, 'romaji.craftish.dev', 'Romaji');
    site(db, 'craftish.dev', 'Craftish');
    const w = web({ 'craftish.dev': expiringOn('2026-12-01T00:00:00Z') });
    const now = Date.parse('2026-11-16T00:00:00Z');
    expect(await checkDomains(db, { now: () => now, fetch: w.fetch })).toBe(1);
    expect(w.asked.filter((u) => u.includes('/domain/'))).toEqual([
      'https://pubapi.registry.google/rdap/domain/craftish.dev',
    ]);
    for (const id of ['craftish.dev', 'romaji.craftish.dev'])
      expect(renewal(db, id)).toMatchObject({
        domain: 'craftish.dev',
        expiresOn: '2026-12-01',
        note: null,
      });
    // On craftish.dev, the site at the domain itself, though Romaji comes first by name.
    expect(issue(db, 'craftish.dev', 'domain-expiring')).toMatchObject({
      severity: 'normal',
      summary: 'craftish.dev expires 2026-12-01, in 15 days',
    });
    expect(issue(db, 'romaji.craftish.dev', 'domain-expiring')).toBeNull();
    // Read today: not again until tomorrow.
    expect(await checkDomains(db, { now: () => now + DAY - 1, fetch: w.fetch })).toBe(0);
    expect(await checkDomains(db, { now: () => now + DAY, fetch: w.fetch })).toBe(1);
  });

  it('warns 30 days before, turns urgent at 7, and clears when a later date is read', async () => {
    const db = testDb();
    site(db, 'web.dev');
    const w = web({ 'web.dev': WEB_DEV });
    const at = async (daysBefore: number) => {
      await checkDomain(db, 'web.dev', { now: () => EXPIRES - daysBefore * DAY, fetch: w.fetch });
      return issue(db, 'web.dev', 'domain-expiring');
    };
    expect(await at(31)).toBeNull();
    expect(await at(30)).toMatchObject({ severity: 'normal' });
    expect(await at(8)).toMatchObject({ severity: 'normal' });
    expect(await at(7)).toMatchObject({ severity: 'urgent' });
    expect(await at(-1)).toMatchObject({
      severity: 'urgent',
      summary: 'web.dev expired on 2027-10-29',
    });
    w.answers['web.dev'] = expiringOn('2028-10-29T15:57:39.435Z');
    expect(await at(-1)).toBeNull();
    expect(renewal(db, 'web.dev')?.expiresOn).toBe('2028-10-29');
  });

  it('raises nothing for a registry without RDAP, or an answer without a date', async () => {
    const db = testDb();
    site(db, 'example.nz');
    site(db, 'web.dev');
    const w = web({ 'web.dev': JSON.stringify({ objectClassName: 'domain', events: [] }) });
    const now = EXPIRES;
    await checkDomains(db, { now: () => now, fetch: w.fetch });
    expect(w.asked.some((u) => u.includes('example.nz'))).toBe(false);
    for (const id of ['example.nz', 'web.dev']) {
      expect(renewal(db, id)).toMatchObject({ expiresOn: null, note: NOT_AVAILABLE });
      expect(issue(db, id, 'domain-expiring')).toBeNull();
      expect(issue(db, id, 'domain-unreadable')).toBeNull();
    }
  });

  it('says it can’t read a domain after three failed days in a row, keeping the last date', async () => {
    const db = testDb();
    site(db, 'web.dev');
    const w = web({ 'web.dev': WEB_DEV });
    const start = EXPIRES - 100 * DAY;
    const on = (day: number) => checkDomains(db, { now: () => start + day * DAY, fetch: w.fetch });
    await on(0);
    w.answers['web.dev'] = 503;
    await on(1);
    await on(2);
    expect(issue(db, 'web.dev', 'domain-unreadable')).toBeNull();
    expect(renewal(db, 'web.dev')).toMatchObject({
      expiresOn: '2027-10-29',
      note: 'Couldn’t read it: HTTP 503',
    });
    await on(3);
    expect(issue(db, 'web.dev', 'domain-unreadable')).toMatchObject({
      severity: 'normal',
      summary: 'Kamaji can’t read web.dev’s renewal date: HTTP 503',
    });
    w.answers['web.dev'] = WEB_DEV;
    await on(4);
    expect(issue(db, 'web.dev', 'domain-unreadable')).toBeNull();
  });

  it('keeps IANA’s list for a week, and an old one when a new one can’t be had', async () => {
    const db = testDb();
    site(db, 'web.dev');
    const w = web({ 'web.dev': WEB_DEV });
    const bootstraps = () => w.asked.filter((u) => u === BOOTSTRAP_URL).length;
    const start = Date.parse('2026-11-16T00:00:00Z');
    for (let day = 0; day < 7; day++)
      await checkDomains(db, { now: () => start + day * DAY, fetch: w.fetch });
    expect(bootstraps()).toBe(1);
    w.bootstrap = 500;
    await checkDomains(db, { now: () => start + 7 * DAY, fetch: w.fetch });
    expect(bootstraps()).toBe(2);
    expect(renewal(db, 'web.dev')?.note).toBeNull();
  });
});

describe('Check again', () => {
  it('reads the site’s domain now, with no passkey, read today or not', async () => {
    const db = testDb();
    site(db, 'romaji.craftish.dev', 'Romaji');
    const w = web({ 'craftish.dev': WEB_DEV });
    const now = EXPIRES - 100 * DAY;
    await checkDomains(db, { now: () => now, fetch: w.fetch });
    const app = createApp({
      db,
      login: 'tylercraft@github',
      webDist: mkdtempSync(join(tmpdir(), 'kamaji-web-')),
      statusInput: () => ({
        version: '0.1.0',
        commit: null,
        startedAt: 0,
        now,
        cycleSeconds: 300,
        heartbeatConfigured: false,
        alertsConfigured: false,
      }),
      // Passkeys set up, so a write that needed one would be asked for it (401).
      passkeys: testAuthenticator().config,
      rdapFetch: w.fetch,
      now: () => now,
    });
    const post = (path: string) =>
      app.request(path, {
        method: 'POST',
        headers: {
          'Tailscale-User-Login': 'tylercraft@github',
          Host: 'kamaji.test',
          Origin: 'https://kamaji.test',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    w.answers['craftish.dev'] = expiringOn('2028-01-01T00:00:00Z');
    const res = await post('/api/sites/romaji.craftish.dev/domain/check');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'ok' });
    expect(renewal(db, 'romaji.craftish.dev')?.expiresOn).toBe('2028-01-01');
    expect((await post('/api/sites/nope.test/domain/check')).status).toBe(404);
  });
});
