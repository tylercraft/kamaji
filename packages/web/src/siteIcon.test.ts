import { describe, expect, it } from 'vitest';
import { iconLetter } from './components/SiteIcon';

describe('the icon’s fallback letter', () => {
  it('is the site name’s first letter or digit', () => {
    expect(iconLetter('Aleya Hoerlein')).toBe('A');
    expect(iconLetter('photogravure')).toBe('P');
    expect(iconLetter('“Quoted” Studio')).toBe('Q');
    expect(iconLetter('1st Avenue')).toBe('1');
  });

  it('is blank until the names have loaded, or for a name with no letters', () => {
    expect(iconLetter(undefined)).toBe('');
    expect(iconLetter('—')).toBe('');
  });
});
