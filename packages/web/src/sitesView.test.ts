import { describe, expect, it } from 'vitest';
import { filterSites, matchesSite, NO_FILTERS, present, type SiteFilters } from './sitesView';

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
