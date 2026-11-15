// Each site's favicon, fetched by Kamaji itself so the page never loads anything from a client
// site. Once a day per site, alongside the cycle but never holding it up: a plain GET of the home
// page for its <link rel="icon"> and apple-touch-icon tags, then a GET of the icon (or of
// /favicon.ico). Only a small image of a known type is kept, checked from its bytes as well as
// its header, and a failed try keeps the last icon.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** Largest icon size a list needs; 16px and 24px on the page, so 64 covers a 2x screen. */
const LARGEST = 64;

export interface IconLink {
  href: URL;
  /** The size it says it is, in pixels (see linkSize), or null when it doesn't say. */
  size: number | null;
  apple: boolean;
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

/**
 * A link's sizes attribute as one number: its largest size that fits (64px or under), or its
 * smallest when none does. "any", or no sizes at all, is null.
 */
function linkSize(sizes: string | null): number | null {
  const sides = (sizes ?? '')
    .split(/\s+/)
    .map((t) => /^(\d+)x(\d+)$/i.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Math.max(Number(m[1]), Number(m[2])));
  if (sides.length === 0) return null;
  const fit = sides.filter((s) => s <= LARGEST);
  return fit.length ? Math.max(...fit) : Math.min(...sides);
}

/** The icon and apple-touch-icon links in a page, in page order, resolved against `base`. */
export function iconLinks(html: string, base: string): IconLink[] {
  const baseHref = /<base\b[^>]*>/i.exec(html);
  let root: URL;
  try {
    root = new URL(attr(baseHref?.[0] ?? '', 'href') ?? base, base);
  } catch {
    root = new URL(base);
  }
  const links: IconLink[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const apple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!rel.includes('icon') && !apple) continue;
    const href = attr(tag, 'href')?.trim();
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, root);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    links.push({ href: url, size: linkSize(attr(tag, 'sizes')), apple });
  }
  return links;
}

/**
 * Which link to use: the largest that says it's 64px or smaller; otherwise the first. Icon links
 * come before apple-touch-icons, which are usually 180px.
 */
export function pickIcon(links: IconLink[]): URL | null {
  const ordered = [...links.filter((l) => !l.apple), ...links.filter((l) => l.apple)];
  const fits = ordered.filter((l) => l.size !== null && l.size <= LARGEST);
  if (fits.length)
    return fits.reduce((best, l) => ((l.size ?? 0) > (best.size ?? 0) ? l : best)).href;
  return ordered[0]?.href ?? null;
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
  const tries: URL[] = [];
  if (page.ok) {
    const picked = pickIcon(iconLinks(new TextDecoder().decode(page.bytes), home.href));
    if (picked) tries.push(picked);
  }
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
    first ??= problem;
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
export function dueIcons(db: Db, now: number): { id: string; url: string }[] {
  return db
    .prepare(
      `SELECT s.id, s.url FROM sites s LEFT JOIN site_icons i ON i.site_id = s.id
       WHERE s.removed_at IS NULL AND s.paused_at IS NULL
       AND (i.checked_at IS NULL OR i.checked_at <= ?) ORDER BY s.id`,
    )
    .all(now - ICON_EVERY_MS)
    .map((r) => ({ id: String(r.id), url: String(r.url) }));
}

/**
 * Every due site's icon, three at a time. Never throws: a site that fails, or throws, keeps its
 * last icon and is tried again tomorrow.
 */
export async function refreshIcons(
  db: Db,
  options: FetchOptions & { dir: string; now: () => number; atOnce?: number },
): Promise<number> {
  const sites = dueIcons(db, options.now());
  let next = 0;
  let fetched = 0;
  async function worker() {
    while (next < sites.length && !options.signal?.aborted) {
      const site = sites[next++]!;
      let icon: IconResult;
      try {
        icon = await fetchIcon(site.url, options);
      } catch {
        if (options.signal?.aborted) return;
        icon = { ok: false, problem: 'Kamaji couldn’t fetch it' };
      }
      try {
        storeIcon(db, options.dir, site.id, icon, options.now());
        if (icon.ok) fetched += 1;
      } catch {
        // A full disk or a locked database: tried again tomorrow, or on the next cycle if the
        // row didn't save.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.atOnce ?? 3, sites.length) }, worker));
  return fetched;
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
