import { describe, expect, it } from 'vitest';
import { matchesSite } from './sitesView';

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
