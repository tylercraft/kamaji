import { describe, expect, it } from 'vitest';
import { checkPages, pageUrl, readPages } from './pages.js';

const SITE = 'https://minton.test/';

describe('pages to check', () => {
  it('takes a path or a full https address on the site’s own host, www or not', () => {
    expect(pageUrl('/shop/', SITE)).toBe('https://minton.test/shop/');
    expect(pageUrl('contact', SITE)).toBe('https://minton.test/contact');
    expect(pageUrl('https://www.minton.test/about?x=1#team', SITE)).toBe(
      'https://www.minton.test/about?x=1',
    );
  });

  it('refuses anywhere else, and anything not https', () => {
    expect(pageUrl('https://evil.test/shop/', SITE)).toBeNull();
    expect(pageUrl('https://minton.test.evil.test/', SITE)).toBeNull();
    expect(pageUrl('https://shop.minton.test/', SITE)).toBeNull();
    expect(pageUrl('http://minton.test/shop/', SITE)).toBeNull();
    expect(pageUrl('https://minton.test:8443/', SITE)).toBeNull();
    expect(pageUrl('https://user:pw@minton.test/', SITE)).toBeNull();
    expect(pageUrl('//evil.test/x', SITE)).toBeNull();
    expect(pageUrl('javascript:alert(1)', SITE)).toBeNull();
    // A path on a site that's only on http isn't https either.
    expect(pageUrl('/shop/', 'http://plain.test/')).toBeNull();
  });

  it('keeps up to five, each with its own text, skipping blanks and repeats', () => {
    expect(
      checkPages(
        [
          { page: '/shop/', expectedText: ' Add to cart ' },
          { page: '', expectedText: 'ignored' },
          { page: 'https://minton.test/shop/', expectedText: null },
          { page: '/contact/', expectedText: '' },
        ],
        SITE,
      ),
    ).toEqual({
      ok: true,
      pages: [
        { url: 'https://minton.test/shop/', expectedText: 'Add to cart' },
        { url: 'https://minton.test/contact/', expectedText: null },
      ],
    });
    expect(
      checkPages(
        Array.from({ length: 6 }, (_, i) => ({ page: `/p${i}/`, expectedText: null })),
        SITE,
      ),
    ).toEqual({ ok: false, refused: 'more than 5 pages' });
    expect(checkPages([{ page: 'https://evil.test/', expectedText: null }], SITE)).toEqual({
      ok: false,
      refused: 'https://evil.test/',
    });
  });

  it('still reads the first shape, a list of paths, as pages without text', () => {
    expect(readPages('["/shop/", "/contact/"]', SITE)).toEqual([
      { url: 'https://minton.test/shop/', expectedText: null },
      { url: 'https://minton.test/contact/', expectedText: null },
    ]);
    expect(
      readPages(
        JSON.stringify([
          { url: 'https://minton.test/shop/', expectedText: 'Cart' },
          { url: 'https://evil.test/', expectedText: null },
        ]),
        SITE,
      ),
    ).toEqual([{ url: 'https://minton.test/shop/', expectedText: 'Cart' }]);
    expect(readPages('not json', SITE)).toEqual([]);
    expect(readPages('[]', SITE)).toEqual([]);
  });
});
