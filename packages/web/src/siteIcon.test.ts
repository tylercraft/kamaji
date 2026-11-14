import { describe, expect, it } from 'vitest';
import { iconLetter } from './components/SiteIcon';

describe('the icon’s fallback letter', () => {
  it('is the domain’s first letter, without www', () => {
    expect(iconLetter('aleyahoerlein.com')).toBe('A');
    expect(iconLetter('www.photogravure.com')).toBe('P');
    expect(iconLetter('')).toBe('?');
  });
});
