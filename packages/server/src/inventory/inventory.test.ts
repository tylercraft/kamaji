import { readFileSync } from 'node:fs';
import { CareReport } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import type { CareResult } from '../care/client.js';
import { loadCareKeys, newKeyPair } from '../care/keys.js';
import type { Db } from '../db.js';
import { overview } from '../queries.js';
import { testDb } from '../testing.js';
import type { CareSend } from '../sites/setup.js';
import { checkDirectory, lookupUrl, parseDirectory, parseLastUpdated } from './directory.js';
import { careStatus, checkReports, reportSite, siteInventory, updatesWaiting } from './report.js';
import { recordObservation } from '../observations.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const REPORT = CareReport.parse(fixture('care-report.json'));

const T = Date.UTC(2026, 10, 9, 0, 0);
const HOUR = 3_600_000;
const keys = loadCareKeys({
  KAMAJI_CARE_REPORT_KEY: newKeyPair().seed,
  KAMAJI_CARE_UPDATE_PUBLIC_KEY: newKeyPair().publicKey,
})!;
const SITE = {
  id: 'kamaji-wp.ddev.site',
  name: 'Kamaji test',
  url: 'https://kamaji-wp.ddev.site/',
};

function connectedSite(db: Db) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, ?, 'other', 'connected', 'done', ?)`,
  ).run(SITE.id, SITE.name, SITE.url, T);
}

function plugin(answers: (() => CareResult)[]) {
  const asked: { endpoint: string; body: Record<string, unknown> }[] = [];
  const send: CareSend = async (_home, _key, endpoint, body) => {
    asked.push({ endpoint, body });
    const result = (answers.shift() ?? (() => good()))();
    // Like the plugin: it says whether it reran WordPress's checks, as asked.
    return result.ok
      ? { ...result, data: { ...(result.data as object), refreshed: body.refresh === true } }
      : result;
  };
  return { send, asked };
}

const good = (report: unknown = REPORT): CareResult => ({ ok: true, status: 200, data: report });
const bad = (): CareResult => ({
  ok: false,
  status: null,
  code: null,
  problem: 'Couldn’t reach the site',
});

const events = (db: Db) =>
  db
    .prepare("SELECT summary FROM events WHERE kind = 'site.component-changed' ORDER BY id")
    .all()
    .map((r) => String(r.summary));

describe('the report', () => {
  it('parses what the plugin actually sends', () => {
    expect(REPORT.plugins.map((p) => p.file)).toEqual([
      'akismet/akismet.php',
      'craftish-care/craftish-care.php',
      'hello-dolly/hello.php',
    ]);
  });

  it('keeps the inventory, inactive components too, and counts what’s on offer', async () => {
    const db = testDb();
    connectedSite(db);
    const { send } = plugin([good]);
    expect(await reportSite(db, SITE, keys, send, () => T)).toBe(true);
    const inventory = siteInventory(db, { id: SITE.id, mode: 'connected' });
    expect(inventory).toMatchObject({
      known: true,
      value: {
        core: { version: '7.1.4', locale: 'en_US', offer: null },
        php: '8.3.36',
        database: '11.8.9-MariaDB-ubu2404-log',
        siteHealth: [{ test: 'debug_enabled' }],
        lastFailure: null,
      },
    });
    const value = inventory.known ? inventory.value : null;
    expect(value?.plugins.map((p) => [p.slug, p.version, p.active, p.offer])).toEqual([
      ['akismet', '5.3', true, { version: '5.7.2', hasPackage: true }],
      ['craftish-care', '0.1.0', true, null],
      ['hello-dolly', '1.7.2', false, null],
    ]);
    expect(value?.themes.map((t) => [t.stylesheet, t.active])).toEqual([
      ['twentytwentyfive', true],
      ['twentytwentyfour', false],
    ]);
    expect(updatesWaiting(db, { id: SITE.id, mode: 'connected' })).toEqual({
      known: true,
      value: 1,
    });
    expect(events(db)).toEqual(['First inventory from Kamaji test: 3 plugins, 2 themes']);
  });

  it('records what changed between reports, as events', async () => {
    const db = testDb();
    connectedSite(db);
    const next = structuredClone(REPORT);
    next.plugins[0]!.version = '5.7.2';
    next.plugins[0]!.offer = null;
    next.plugins = next.plugins.filter((p) => p.slug !== 'hello-dolly');
    next.themes[0]!.offer = { version: '1.6', package: true };
    const { send } = plugin([good, () => good(next)]);
    await reportSite(db, SITE, keys, send, () => T);
    await reportSite(db, SITE, keys, send, () => T + HOUR);
    expect(events(db).slice(1)).toEqual([
      'Akismet Anti-spam: Spam Protection went from 5.3 to 5.7.2 on Kamaji test',
      'Kamaji test: WordPress offers Twenty Twenty-Five 1.6',
      'Hello Dolly is no longer on Kamaji test',
    ]);
    // Gone, not deleted: the record stays.
    expect(
      db.prepare("SELECT gone_at FROM components WHERE item = 'hello-dolly/hello.php'").get(),
    ).toEqual({ gone_at: T + HOUR });
  });

  it('lists must-use plugins from 0.2.0, and an older report leaves them unknown, not gone', async () => {
    const db = testDb();
    connectedSite(db);
    const withMu = {
      ...structuredClone(REPORT),
      mu_plugins: [{ file: 'example-mu.php', name: 'Example Must-use', version: '1.0.0' }],
    };
    const { send } = plugin([() => good(REPORT), () => good(withMu), () => good(REPORT)]);
    const inventory = () => {
      const i = siteInventory(db, { id: SITE.id, mode: 'connected' });
      return i.known ? i.value : null;
    };

    await reportSite(db, SITE, keys, send, () => T);
    expect(inventory()?.muPlugins).toEqual({
      known: false,
      reason: 'Not reported: Craftish Care lists them from 0.2.0, and this site’s copy is older',
    });

    await reportSite(db, SITE, keys, send, () => T + HOUR);
    expect(inventory()?.muPlugins).toEqual({
      known: true,
      value: [{ file: 'example-mu.php', name: 'Example Must-use', version: '1.0.0' }],
    });
    // Listed only: no offer, no wordpress.org lookup, no vulnerability match.
    expect(inventory()?.plugins.map((p) => p.file)).not.toContain('example-mu.php');
    expect(updatesWaiting(db, { id: SITE.id, mode: 'connected' })).toEqual({
      known: true,
      value: 1,
    });

    await reportSite(db, SITE, keys, send, () => T + 2 * HOUR);
    expect(
      db.prepare("SELECT gone_at FROM components WHERE item = 'example-mu.php'").get(),
    ).toEqual({ gone_at: null });
    expect(inventory()?.muPlugins.known).toBe(false);
  });

  it('asks hourly, has WordPress recheck once a day, and keeps the last good inventory on failure', async () => {
    const db = testDb();
    connectedSite(db);
    const { send, asked } = plugin([good, bad, good]);
    const signal = new AbortController().signal;
    await checkReports(db, { keys, send, now: () => T, signal });
    await checkReports(db, { keys, send, now: () => T + HOUR / 2, signal }); // not due
    await checkReports(db, { keys, send, now: () => T + HOUR, signal });
    expect(siteInventory(db, { id: SITE.id, mode: 'connected' })).toMatchObject({
      known: true,
      value: {
        reportedAt: new Date(T).toISOString(),
        lastFailure: { problem: 'Couldn’t reach the site' },
      },
    });
    await checkReports(db, { keys, send, now: () => T + 2 * HOUR, signal });
    expect(asked.map((a) => a.body)).toEqual([
      { refresh: true },
      { refresh: false },
      { refresh: false },
    ]);
    // A day after the last refresh, it asks WordPress to recheck again.
    await checkReports(db, { keys, send, now: () => T + 24 * HOUR, signal });
    expect(asked.at(-1)?.body).toEqual({ refresh: true });
  });

  it('has WordPress recheck after a rollback or undo changed the files since the last refresh', async () => {
    const db = testDb();
    connectedSite(db);
    const { send, asked } = plugin([]);
    const signal = new AbortController().signal;
    await checkReports(db, { keys, send, now: () => T, signal });
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES ('b', 0, 'tyler', 0, 'finished')`,
    ).run();
    const rollback = db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by,
         with_database, state, changed, finished_at)
       VALUES (?, 'rollback', ?, 'b', 'craftish', ?, 'tyler', 0, ?, ?, ?)`,
    );
    // One that changed nothing doesn't count.
    rollback.run('r0', SITE.id, T, 'failed', 'none', T + HOUR / 2);
    await checkReports(db, { keys, send, now: () => T + HOUR, signal });
    expect(asked.at(-1)?.body).toEqual({ refresh: false });
    // One that did, and whose own check Craftish Care didn't refresh for.
    rollback.run('r1', SITE.id, T + HOUR, 'done', 'files', T + 1.5 * HOUR);
    await checkReports(db, { keys, send, now: () => T + 2 * HOUR, signal });
    expect(asked.at(-1)?.body).toEqual({ refresh: true });
    // Once is enough.
    await checkReports(db, { keys, send, now: () => T + 3 * HOUR, signal });
    expect(asked.at(-1)?.body).toEqual({ refresh: false });
  });

  it('opens an issue after a day without a good report, and resolves it on the next', async () => {
    const db = testDb();
    connectedSite(db);
    const { send } = plugin([good, bad, bad, good]);
    await reportSite(db, SITE, keys, send, () => T);
    await reportSite(db, SITE, keys, send, () => T + 23 * HOUR);
    const open = () =>
      db
        .prepare(
          "SELECT summary, severity FROM issues WHERE kind = 'inventory-stale' AND resolved_at IS NULL",
        )
        .get();
    expect(open()).toBeUndefined();
    await reportSite(db, SITE, keys, send, () => T + 25 * HOUR);
    expect(open()).toEqual({
      summary: 'Kamaji test hasn’t reported its inventory for a day: Couldn’t reach the site',
      severity: 'normal',
    });
    await reportSite(db, SITE, keys, send, () => T + 26 * HOUR);
    expect(open()).toBeUndefined();
  });

  it('never reads an unreported site as zero updates', async () => {
    const db = testDb();
    connectedSite(db);
    expect(updatesWaiting(db, { id: SITE.id, mode: 'connected' })).toEqual({
      known: false,
      reason: 'No report yet',
    });
    expect(overview(db).updatesWaiting).toEqual({
      known: false,
      reason: '1 of 1 connected site hasn’t reported yet',
    });
    const { send } = plugin([bad]);
    await reportSite(db, SITE, keys, send, () => T);
    expect(siteInventory(db, { id: SITE.id, mode: 'connected' })).toEqual({
      known: false,
      reason: 'No report yet: Couldn’t reach the site',
    });
    await reportSite(db, SITE, keys, plugin([good]).send, () => T + HOUR);
    expect(overview(db).updatesWaiting).toEqual({ known: true, value: 1 });
  });
});

describe('wordpress.org', () => {
  it('reads the three answers it gives', () => {
    expect(parseDirectory(200, fixture('wporg-akismet.json'))).toEqual({
      status: 'listed',
      latestVersion: '5.7.2',
      lastUpdated: Date.UTC(2026, 7, 18, 23, 42),
      tested: '7.1.4',
      closedDate: null,
      closedReason: null,
    });
    expect(parseDirectory(404, fixture('wporg-closed.json'))).toMatchObject({
      status: 'closed',
      closedDate: '2021-01-30',
      closedReason: 'Security Issue',
    });
    expect(parseDirectory(404, fixture('wporg-not-found.json'))).toMatchObject({
      status: 'not-listed',
    });
    expect(parseDirectory(500, { error: 'Something else' })).toBeNull();
    expect(parseLastUpdated('2026-01-05 12:03am GMT')).toBe(Date.UTC(2026, 0, 5, 0, 3));
  });

  it('sends only the slug', () => {
    const url = lookupUrl('akismet');
    expect(url.origin).toBe('https://api.wordpress.org');
    expect(url.searchParams.get('request[slug]')).toBe('akismet');
    expect([...url.searchParams.keys()].join(' ')).not.toMatch(/site|url|host/);
  });

  it('raises a closed plugin once per site, urgent for a security closure, and resolves it when it goes', async () => {
    const db = testDb();
    connectedSite(db);
    const report = structuredClone(REPORT);
    report.plugins[2]!.slug = 'display-widgets';
    await reportSite(db, SITE, keys, plugin([() => good(report)]).send, () => T);

    const answers: Record<string, [number, unknown]> = {
      akismet: [200, fixture('wporg-akismet.json')],
      'craftish-care': [404, fixture('wporg-not-found.json')],
      'display-widgets': [404, fixture('wporg-closed.json')],
    };
    const looked: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      const slug = new URL(String(url)).searchParams.get('request[slug]')!;
      looked.push(slug);
      const [status, body] = answers[slug]!;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    expect(await checkDirectory(db, { now: () => T, signal, fetch: fake })).toBe(3);
    expect(await checkDirectory(db, { now: () => T + HOUR, signal, fetch: fake })).toBe(0);
    expect(looked).toEqual(['akismet', 'craftish-care', 'display-widgets']);

    const issues = () =>
      db.prepare('SELECT kind, severity, summary FROM issues WHERE resolved_at IS NULL').all();
    expect(issues()).toEqual([
      {
        kind: 'abandoned:display-widgets',
        severity: 'urgent',
        summary: 'Kamaji test: an installed plugin was closed on wordpress.org (Security Issue)',
      },
    ]);
    const inventory = siteInventory(db, { id: SITE.id, mode: 'connected' });
    expect(inventory.known && inventory.value.plugins.map((p) => p.directory?.status)).toEqual([
      'listed',
      'not-listed',
      'closed',
    ]);

    report.plugins = report.plugins.filter((p) => p.slug !== 'display-widgets');
    await reportSite(db, SITE, keys, plugin([() => good(report)]).send, () => T + 2 * HOUR);
    await checkDirectory(db, { now: () => T + 2 * HOUR, signal, fetch: fake });
    expect(issues()).toEqual([]);
  });
});

describe('Craftish Care’s state on the Sites list', () => {
  it('gives the last good report, and a failure only when it came after it', () => {
    const db = testDb();
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('c.test', 'C', 'https://c.test/', 'other', 'connected', 'done', 0),
              ('m.test', 'M', 'https://m.test/', 'other', 'monitoring', 'done', 0)`,
    ).run();
    const report = (at: number, value: Record<string, unknown>) =>
      recordObservation(db, {
        resourceType: 'site',
        resourceId: 'c.test',
        check: 'report',
        source: 'plugin',
        at,
        ok: value.ok === true,
        value,
      });
    expect(careStatus(db, { id: 'c.test', mode: 'connected' })).toEqual({
      lastReportAt: null,
      failure: null,
    });
    report(1_000, { ok: true });
    report(2_000, { ok: false, problem: 'HTTP 500' });
    expect(careStatus(db, { id: 'c.test', mode: 'connected' })).toEqual({
      lastReportAt: new Date(1_000).toISOString(),
      failure: { at: new Date(2_000).toISOString(), problem: 'HTTP 500' },
    });
    report(3_000, { ok: true });
    expect(careStatus(db, { id: 'c.test', mode: 'connected' })?.failure).toBeNull();
    expect(careStatus(db, { id: 'm.test', mode: 'monitoring' })).toBeNull();
  });
});
