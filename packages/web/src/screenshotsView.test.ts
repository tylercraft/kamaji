import type { ComparisonView, ShotView } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { ordered, pageLabel, runSummary, setWords, tileWords } from './screenshotsView';

const shot = (o: Partial<ShotView> = {}): ShotView => ({
  id: 1,
  pageUrl: 'https://one.test/',
  viewport: 'desktop',
  image: '/api/screenshots/s/r1-p0-desktop.png',
  thumb: '/api/screenshots/s/r1-p0-desktop.jpg',
  width: 1440,
  height: 2000,
  cut: false,
  quiet: true,
  status: 200,
  blocked: false,
  jsErrors: 0,
  failedRequests: 0,
  blockedRequests: 0,
  problem: null,
  ...o,
});
const cmp = (o: Partial<ComparisonView> = {}): ComparisonView => ({
  pageUrl: 'https://one.test/',
  viewport: 'desktop',
  compared: 'page',
  changedPct: 0,
  maskedPct: 0,
  heightBefore: 2000,
  heightAfter: 2000,
  newJsErrors: 0,
  newFailedRequests: 0,
  diff: null,
  before: shot(),
  after: shot(),
  problem: null,
  ...o,
});
const done = { state: 'done' as const, problem: null };

describe('screenshots in words', () => {
  it('names a page by its path, the home page as Home', () => {
    expect(pageLabel('https://one.test/')).toBe('Home');
    expect(pageLabel('https://one.test/shop/')).toBe('/shop/');
  });

  it('says what one page and size did', () => {
    expect(tileWords(cmp({ changedPct: 3.14 }))).toBe('3.1% changed');
    expect(tileWords(cmp({ changedPct: 0 }))).toBe('no change');
    expect(
      tileWords(
        cmp({ compared: 'first screen', heightAfter: 2340, changedPct: 12, newJsErrors: 2 }),
      ),
    ).toBe('340 px taller, 12% changed, 2 new JavaScript errors');
    expect(
      tileWords(
        cmp({ compared: 'none', after: shot({ image: null, blocked: true }), changedPct: null }),
      ),
    ).toBe('bot check');
  });

  it('a run with nothing changed is one line; with changes, the most changed is named', () => {
    const quiet = [cmp(), cmp({ viewport: 'mobile', changedPct: 0.4 })];
    expect(runSummary({ before: done, after: done, comparisons: quiet })).toEqual({
      words: '1 page at 2 sizes, no change over 1%.',
      changed: false,
    });
    const shop = 'https://one.test/shop/';
    const busy = [
      cmp({ changedPct: 2 }),
      cmp({ pageUrl: shop, viewport: 'mobile', changedPct: 9.5 }),
      cmp({ pageUrl: shop }),
    ];
    expect(runSummary({ before: done, after: done, comparisons: busy }).words).toBe(
      '2 pages at 2 sizes. 2 changed; the most: /shop/, mobile, 9.5% changed.',
    );
    expect(ordered(busy).map((c) => c.changedPct)).toEqual([9.5, 2, 0]);
  });

  it('says why a run has nothing to compare, and when it’s still shooting', () => {
    expect(
      runSummary({
        before: { state: 'failed', problem: 'Docker isn’t answering' },
        after: done,
        comparisons: [],
      }).words,
    ).toBe('Screenshots weren’t compared: Docker isn’t answering.');
    expect(
      runSummary({ before: { state: 'running', problem: null }, after: null, comparisons: [] })
        .words,
    ).toBe('Taking the “before” screenshots…');
  });

  it('says how a set went', () => {
    const set = {
      id: 'a',
      kind: 'manual' as const,
      requestedAt: '2026-11-19T03:00:00.000Z',
      requestedBy: null,
      finishedAt: null,
      problem: null,
      shots: [],
      comparisons: [],
    };
    expect(setWords({ ...set, state: 'done' })).toBe('Taken by hand.');
    expect(setWords({ ...set, state: 'failed', problem: 'Docker isn’t answering' })).toBe(
      'Couldn’t take them: Docker isn’t answering.',
    );
  });
});
