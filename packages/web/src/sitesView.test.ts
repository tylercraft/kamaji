import type { HostKind, Platform } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import {
  filterSites,
  groupSites,
  readGroupBy,
  saveGroupBy,
  matchesSite,
  NO_FILTERS,
  present,
  recheckable,
  recheckSummary,
  type SiteFilters,
} from './sitesView';

const site = { name: 'Minton Homes', url: 'https://mintonhomesllc.com/', clientSlug: 'minton' };

describe('the Sites filter', () => {
  it('matches name, domain or client, ignoring case', () => {
    expect(matchesSite(site, 'HOMES')).toBe(true);
    expect(matchesSite(site, 'llc.com')).toBe(true);
    expect(matchesSite({ ...site, name: 'Site' }, 'minton')).toBe(true);
  });

  it('matches everything when nothing is typed, and trims what is', () => {
    expect(matchesSite(site, '')).toBe(true);
    expect(matchesSite(site, '  homes ')).toBe(true);
  });

  it('doesn’t match the scheme, or a site without a client by its client', () => {
    expect(matchesSite(site, 'https')).toBe(false);
    expect(matchesSite({ ...site, clientSlug: null }, 'photogravure')).toBe(false);
  });
});

describe('the Sites filters together', () => {
  const sites = [
    {
      name: 'A',
      url: 'https://a.test/',
      clientSlug: null,
      hostKind: 'craftish',
      mode: 'connected',
    },
    { name: 'B', url: 'https://b.test/', clientSlug: null, hostKind: 'kinsta', mode: 'monitoring' },
    {
      name: 'AB',
      url: 'https://ab.test/',
      clientSlug: null,
      hostKind: 'kinsta',
      mode: 'connected',
    },
  ] as const;
  const names = (f: Partial<SiteFilters>) =>
    filterSites([...sites], { ...NO_FILTERS, ...f }).map((s) => s.name);

  it('combines text, host and mode, and reset shows all', () => {
    expect(names({ typed: 'a', host: 'kinsta' })).toEqual(['AB']);
    expect(names({ host: 'kinsta', mode: 'monitoring' })).toEqual(['B']);
    expect(names({ typed: 'z' })).toEqual([]);
    expect(names(NO_FILTERS)).toEqual(['A', 'B', 'AB']);
  });

  it('offers only the hosts and modes there are', () => {
    expect(present([...sites])).toEqual({
      hosts: ['craftish', 'kinsta'],
      modes: ['connected', 'monitoring'],
    });
  });
});

describe('Recheck all', () => {
  it('counts the sites the server will ask: connected, set up and not paused', () => {
    const at = '2026-11-15T00:00:00.000Z';
    expect(
      recheckable([
        { mode: 'connected', setup: 'done', pausedAt: null },
        { mode: 'connected', setup: 'done', pausedAt: at },
        { mode: 'connected', setup: 'connect', pausedAt: null },
        { mode: 'monitoring', setup: 'done', pausedAt: null },
      ]),
    ).toBe(1);
  });

  it('says how many it rechecked, and names each that failed with why', () => {
    const ok = (name: string) => ({ id: name, name, ok: true, problem: null });
    expect(recheckSummary([ok('A'), ok('B')])).toEqual({ ok: true, message: 'Rechecked 2 sites' });
    expect(recheckSummary([ok('A')]).message).toBe('Rechecked 1 site');
    expect(
      recheckSummary([
        ok('A'),
        { id: 'b', name: 'B', ok: false, problem: 'Couldn’t reach the site' },
      ]),
    ).toEqual({
      ok: false,
      message: 'Rechecked 2 sites. 1 site didn’t report: B (Couldn’t reach the site)',
    });
  });
});

describe('grouping', () => {
  const s = (name: string, platform: Platform, hostKind: HostKind) => ({
    name,
    platform,
    hostKind,
  });
  const sites = [
    s('Romaji', 'static', 'craftish'),
    s('Aleya', 'wordpress', 'craftish'),
    s('Minton', 'wordpress', 'kinsta'),
    s('Ledger', 'app', 'other'),
  ];
  const names = (groups: ReturnType<typeof groupSites<(typeof sites)[number]>>) =>
    groups.map((g) => [g.label, g.sites.map((x) => x.name)]);

  it('goes WordPress, Static, then App, and leaves out an empty group', () => {
    expect(names(groupSites(sites, 'platform'))).toEqual([
      ['WordPress', ['Aleya', 'Minton']],
      ['Static', ['Romaji']],
      ['App', ['Ledger']],
    ]);
    expect(names(groupSites(sites.slice(1, 3), 'platform'))).toEqual([
      ['WordPress', ['Aleya', 'Minton']],
    ]);
  });

  it('groups by host, or not at all', () => {
    expect(names(groupSites(sites, 'host'))).toEqual([
      ['craftish', ['Romaji', 'Aleya']],
      ['Kinsta', ['Minton']],
      ['Other host', ['Ledger']],
    ]);
    expect(names(groupSites(sites, 'none'))).toEqual([
      [null, ['Romaji', 'Aleya', 'Minton', 'Ledger']],
    ]);
    expect(groupSites([], 'none')).toEqual([]);
  });

  it('keeps filtering inside the groups: a filtered list groups the same way', () => {
    const filtered = sites.filter((x) => x.hostKind === 'craftish');
    expect(names(groupSites(filtered, 'platform'))).toEqual([
      ['WordPress', ['Aleya']],
      ['Static', ['Romaji']],
    ]);
  });

  it('remembers the choice in this browser, and falls back to Platform', () => {
    let value: string | null = null;
    const store = { getItem: () => value, setItem: (_: string, v: string) => void (value = v) };
    expect(readGroupBy(store)).toBe('platform');
    saveGroupBy('host', store);
    expect(readGroupBy(store)).toBe('host');
    value = 'colour';
    expect(readGroupBy(store)).toBe('platform');
    expect(readGroupBy(null)).toBe('platform');
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readGroupBy(blocked)).toBe('platform');
    expect(() => saveGroupBy('none', blocked)).not.toThrow();
  });
});
