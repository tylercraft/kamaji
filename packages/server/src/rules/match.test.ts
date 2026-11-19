import { readFileSync } from 'node:fs';
import type { RuleBody } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { changeKind, DAY, matchItem, ruleWords, type Candidate } from './match.js';
import { NOT_LISTED, orgLookup, pluginReleased, readAnswer, themeReleased } from './org.js';

const NOW = Date.UTC(2026, 10, 19, 6, 0);

const RULE: RuleBody = {
  ruleId: null,
  name: 'Minor plugin updates on my sites',
  sites: [{ id: 'one.test', url: 'https://one.test/', backup: 'host' }],
  types: ['plugin'],
  only: [],
  leaveOut: ['woocommerce'],
  change: 'minor',
  waitDays: 3,
  securityWaitDays: 0,
  when: { weekday: 2, hour: 19 },
  most: { perSite: 10, sites: 10 },
};

const AKISMET: Candidate = {
  siteId: 'one.test',
  type: 'plugin',
  slug: 'akismet',
  from: '5.3',
  to: '5.7.2',
  package: true,
  security: false,
  release: { version: '5.7.2', at: NOW - 4 * DAY },
  rolledBack: false,
};

const why = (rule: RuleBody, c: Partial<Candidate>) => {
  const v = matchItem(rule, { ...AKISMET, ...c }, NOW);
  return v.ok ? 'takes it' : v.why;
};

describe('how big a change is', () => {
  it('by its first, second and later parts, a missing part as 0', () => {
    expect(changeKind('5.3', '5.7.2')).toBe('minor');
    expect(changeKind('5.3', '5.3.1')).toBe('patch');
    expect(changeKind('1.2.3', '1.2.4')).toBe('patch');
    expect(changeKind('1.2.3.4', '1.2.3.5')).toBe('patch');
    expect(changeKind('22.9', '23.0')).toBe('major');
    // Dated versions: a new year is a major.
    expect(changeKind('2025.12.1', '2026.1.0')).toBe('major');
    expect(changeKind('2026.1.0', '2026.1.2')).toBe('patch');
    expect(changeKind('5.7.2', '5.7.2')).toBe('not newer');
    expect(changeKind('5.7.2', '5.3')).toBe('not newer');
  });
});

describe('what a rule takes', () => {
  it('a minor plugin update on its site, released long enough ago', () => {
    expect(why(RULE, {})).toBe('takes it');
  });

  it('never core, Craftish Care, a major, or a theme it doesn’t cover', () => {
    expect(why(RULE, { type: 'core', slug: 'core', from: '7.1.3', to: '7.1.4' })).toBe(
      'a rule never updates WordPress itself',
    );
    expect(why({ ...RULE, types: ['plugin', 'theme'] }, { slug: 'craftish-care' })).toBe(
      'Craftish Care updates only from its own channel',
    );
    expect(why(RULE, { to: '6.0', release: { version: '6.0', at: 0 } })).toBe('a major version');
    expect(why(RULE, { type: 'theme', slug: 'twentytwentyfour' })).toBe(
      'the rule doesn’t cover themes',
    );
  });

  it('nothing on a site it doesn’t name', () => {
    expect(why(RULE, { siteId: 'two.test' })).toBe('the rule doesn’t name this site');
  });

  it('what it leaves out, only what it names, and patches only when it says so', () => {
    expect(why(RULE, { slug: 'woocommerce' })).toBe('the rule leaves it out');
    expect(why({ ...RULE, only: ['wordpress-seo'] }, {})).toBe(
      'the rule names other plugins and themes',
    );
    expect(why({ ...RULE, change: 'patch' }, {})).toBe(
      'a minor version, and the rule takes patches only',
    );
    expect(
      why({ ...RULE, change: 'patch' }, { to: '5.3.1', release: { version: '5.3.1', at: 0 } }),
    ).toBe('takes it');
    expect(why({ ...RULE, change: 'security' }, {})).toBe('not a security fix');
  });

  it('nothing without a package, rolled back from, or not newer', () => {
    expect(why(RULE, { package: false })).toBe('WordPress offers it without a package');
    expect(why(RULE, { rolledBack: true })).toBe('Kamaji rolled it back from this version');
    expect(why(RULE, { to: '5.3' })).toBe('the offer isn’t newer than what’s installed');
  });

  it('waits its days after wordpress.org’s release, a security fix its own', () => {
    const fresh = { release: { version: '5.7.2', at: NOW - DAY - 60_000 } };
    expect(why(RULE, fresh)).toBe('out 1 day; the rule waits 3 days');
    expect(why(RULE, { ...fresh, security: true })).toBe('takes it');
    expect(why({ ...RULE, securityWaitDays: 2 }, { ...fresh, security: true })).toBe(
      'out 1 day; the rule waits 2 days for a security fix',
    );
    expect(why(RULE, { release: { version: '5.7.2', at: NOW - 3 * DAY } })).toBe('takes it');
  });

  it('nothing wordpress.org doesn’t list, or whose latest isn’t the offer', () => {
    expect(why(RULE, { release: NOT_LISTED })).toBe(NOT_LISTED);
    expect(why(RULE, { security: true, release: NOT_LISTED })).toBe(NOT_LISTED);
    expect(why(RULE, { release: { version: '5.8', at: 0 } })).toBe(
      'wordpress.org’s latest is 5.8, not the version offered',
    );
  });

  it('reads as a sentence', () => {
    expect(ruleWords(RULE, new Map([['one.test', 'One']]))).toBe(
      'Patch and minor updates to any plugin, except woocommerce, on One, 3 days after wordpress.org releases them (security fixes at once). Set out with “Ready to update” on Tuesdays at 19:00, run from 20:00.',
    );
  });
});

describe('wordpress.org’s answers', () => {
  const fixture = (name: string) =>
    JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

  it('a plugin: its version, and last_updated in GMT', () => {
    expect(readAnswer('plugin', 200, fixture('org-plugin.json'))).toEqual({
      version: '5.7.2',
      at: Date.UTC(2026, 7, 18, 23, 42),
    });
    expect(pluginReleased('2026-08-18 12:05am GMT')).toBe(Date.UTC(2026, 7, 18, 0, 5));
    expect(pluginReleased('2026-08-18 12:05pm GMT')).toBe(Date.UTC(2026, 7, 18, 12, 5));
    expect(pluginReleased('18 August 2026')).toBeNull();
  });

  it('a theme: its time read as 14 hours later than UTC, so the wait is never short', () => {
    expect(readAnswer('theme', 200, fixture('org-theme.json'))).toEqual({
      version: '1.6',
      at: Date.UTC(2026, 7, 19, 22, 52, 41) + 14 * 60 * 60_000,
    });
    expect(themeReleased('2026-08-19')).toBeNull();
  });

  it('not listed, and anything else as not asked', () => {
    expect(readAnswer('plugin', 404, fixture('org-plugin-missing.json'))).toBe(NOT_LISTED);
    expect(readAnswer('theme', 404, fixture('org-theme-missing.json'))).toBe(NOT_LISTED);
    expect(readAnswer('plugin', 500, null)).toMatch(/couldn’t be asked/);
    expect(readAnswer('plugin', 200, { version: '1.0' })).toMatch(/couldn’t be asked/);
  });

  it('asks with the slug and nothing else, and keeps answers only as long as told', async () => {
    const asked: string[] = [];
    let t = 0;
    const lookup = orgLookup(
      (async (url: URL) => {
        asked.push(String(url));
        return new Response(JSON.stringify(fixture('org-plugin.json')), { status: 200 });
      }) as unknown as typeof fetch,
      { ttlMs: 1000, now: () => t },
    );
    await lookup('plugin', 'akismet');
    await lookup('plugin', 'akismet');
    t = 2000;
    await lookup('plugin', 'akismet');
    expect(asked).toHaveLength(2);
    const u = new URL(asked[0]!);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.wordpress.org/plugins/info/1.2/');
    expect(u.searchParams.get('request[slug]')).toBe('akismet');
    expect(u.searchParams.get('action')).toBe('plugin_information');
  });
});
