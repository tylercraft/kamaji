import { describe, expect, it } from 'vitest';
import {
  applyOne,
  applyResults,
  checkSite,
  emptyState,
  HISTORY,
  message,
  parseSites,
  REMIND_MS,
  tokenMatches,
} from './watch.js';

const site = { id: 'a.test', name: 'Alpha', url: 'https://a.test/', expectedText: 'Hello' };
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 9);
const ok = (t) => ({ t, ok: true, status: 200, ms: 200, problem: null });
const bad = (t) => ({ t, ok: false, status: 503, ms: 90, problem: 'HTTP 503' });

/** Runs passes with the given results for Alpha, five minutes apart; returns every line posted. */
function passes(results) {
  let state = { ...emptyState(), sites: [site] };
  const posted = [];
  results.forEach((make, i) => {
    const now = T0 + i * 5 * MIN;
    const out = applyResults(state, { 'a.test': make(now) }, now);
    state = out.state;
    posted.push(...out.lines);
  });
  return { state, posted };
}

describe('applyResults', () => {
  it('alerts once after two failures, and once when back up', () => {
    const { posted } = passes([ok, bad, bad, bad, bad, ok, ok]);
    expect(posted).toEqual(['Alpha is down: HTTP 503', 'Alpha is back up (after 20 min)']);
  });

  it('says nothing about a single failure', () => {
    expect(passes([ok, bad, ok, bad, ok]).posted).toEqual([]);
  });

  it('reminds once a day while down', () => {
    const steps = REMIND_MS / (5 * MIN);
    const { posted } = passes([bad, bad, ...Array(steps).fill(bad)]);
    expect(posted).toEqual(['Alpha is down: HTTP 503', 'Still down after 24 h: Alpha']);
  });

  it('keeps a day of history and drops removed sites', () => {
    const { state } = passes(Array(HISTORY + 10).fill(ok));
    expect(state.results['a.test'].history).toHaveLength(HISTORY);
    const gone = applyResults({ ...state, sites: [] }, {}, T0);
    expect(gone.state.results).toEqual({});
  });
});

describe('checkSite', () => {
  const respond =
    (body, status = 200) =>
    async () =>
      new Response(body, { status });

  it('passes a page with the expected text', async () => {
    expect(await checkSite(site, { fetch: respond('<h1>Hello</h1>') })).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it('fails a missing text, a PHP error, a bad status and no connection', async () => {
    const problems = await Promise.all([
      checkSite(site, { fetch: respond('Parked') }),
      checkSite(site, { fetch: respond('Hello <b>Fatal error</b>: x') }),
      checkSite(site, { fetch: respond('Hello', 500) }),
      checkSite(site, {
        fetch: async () => {
          throw new TypeError('network');
        },
      }),
    ]);
    expect(problems.map((r) => r.problem)).toEqual([
      'The expected text is missing',
      'The page shows a PHP error',
      'HTTP 500',
      'Couldn’t connect',
    ]);
  });
});

describe('parseSites', () => {
  it('accepts Kamaji’s list and refuses anything odd', () => {
    expect(parseSites([site])).toEqual([site]);
    expect(() => parseSites([{ ...site, url: 'http://a.test/' }])).toThrow('https');
    expect(() => parseSites([{ ...site, id: '' }])).toThrow('id');
    expect(() => parseSites({})).toThrow('list');
  });
});

describe('message and token', () => {
  it('posts labels and a link, or nothing', () => {
    expect(message([], 'https://k.test')).toBe(null);
    expect(message(['Alpha is down: HTTP 503'], 'https://k.test')).toBe(
      '**Kamaji (outside check)**\n- Alpha is down: HTTP 503\n<https://k.test>',
    );
  });

  it('matches only the exact token', async () => {
    expect(await tokenMatches('abc', 'abc')).toBe(true);
    expect(await tokenMatches('abd', 'abc')).toBe(false);
    expect(await tokenMatches('', 'abc')).toBe(false);
    expect(await tokenMatches('abc', undefined)).toBe(false);
  });
});

describe('applyOne', () => {
  it('folds in one site’s check without claiming a pass', () => {
    const sites = [
      { id: 'a', name: 'A', url: 'https://a.test/', expectedText: null },
      { id: 'b', name: 'B', url: 'https://b.test/', expectedText: null },
    ];
    const state = { ...emptyState(), sites, checkedAt: 1000 };
    const { state: next, lines } = applyOne(
      state,
      'a',
      { t: 2000, ok: false, status: 503, ms: 10, problem: 'HTTP 503' },
      2000,
    );
    expect(next.checkedAt).toBe(1000);
    expect(next.results.a.failures).toBe(1);
    expect(next.results.b).toEqual({ history: [], failures: 0, downSince: null, alertedAt: null });
    expect(lines).toEqual([]);
  });
});
