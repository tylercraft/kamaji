import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CareReport } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';
import { siteInventory, storeReport } from '../inventory/report.js';
import { notifyNow } from '../notify.js';
import { recordObservation } from '../observations.js';
import { testDb } from '../testing.js';
import { checkWordfence, FEED_URL, matches, parseFeed, readFeedState } from './feed.js';
import { compareVersions, inRange, normalizeVersion } from './version.js';

// Four real records (fixtures/README.md).
const FEED_FILE = new URL('./fixtures/feed.json', import.meta.url).pathname;
const FEED = JSON.parse(readFileSync(FEED_FILE, 'utf8')) as Record<string, unknown>;
const BASE = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('../inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);
const T = Date.UTC(2026, 10, 9, 0, 0);
const HOUR = 3_600_000;
const signal = new AbortController().signal;
const SITE = { id: 'kamaji-wp.ddev.site', name: 'Kamaji test' };

const plugin = (slug: string, file: string, version: string, active = true) => ({
  file,
  slug,
  name: slug,
  version,
  active,
  auto_update: false,
  offer: null,
});

/** The DDEV site's report, plus what the real records affect: one with a fix, one without. */
function report(changes: { wpvivid?: string; core?: string } = {}): CareReport {
  const r = structuredClone(BASE);
  r.plugins.push(
    plugin(
      'wpvivid-backuprestore',
      'wpvivid-backuprestore/wpvivid-backuprestore.php',
      changes.wpvivid ?? '0.9.137',
    ),
    plugin('molie-instructure-canvas-linking-tool', 'molie/molie.php', '0.5', false),
  );
  r.themes.push({
    stylesheet: 'orpheus',
    name: 'Orpheus',
    version: '1.9',
    active: false,
    parent: null,
    auto_update: false,
    offer: null,
  });
  if (changes.core) r.core.version = changes.core;
  return r;
}

function site(db: Db, r: CareReport = report(), at = T) {
  if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(SITE.id)) {
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES (?, ?, 'https://kamaji-wp.ddev.site/', 'other', 'connected', 'done', ?)`,
    ).run(SITE.id, SITE.name, T);
  }
  storeReport(db, SITE, r, at);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: SITE.id,
    check: 'report',
    source: 'plugin',
    at,
    ok: true,
    value: {
      ok: true,
      refreshed: true,
      locale: 'en_US',
      php: r.php,
      database: r.database.server,
      checkedAt: r.checked_at,
      siteHealth: [],
      counts: { plugins: r.plugins.length, themes: r.themes.length, offers: 1 },
    },
  });
}

const load = (db: Db, now = T) =>
  checkWordfence(db, {
    apiKey: undefined,
    feedPath: '',
    localFile: FEED_FILE,
    now: () => now,
    signal,
  });

const openIssues = (db: Db) =>
  db
    .prepare('SELECT kind, severity, summary FROM issues WHERE resolved_at IS NULL ORDER BY kind')
    .all();

describe('versions, as PHP compares them', () => {
  it('orders the cases WordPress versions meet', () => {
    const sorted = ['1.0', '1.0.1', '1.0rc1', '1.0.0', '1.0-beta2', '1.0beta10', '0.9', '1.0-dev'];
    expect(sorted.sort(compareVersions)).toEqual([
      '0.9',
      '1.0-dev',
      '1.0-beta2',
      '1.0beta10',
      '1.0rc1',
      '1.0',
      '1.0.0',
      '1.0.1',
    ]);
    expect(compareVersions('5.10', '5.9')).toBe(1);
    expect(compareVersions('6.4.2', '6.4.2')).toBe(0);
  });

  it('reads the feed’s “v” prefixes and BulletProof Security’s leading dots', () => {
    expect(normalizeVersion('v1.3.16')).toBe('1.3.16');
    expect(normalizeVersion('v.1.1')).toBe('1.1');
    expect(normalizeVersion('.53.4')).toBe('0.53.4');
    expect(compareVersions('1.3.15', 'v1.3.16')).toBe(-1);
    expect(compareVersions('.53.3', '.53.4')).toBe(-1);
    // Today's BulletProof Security 6.x isn't caught by a range ending at .53.4.
    expect(compareVersions('6.3', '.53.4')).toBe(1);
  });

  it('reads open-ended and exclusive ranges', () => {
    const upTo = (to: string, inclusive: boolean) => ({
      from_version: '*',
      from_inclusive: true,
      to_version: to,
      to_inclusive: inclusive,
    });
    expect(inRange('5.3', upTo('5.3', true))).toBe(true);
    expect(inRange('5.3', upTo('5.3', false))).toBe(false);
    expect(inRange('5.3.1', upTo('5.3', true))).toBe(false);
    const from = {
      from_version: '6.0',
      from_inclusive: false,
      to_version: '*',
      to_inclusive: true,
    };
    expect(inRange('6.0', from)).toBe(false);
    expect(inRange('6.0.1', from)).toBe(true);
  });
});

describe('the feed', () => {
  it('reads the real records, and skips what it doesn’t know rather than guessing', () => {
    const real = parseFeed(FEED);
    expect(real).toMatchObject({ records: 4, skipped: 0 });
    expect(real.rows.map((r) => [r.softwareType, r.slug, r.patched, r.patchedVersions])).toEqual([
      ['plugin', 'wpvivid-backuprestore', true, ['0.9.138']],
      ['plugin', 'molie-instructure-canvas-linking-tool', false, []],
      ['core', 'wordpress', true, ['3.3.1']],
      ['theme', 'orpheus', false, []],
    ]);
    expect(real.rows[0]?.reference).toContain('wordfence.com/threat-intel');

    const odd = parseFeed({
      ...FEED,
      untitled: { id: 'x', software: [] },
      library: {
        id: 'y',
        title: 'A library',
        software: [{ type: 'library', slug: 'z', affected_versions: {} }],
      },
    });
    expect(odd).toMatchObject({ records: 5, skipped: 2 });
  });

  it('merges a product listed once per release line, keeping every range and fix', () => {
    const range = (from: string, to: string) => ({
      from_version: from,
      from_inclusive: true,
      to_version: to,
      to_inclusive: false,
    });
    const entry = (from: string, to: string) => ({
      type: 'plugin',
      name: 'Lines',
      slug: 'lines',
      affected_versions: { [`[${from}, ${to})`]: range(from, to) },
      patched: true,
      patched_versions: [to],
      remediation: 'Update',
    });
    const { rows } = parseFeed({
      r: { id: 'r', title: 'Lines', software: [entry('12', '12.1.0'), entry('16', '16.0.8')] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.affected).toHaveLength(2);
    expect(rows[0]?.patchedVersions).toEqual(['12.1.0', '16.0.8']);
  });

  it('matches only what’s installed at an affected version', async () => {
    const db = testDb();
    site(db);
    await load(db);
    // wpvivid 0.9.137 (fixed in 0.9.138) and molie 0.5 (no fix) are affected; WordPress 7.1.4
    // and Orpheus 1.9 aren't.
    expect(
      matches(db)
        .map((m) => [m.slug, m.version, m.fixedIn])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['molie-instructure-canvas-linking-tool', '0.5', null],
      ['wpvivid-backuprestore', '0.9.137', '0.9.138'],
    ]);
  });

  it('reuses its matching only while nothing it depends on has changed', async () => {
    const db = testDb();
    site(db);
    await load(db);
    const slugs = () =>
      matches(db)
        .map((m) => `${m.siteName}:${m.slug}:${m.version}`)
        .sort();
    expect(slugs()).toEqual([
      'Kamaji test:molie-instructure-canvas-linking-tool:0.5',
      'Kamaji test:wpvivid-backuprestore:0.9.137',
    ]);
    // A report at the same moment with a fixed version: no stale match.
    site(db, report({ wpvivid: '0.9.138' }));
    expect(slugs()).toEqual(['Kamaji test:molie-instructure-canvas-linking-tool:0.5']);
    // A rename shows in the matches (issue summaries use the name).
    db.prepare('UPDATE sites SET name = ? WHERE id = ?').run('Renamed', SITE.id);
    expect(slugs()).toEqual(['Renamed:molie-instructure-canvas-linking-tool:0.5']);
    // The feed reloaded without the record: the match goes.
    db.prepare(
      "DELETE FROM vulnerabilities WHERE slug = 'molie-instructure-canvas-linking-tool'",
    ).run();
    expect(slugs()).toEqual([]);
    await load(db, T + 2 * 86_400_000);
    expect(slugs()).toEqual(['Renamed:molie-instructure-canvas-linking-tool:0.5']);
    // A removed site has none.
    db.prepare('UPDATE sites SET removed_at = ? WHERE id = ?').run(T, SITE.id);
    expect(slugs()).toEqual([]);
  });

  it('matches WordPress itself', async () => {
    const db = testDb();
    site(db, report({ core: '3.3' }));
    await load(db);
    expect(matches(db).find((m) => m.type === 'core')).toMatchObject({
      version: '3.3',
      fixedIn: '3.3.1',
    });
  });

  it('shows an informational record but never raises it', async () => {
    const db = testDb();
    site(db);
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-wordfence-'));
    const file = join(dir, 'feed.json');
    const all = {
      from_version: '*',
      from_inclusive: true,
      to_version: '*',
      to_inclusive: true,
    };
    writeFileSync(
      file,
      JSON.stringify({
        note: {
          id: 'note',
          title: 'WordPress Core - All Known Versions - An informational note',
          informational: true,
          software: [
            {
              type: 'core',
              name: 'WordPress',
              slug: 'wordpress',
              affected_versions: { '*': all },
              patched: false,
              patched_versions: [],
              remediation: 'No known patch available.',
            },
          ],
        },
      }),
    );
    await checkWordfence(db, {
      apiKey: undefined,
      feedPath: '',
      localFile: file,
      now: () => Date.now(),
      signal,
    });
    const inventory = siteInventory(db, { id: SITE.id, mode: 'connected' });
    expect(inventory.known && inventory.value.core.vulnerabilities).toEqual([
      expect.objectContaining({ informational: true, fixedIn: null }),
    ]);
    expect(openIssues(db)).toEqual([]);
  });

  it('shows matches in the inventory, and unknown rather than none before any feed', async () => {
    const db = testDb();
    site(db);
    const before = siteInventory(db, { id: SITE.id, mode: 'connected' });
    expect(before.known && before.value.vulnerabilityData).toEqual({
      known: false,
      reason: 'No Wordfence data yet: vulnerabilities are unknown',
    });
    await load(db, Date.now());
    const after = siteInventory(db, { id: SITE.id, mode: 'connected' });
    const value = after.known ? after.value : null;
    expect(value?.vulnerabilityData).toMatchObject({ known: true, value: { stale: false } });
    expect(value?.plugins.find((p) => p.slug === 'wpvivid-backuprestore')?.vulnerabilities).toEqual(
      [expect.objectContaining({ fixedIn: '0.9.138', cvssRating: 'Medium' })],
    );
    expect(value?.core.vulnerabilities).toEqual([]);
  });

  it('raises one issue per component: urgent with a fix, never naming it', async () => {
    const db = testDb();
    site(db);
    await load(db);
    expect(openIssues(db)).toEqual([
      {
        kind: 'vulnerable:plugin:molie/molie.php',
        severity: 'normal',
        summary: 'Kamaji test: a plugin has a known vulnerability, with no fix yet',
      },
      {
        kind: 'vulnerable:plugin:wpvivid-backuprestore/wpvivid-backuprestore.php',
        severity: 'urgent',
        summary:
          'Kamaji test: a plugin has a known vulnerability, with a fix WordPress isn’t offering yet',
      },
    ]);

    // The done test, in miniature: one vulnerable plugin with a fix, one alert.
    const sent: string[] = [];
    const discord: Discord = {
      configured: true,
      send: async (message) => {
        sent.push(message);
        return true;
      },
    };
    const options = { kamajiUrl: 'https://kamaji.test', workerAlerts: true, digestAt: '07:30' };
    await notifyNow(db, T, discord, options);
    await notifyNow(db, T + HOUR, discord, options);
    expect(sent).toEqual([
      '**Kamaji**\n- Kamaji test: a plugin has a known vulnerability, with a fix WordPress isn’t offering yet\n<https://kamaji.test>',
    ]);

    // Updating to the fix resolves it on the next cycle.
    site(db, report({ wpvivid: '0.9.138' }), T + 2 * HOUR);
    await load(db, T + 2 * HOUR);
    expect(openIssues(db).map((i) => i.kind)).toEqual(['vulnerable:plugin:molie/molie.php']);
  });

  it('downloads once a day with the key, and says when the key is refused', async () => {
    const db = testDb();
    site(db);
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-wordfence-'));
    const seen: { url: string; auth: string | null }[] = [];
    let status = 200;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
      return new Response(status === 200 ? JSON.stringify(FEED) : '{}', { status });
    }) as typeof fetch;
    const logged: string[] = [];
    const run = (now: number) =>
      checkWordfence(db, {
        apiKey: 'test-key',
        feedPath: join(dir, 'feed.json'),
        now: () => now,
        signal,
        fetch: fake,
        log: (line) => logged.push(line),
      });

    await run(T);
    await run(T + HOUR);
    expect(seen).toEqual([{ url: FEED_URL, auth: 'Bearer test-key' }]);
    expect(readFeedState(db)).toMatchObject({ lastSuccessAt: T, records: 4, problem: null });

    // A day on, Wordfence refuses: the old data stays and the problem is kept, without the key.
    status = 401;
    await run(T + 25 * HOUR);
    expect(readFeedState(db)).toMatchObject({
      lastSuccessAt: T,
      problem: 'Wordfence refused the API key (HTTP 401)',
    });
    expect(JSON.stringify(readFeedState(db))).not.toContain('test-key');
    expect(logged).toEqual([
      'wordfence: 4 records, 0 skipped',
      `wordfence: Wordfence refused the API key (HTTP 401); next try ${new Date(T + 31 * HOUR)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')} UTC`,
    ]);
    expect(matches(db)).toHaveLength(2);

    // Retried 6 hours later, not every cycle; stale after two days says so.
    await run(T + 26 * HOUR);
    expect(seen).toHaveLength(2);
    await run(T + 49 * HOUR);
    expect(seen).toHaveLength(3);
    expect(openIssues(db).find((i) => i.kind === 'feed-stale')).toEqual({
      kind: 'feed-stale',
      severity: 'normal',
      summary:
        'The Wordfence vulnerability data is 2 days old: Wordfence refused the API key (HTTP 401)',
    });
    status = 200;
    await run(T + 56 * HOUR);
    expect(openIssues(db).find((i) => i.kind === 'feed-stale')).toBeUndefined();
  });
});
