// When wordpress.org released a plugin or theme's latest version (ops/rules-plan.md): a rule waits
// days after that before it takes an update. Asked of wordpress.org's own API, not read from
// Kamaji's records, so nothing written to the database can make a release look older than it is.
// The answers' shapes are as captured on 2026-11-19 (fixtures/org-*.json).
import type { Release } from './match.js';

const API = {
  plugin: 'https://api.wordpress.org/plugins/info/1.2/',
  theme: 'https://api.wordpress.org/themes/info/1.2/',
};

/** Not listed on wordpress.org: a paid or custom plugin, so no date to go by. */
export const NOT_LISTED = 'wordpress.org doesn’t list it, so how long it’s been out can’t be told';
export const UNREACHABLE = 'wordpress.org couldn’t be asked when it was released';

const MONTHS = 12;

/**
 * A plugin's `last_updated`, "2026-08-18 11:42pm GMT". It moves with any change to the plugin's
 * listing, not only a release, so it can make a release look newer than it is, never older.
 */
export function pluginReleased(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})(am|pm) GMT$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, half] = m;
  const hour = (Number(h) % 12) + (half === 'pm' ? 12 : 0);
  if (Number(mo) < 1 || Number(mo) > MONTHS || hour > 23) return null;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi));
}

/**
 * A theme's `last_updated_time`, "2026-08-19 22:52:41", which doesn't say its zone. Read as UTC
 * and then 14 hours later, the furthest ahead any zone is, so the wait is never shortened.
 */
export function themeReleased(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  if (mo! < 1 || mo! > MONTHS || h! > 23) return null;
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) + 14 * 60 * 60_000;
}

/** What wordpress.org answered, as a release or why there isn't one. */
export function readAnswer(
  type: 'plugin' | 'theme',
  status: number,
  json: unknown,
): Release | string {
  if (status === 404) return NOT_LISTED;
  if (status !== 200 || !json || typeof json !== 'object') return UNREACHABLE;
  const o = json as Record<string, unknown>;
  if (typeof o.version !== 'string') return UNREACHABLE;
  const at =
    type === 'plugin'
      ? typeof o.last_updated === 'string'
        ? pluginReleased(o.last_updated)
        : null
      : typeof o.last_updated_time === 'string'
        ? themeReleased(o.last_updated_time)
        : null;
  return at === null ? UNREACHABLE : { version: o.version, at };
}

export type OrgLookup = (type: 'plugin' | 'theme', slug: string) => Promise<Release | string>;

/**
 * Asks wordpress.org, with only the slug: nothing about the site. `ttlMs` keeps answers that
 * long (the app's preview); the updater asks afresh each run.
 */
export function orgLookup(
  fetcher: typeof fetch = fetch,
  { ttlMs = 0, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
): OrgLookup {
  const cache = new Map<string, { at: number; answer: Release | string }>();
  return async (type, slug) => {
    const key = `${type}:${slug}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.answer;
    const url = new URL(API[type]);
    url.searchParams.set('action', type === 'plugin' ? 'plugin_information' : 'theme_information');
    url.searchParams.set('request[slug]', slug);
    for (const f of ['sections', 'versions', 'tags', 'screenshots', 'reviews', 'banners', 'icons'])
      url.searchParams.set(`request[fields][${f}]`, '0');
    let answer: Release | string;
    try {
      const res = await fetcher(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Kamaji' },
        signal: AbortSignal.timeout(10_000),
      });
      answer = readAnswer(type, res.status, await res.json().catch(() => null));
    } catch {
      answer = UNREACHABLE;
    }
    // Only real answers are kept: a failure is asked again next time.
    if (answer !== UNREACHABLE) cache.set(key, { at: now(), answer });
    return answer;
  };
}
