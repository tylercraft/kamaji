// Each site's favicon, fetched by Kamaji itself so the page never loads anything from a client
// site. Once a day per site, alongside the cycle but never holding it up: a plain GET of the home
// page for its icon, apple-touch-icon and tile tags, then a GET of the sharpest icon (or of
// /apple-touch-icon.png and /favicon.ico). Only a small image of a known type is kept, checked from its bytes as well as
// its header, and a failed try keeps the last icon.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteIconStatus } from '@kamaji/shared';
import type { Db } from '../db.js';
import { describeError, USER_AGENT } from './http.js';

export const ICON_TYPES = [
  'image/png',
  'image/x-icon',
  'image/svg+xml',
  'image/webp',
  'image/jpeg',
  'image/gif',
] as const;
export type IconType = (typeof ICON_TYPES)[number];

export const MAX_ICON_BYTES = 100 * 1024;
/** Enough of the home page for its <head>; the rest is never read. */
const MAX_PAGE_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
export const ICON_EVERY_MS = 24 * 60 * 60 * 1000;
/** At most this many of the page's icons are tried, sharpest first, before the usual paths. */
const MOST_TRIES = 4;

export interface IconLink {
  href: URL;
  /**
   * How sharp it says it is, in pixels: from its sizes, its file name (WordPress's
   * cropped-…-192x192.png), or what its kind usually is (180 for an apple-touch-icon). Infinity
   * for an SVG, null when nothing says.
   */
  size: number | null;
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decode = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return ENTITIES[k] ?? m;
  });

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** The largest side in a sizes attribute ("32x32 192x192"), or null when there's none. */
function largestSize(sizes: string | null): number | null {
  const sides = (sizes ?? '')
    .split(/\s+/)
    .map((t) => /^(\d+)x(\d+)$/i.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Math.max(Number(m[1]), Number(m[2])));
  return sides.length ? Math.max(...sides) : null;
}

/** A size in the file name, as WordPress names its site icons: cropped-mark-192x192.png. */
function nameSize(url: URL): number | null {
  const m = /[-_](\d{2,4})x(\d{2,4})\.\w+$/i.exec(url.pathname);
  return m ? Math.max(Number(m[1]), Number(m[2])) : null;
}

/**
 * The icons a page lists, in page order, resolved against `base`: <link rel="icon">,
 * apple-touch-icon, and the msapplication-TileImage meta WordPress adds for its site icon.
 */
export function iconLinks(html: string, base: string): IconLink[] {
  const baseHref = /<base\b[^>]*>/i.exec(html);
  let root: URL;
  try {
    root = new URL(attr(baseHref?.[0] ?? '', 'href') ?? base, base);
  } catch {
    root = new URL(base);
  }
  const resolve = (href: string | undefined): URL | null => {
    if (!href) return null;
    try {
      const url = new URL(href, root);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch {
      return null;
    }
  };
  const links: IconLink[] = [];
  for (const [tag] of html.matchAll(/<(link|meta)\b[^>]*>/gi)) {
    if (/^<meta/i.test(tag)) {
      if ((attr(tag, 'name') ?? '').toLowerCase() !== 'msapplication-tileimage') continue;
      const href = resolve(attr(tag, 'content')?.trim());
      // Windows' tile: 144px unless its name says otherwise.
      if (href) links.push({ href, size: nameSize(href) ?? 144 });
      continue;
    }
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const apple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!rel.includes('icon') && !apple) continue;
    const href = resolve(attr(tag, 'href')?.trim());
    if (!href) continue;
    const svg =
      (attr(tag, 'type') ?? '').toLowerCase().includes('svg') ||
      href.pathname.toLowerCase().endsWith('.svg');
    const size = svg
      ? Infinity
      : (largestSize(attr(tag, 'sizes')) ?? nameSize(href) ?? (apple ? 180 : null));
    links.push({ href, size });
  }
  return links;
}

/**
 * Which to try, sharpest first: an SVG, then the largest size, then any that don't say, in page
 * order. Too big a file (over 100 KB) just fails, and the next is tried.
 */
export function pickIcons(links: IconLink[]): URL[] {
  const seen = new Set<string>();
  return links
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || a.i - b.i)
    .filter((l) => !seen.has(l.href.href) && Boolean(seen.add(l.href.href)))
    .slice(0, MOST_TRIES)
    .map((l) => l.href);
}

const starts = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** What the bytes are, of the types an icon may be; null for anything else. */
export function sniff(b: Uint8Array): IconType | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(b, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) return 'image/gif';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) return 'image/webp';
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, 2048))
    .replace(/^\uFEFF/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!doctype[^>]*>\s*)*<svg[\s>]/i.test(text))
    return 'image/svg+xml';
  return null;
}

/** The type a server says it sent, in the same words as sniff. */
export function headerType(contentType: string | null): IconType | null {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (t === 'image/vnd.microsoft.icon') return 'image/x-icon';
  return (ICON_TYPES as readonly string[]).includes(t) ? (t as IconType) : null;
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');

/**
 * Where Kamaji will follow a link or redirect: the site's own host (with or without www), or
 * any other name over HTTPS. Never an IP address or a local name, so a page can't point Kamaji
 * at the mini or the network it's on.
 */
export function mayFetch(url: URL, site: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (bare(url.hostname) === bare(site.hostname)) return true;
  const host = url.hostname.toLowerCase();
  const local =
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[') ||
    host === 'localhost' ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
  return url.protocol === 'https:' && !local;
}

type Got = { ok: true; bytes: Uint8Array; type: string | null; url: URL } | Failed;
type Failed = { ok: false; problem: string };

interface FetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One GET, following up to three redirects to places mayFetch allows, read to `cap` bytes. */
async function get(
  url: URL,
  site: URL,
  accept: string,
  cap: number,
  over: 'fail' | 'cut',
  options: FetchOptions,
): Promise<Got> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!mayFetch(current, site))
        return { ok: false, problem: 'It points somewhere Kamaji won’t fetch from' };
      const res = await doFetch(current, {
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (!location) return { ok: false, problem: `HTTP ${res.status} with nowhere to go` };
        current = new URL(location, current);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        return { ok: false, problem: `HTTP ${res.status}` };
      }
      const said = Number(res.headers.get('content-length') ?? NaN);
      if (over === 'fail' && said > cap) {
        await res.body?.cancel();
        return { ok: false, problem: 'Bigger than 100 KB' };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          chunks.push(value);
          if (total > cap) {
            await reader.cancel();
            if (over === 'fail') return { ok: false, problem: 'Bigger than 100 KB' };
            break;
          }
        }
      }
      const bytes = new Uint8Array(Math.min(total, cap));
      let at = 0;
      for (const c of chunks) {
        const part = c.subarray(0, Math.min(c.byteLength, bytes.byteLength - at));
        bytes.set(part, at);
        at += part.byteLength;
      }
      return { ok: true, bytes, type: res.headers.get('content-type'), url: current };
    }
    return { ok: false, problem: 'Too many redirects' };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const cause =
      error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const code = timeout.aborted
      ? 'TimeoutError'
      : typeof cause?.code === 'string'
        ? cause.code
        : 'unknown';
    return { ok: false, problem: describeError(code, timeoutMs) };
  }
}

export type IconResult = { ok: true; bytes: Uint8Array; type: IconType } | Failed;

/** A site's icon: the one its home page links to, or /favicon.ico. */
export async function fetchIcon(siteUrl: string, options: FetchOptions = {}): Promise<IconResult> {
  const site = new URL(siteUrl);
  const page = await get(site, site, 'text/html', MAX_PAGE_BYTES, 'cut', options);
  const home = page.ok ? page.url : site;
  const links = page.ok ? iconLinks(new TextDecoder().decode(page.bytes), home.href) : [];
  // Where the apple-touch-icon usually is (180px), whether the page says so or not, when the page
  // offers nothing as sharp: tried in its place by size. One that isn't there is no news, so its
  // problem is never the one given.
  const guess = new URL('/apple-touch-icon.png', home);
  const quiet = links.some((l) => (l.size ?? 0) >= 180 || l.href.href === guess.href)
    ? null
    : guess;
  const tries = pickIcons(quiet ? [...links, { href: quiet, size: 180 }] : links);
  // Then /favicon.ico, the oldest place of all.
  const fallback = new URL('/favicon.ico', home);
  if (!tries.some((u) => u.href === fallback.href)) tries.push(fallback);
  let first: string | null = null;
  for (const url of tries) {
    const got = await get(url, site, 'image/*', MAX_ICON_BYTES, 'fail', options);
    let problem: string;
    if (!got.ok) problem = got.problem;
    else {
      const sniffed = sniff(got.bytes);
      const said = headerType(got.type);
      if (!sniffed) problem = 'Not an image Kamaji shows';
      else if (said !== sniffed) problem = 'Its type doesn’t match what the server says';
      else return { ok: true, bytes: got.bytes, type: sniffed };
    }
    if (url.href !== quiet?.href) first ??= problem;
  }
  return { ok: false, problem: first ?? 'No icon' };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Keeps a fetched icon: the bytes as a file named by their hash, and the row that points at it. */
export function storeIcon(db: Db, dir: string, siteId: string, icon: IconResult, at: number) {
  const before = db.prepare('SELECT sha256 FROM site_icons WHERE site_id = ?').get(siteId);
  if (!icon.ok) {
    db.prepare(
      `INSERT INTO site_icons (site_id, checked_at, problem) VALUES (?, ?, ?)
       ON CONFLICT (site_id) DO UPDATE SET checked_at = excluded.checked_at, problem = excluded.problem`,
    ).run(siteId, at, icon.problem);
    return;
  }
  const sha = sha256(icon.bytes);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, sha);
  writeFileSync(`${file}.tmp`, icon.bytes);
  renameSync(`${file}.tmp`, file);
  db.prepare(
    `INSERT INTO site_icons (site_id, sha256, content_type, fetched_at, checked_at, problem)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (site_id) DO UPDATE SET sha256 = excluded.sha256,
       content_type = excluded.content_type, fetched_at = excluded.fetched_at,
       checked_at = excluded.checked_at, problem = NULL`,
  ).run(siteId, sha, icon.type, at, at);
  const old = before?.sha256 === null || before === undefined ? null : String(before.sha256);
  const shared = old && db.prepare('SELECT 1 FROM site_icons WHERE sha256 = ?').get(old);
  if (old && old !== sha && !shared) rmSync(join(dir, old), { force: true });
}

/** A site's stored icon, for the route; null when there's none, or its file has gone. */
export function storedIcon(
  db: Db,
  dir: string,
  siteId: string,
): { bytes: Buffer; type: string; sha256: string } | null {
  const row = db
    .prepare('SELECT sha256, content_type FROM site_icons WHERE site_id = ? AND sha256 IS NOT NULL')
    .get(siteId);
  if (!row) return null;
  const sha = String(row.sha256);
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  try {
    return { bytes: readFileSync(join(dir, sha)), type: String(row.content_type), sha256: sha };
  } catch {
    return null;
  }
}

/** Which sites have an icon, by the hash of its bytes: the page asks only for these. */
export function iconVersions(db: Db): Record<string, string> {
  return Object.fromEntries(
    db
      .prepare(
        `SELECT i.site_id, i.sha256 FROM site_icons i JOIN sites s ON s.id = i.site_id
         WHERE i.sha256 IS NOT NULL AND s.removed_at IS NULL`,
      )
      .all()
      .map((r) => [String(r.site_id), String(r.sha256)]),
  );
}

/** Every site's name, for the letter shown where there's no icon. */
export function siteNames(db: Db): Record<string, string> {
  return Object.fromEntries(
    db
      .prepare('SELECT id, name FROM sites WHERE removed_at IS NULL')
      .all()
      .map((r) => [String(r.id), String(r.name)]),
  );
}

/** Sites due an icon: not removed or paused, and not tried in the last day. */
export function dueIcons(db: Db, now: number): { id: string; name: string; url: string }[] {
  return db
    .prepare(
      `SELECT s.id, s.name, s.url FROM sites s LEFT JOIN site_icons i ON i.site_id = s.id
       WHERE s.removed_at IS NULL AND s.paused_at IS NULL
       AND (i.checked_at IS NULL OR i.checked_at <= ?) ORDER BY s.id`,
    )
    .all(now - ICON_EVERY_MS)
    .map((r) => ({ id: String(r.id), name: String(r.name), url: String(r.url) }));
}

/** How one site's fetch went: its problem when there's no new icon. */
export interface IconOutcome {
  id: string;
  name: string;
  ok: boolean;
  problem: string | null;
}

type IconOptions = FetchOptions & { dir: string; now: () => number };

/** One site's icon, fetched and kept. Never throws: a failure keeps the last icon, and says why. */
async function fetchAndStore(
  db: Db,
  site: { id: string; name: string; url: string },
  options: IconOptions,
): Promise<IconOutcome | null> {
  let icon: IconResult;
  try {
    icon = await fetchIcon(site.url, options);
  } catch {
    if (options.signal?.aborted) return null;
    icon = { ok: false, problem: 'Kamaji couldn’t fetch it' };
  }
  let problem = icon.ok ? null : icon.problem;
  try {
    storeIcon(db, options.dir, site.id, icon, options.now());
  } catch {
    // A full disk or a locked database: tried again tomorrow, or on the next cycle if the row
    // didn't save.
    problem = 'Kamaji couldn’t save it';
  }
  return { id: site.id, name: site.name, ok: problem === null, problem };
}

/**
 * Refetch icon, on a site's settings: its icon now, however recently it was tried. Null for a
 * site that's removed or doesn't exist.
 */
export async function refetchIcon(
  db: Db,
  siteId: string,
  options: IconOptions,
): Promise<IconOutcome | null> {
  const row = db
    .prepare('SELECT id, name, url FROM sites WHERE id = ? AND removed_at IS NULL')
    .get(siteId);
  if (!row) return null;
  return fetchAndStore(
    db,
    { id: String(row.id), name: String(row.name), url: String(row.url) },
    options,
  );
}

/** What a site's settings show: when its icon was fetched, and why the last try failed if it did. */
export function iconStatus(db: Db, siteId: string): SiteIconStatus | null {
  const row = db
    .prepare('SELECT fetched_at, checked_at, problem FROM site_icons WHERE site_id = ?')
    .get(siteId);
  if (!row) return null;
  return {
    fetchedAt: row.fetched_at === null ? null : new Date(Number(row.fetched_at)).toISOString(),
    checkedAt: new Date(Number(row.checked_at)).toISOString(),
    problem: row.problem === null ? null : String(row.problem),
  };
}

/**
 * Every due site's icon, three at a time, each site's outcome in id order. Never throws: a site
 * that fails, or throws, keeps its last icon and is tried again tomorrow.
 */
export async function refreshIcons(
  db: Db,
  options: IconOptions & { atOnce?: number },
): Promise<IconOutcome[]> {
  const sites = dueIcons(db, options.now());
  const outcomes: IconOutcome[] = [];
  let next = 0;
  async function worker() {
    while (next < sites.length && !options.signal?.aborted) {
      const outcome = await fetchAndStore(db, sites[next++]!, options);
      if (outcome) outcomes.push(outcome);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.atOnce ?? 3, sites.length) }, worker));
  return outcomes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * What the cycle calls: starts a refresh and returns at once, so a slow site can never hold the
 * cycle up, and does nothing while one is still going. A refresh that throws (a bug: refreshIcons
 * doesn't) logs that it happened, nothing more.
 */
export function iconRefresher(run: () => Promise<unknown>, log: (message: string) => void) {
  let running = false;
  return (): void => {
    if (running) return;
    running = true;
    run()
      .catch(() => log('icons: the refresh failed'))
      .finally(() => {
        running = false;
      });
  };
}
