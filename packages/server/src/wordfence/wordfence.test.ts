import { mkdtempSync, readFileSync } from 'node:fs';
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
import { compareVersions, inRange } from './version.js';

const FEED_FILE = new URL('./fixtures/feed.json', import.meta.url).pathname;
const FEED = JSON.parse(readFileSync(FEED_FILE, 'utf8')) as unknown;
const REPORT = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('../inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);
const T = Date.UTC(2026, 10, 9, 0, 0);
const HOUR = 3_600_000;
const signal = new AbortController().signal;

function site(db: Db) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES ('kamaji-wp.ddev.site', 'Kamaji test', 'https://kamaji-wp.ddev.site/', 'other',
     'connected', 'done', ?)`,
  ).run(T);
  storeReport(db, { id: 'kamaji-wp.ddev.site', name: 'Kamaji test' }, REPORT, T);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: 'kamaji-wp.ddev.site',
    check: 'report',
    source: 'plugin',
    at: T,
    ok: true,
    value: {
      ok: true,
      refreshed: true,
      locale: 'en_US',
      php: REPORT.php,
      database: REPORT.database.server,
      checkedAt: REPORT.checked_at,
      siteHealth: [],
      counts: { plugins: 3, themes: 2, offers: 1 },
    },
  });
}

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
  it('reads every record it understands and counts the rest', () => {
    const { rows, records, skipped } = parseFeed(FEED);
    expect(records).toBe(4);
    expect(skipped).toBe(2); // the record without a title, and the "library" software
    expect(rows.map((r) => [r.softwareType, r.slug, r.patched])).toEqual([
      ['plugin', 'akismet', true],
      ['plugin', 'hello-dolly', false],
      ['core', 'wordpress', true],
      ['theme', 'twentytwentyfour', true],
    ]);
    expect(rows[0]?.reference).toContain('wordfence.com/threat-intel');
  });

  it('matches only what’s installed at an affected version', async () => {
    const db = testDb();
    site(db);
    await checkWordfence(db, {
      apiKey: undefined,
      feedPath: '',
      localFile: FEED_FILE,
      now: () => T,
      signal,
    });
    // Akismet 5.3 and Hello Dolly 1.7.2 are affected; WordPress 7.1.4 and Twenty Twenty-Four 1.6 aren't.
    expect(matches(db).map((m) => [m.slug, m.version, m.fixedIn])).toEqual([
      ['akismet', '5.3', '5.3.1'],
      ['hello-dolly', '1.7.2', null],
    ]);
  });

  it('shows matches in the inventory, and unknown rather than none before any feed', async () => {
    const db = testDb();
    site(db);
    const before = siteInventory(db, { id: 'kamaji-wp.ddev.site', mode: 'connected' });
    expect(before.known && before.value.vulnerabilityData).toEqual({
      known: false,
      reason: 'No Wordfence data yet: vulnerabilities are unknown',
    });
    await checkWordfence(db, {
      apiKey: undefined,
      feedPath: '',
      localFile: FEED_FILE,
      now: () => Date.now(),
      signal,
    });
    const after = siteInventory(db, { id: 'kamaji-wp.ddev.site', mode: 'connected' });
    const value = after.known ? after.value : null;
    expect(value?.vulnerabilityData).toMatchObject({ known: true, value: { stale: false } });
    expect(value?.plugins.find((p) => p.slug === 'akismet')?.vulnerabilities).toEqual([
      expect.objectContaining({ fixedIn: '5.3.1', cvssRating: 'Medium', cve: 'CVE-0000-00001' }),
    ]);
    expect(value?.core.vulnerabilities).toEqual([]);
  });

  it('raises one issue per component: urgent with a fix, never naming it', async () => {
    const db = testDb();
    site(db);
    await checkWordfence(db, {
      apiKey: undefined,
      feedPath: '',
      localFile: FEED_FILE,
      now: () => T,
      signal,
    });
    expect(openIssues(db)).toEqual([
      {
        kind: 'vulnerable:plugin:akismet/akismet.php',
        severity: 'urgent',
        summary: 'Kamaji test: a plugin has a known vulnerability, with a fix to update to',
      },
      {
        kind: 'vulnerable:plugin:hello-dolly/hello.php',
        severity: 'normal',
        summary: 'Kamaji test: a plugin has a known vulnerability, with no fix yet',
      },
    ]);

    // The done test, in miniature: one vulnerable plugin, one alert.
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
      '**Kamaji**\n- Kamaji test: a plugin has a known vulnerability, with a fix to update to\n<https://kamaji.test>',
    ]);

    // Updating past the fix resolves it on the next cycle.
    const updated = structuredClone(REPORT);
    updated.plugins[0]!.version = '5.3.1';
    storeReport(db, { id: 'kamaji-wp.ddev.site', name: 'Kamaji test' }, updated, T + 2 * HOUR);
    await checkWordfence(db, {
      apiKey: undefined,
      feedPath: '',
      localFile: FEED_FILE,
      now: () => T + 2 * HOUR,
      signal,
    });
    expect(openIssues(db).map((i) => i.kind)).toEqual(['vulnerable:plugin:hello-dolly/hello.php']);
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
    const run = (now: number) =>
      checkWordfence(db, {
        apiKey: 'test-key',
        feedPath: join(dir, 'feed.json'),
        now: () => now,
        signal,
        fetch: fake,
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
