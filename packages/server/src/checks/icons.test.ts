import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteDetailResponse, SiteIconStatus, SiteIconsResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { testDb } from '../testing.js';
import {
  ICON_EVERY_MS,
  fetchIcon,
  headerType,
  iconRefresher,
  iconLinks,
  mayFetch,
  pickIcons,
  refetchIcon,
  refreshIcons,
  sniff,
  storedIcon,
} from './icons.js';

const T = Date.UTC(2026, 10, 15, 0, 0);
const SITE = 'https://example.test/';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
);

type Answer = { status?: number; type?: string; body?: Uint8Array | string; location?: string };

/** A fetch that answers from a table of URLs, recording what was asked; anything else is a 404. */
function web(answers: Record<string, Answer | (() => never)>) {
  const asked: string[] = [];
  const doFetch = (async (input: URL | string) => {
    const url = String(input);
    asked.push(url);
    const a = answers[url];
    if (typeof a === 'function') return a();
    if (!a) return new Response('not found', { status: 404 });
    const headers = new Headers();
    if (a.type) headers.set('content-type', a.type);
    if (a.location) headers.set('location', a.location);
    return new Response(a.body ?? null, { status: a.status ?? 200, headers });
  }) as typeof fetch;
  return { fetch: doFetch, asked };
}

const page = (head: string): Answer => ({
  type: 'text/html; charset=UTF-8',
  body: `<!doctype html><html><head>${head}</head><body>Hi</body></html>`,
});

describe('picking the icon from the page', () => {
  const picks = (html: string) => pickIcons(iconLinks(html, SITE)).map((u) => u.pathname);

  it('tries the sharpest first, as WordPress lists its site icon', () => {
    expect(
      picks(
        `<link rel="icon" href="/wp-content/uploads/cropped-mark-32x32.png" sizes="32x32" />
         <link rel="icon" href="/wp-content/uploads/cropped-mark-192x192.png" sizes="192x192" />
         <link rel="apple-touch-icon" href="/wp-content/uploads/cropped-mark-180x180.png" />
         <meta name="msapplication-TileImage" content="/wp-content/uploads/cropped-mark-270x270.png" />`,
      ),
    ).toEqual([
      '/wp-content/uploads/cropped-mark-270x270.png',
      '/wp-content/uploads/cropped-mark-192x192.png',
      '/wp-content/uploads/cropped-mark-180x180.png',
      '/wp-content/uploads/cropped-mark-32x32.png',
    ]);
  });

  it('puts an SVG first, then an apple-touch-icon over a small or unsized icon', () => {
    expect(
      picks(
        `<link rel="icon" href="/later.png">
         <link rel="apple-touch-icon" href="/touch.png">
         <link rel=icon sizes="16x16" href=a.png>
         <link href='/fav.svg?v=1&amp;x=2' rel='icon' type='image/svg+xml' sizes='any'>
         <link rel="shortcut icon" sizes="48x48 16x16" href=b.ico>`,
      ),
    ).toEqual(['/fav.svg', '/touch.png', '/b.ico', '/a.png']);
  });

  it('tries four at most, each once', () => {
    const many = [512, 256, 192, 128, 64, 32]
      .map(
        (n) => `<link rel=icon sizes="${n}x${n}" href=/i${n}.png><link rel=icon href=/i${n}.png>`,
      )
      .join('');
    expect(picks(many)).toEqual(['/i512.png', '/i256.png', '/i192.png', '/i128.png']);
  });

  it('skips data: and javascript: links, other rels, and follows <base href>', () => {
    const links = iconLinks(
      `<base href="https://example.test/sub/">
       <link rel="icon" href="data:image/png;base64,AAAA">
       <link rel="icon" href="javascript:alert(1)">
       <link rel="stylesheet" href="/style.css">
       <link rel="icon" href="icon.png">`,
      SITE,
    );
    expect(links.map((l) => l.href.href)).toEqual(['https://example.test/sub/icon.png']);
    expect(pickIcons(iconLinks('<p>No icons</p>', SITE))).toEqual([]);
  });
});

describe('what counts as an icon', () => {
  it('knows the allowed types by their bytes, and nothing else', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(ICO)).toBe('image/x-icon');
    expect(sniff(SVG)).toBe('image/svg+xml');
    expect(sniff(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniff(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniff(new TextEncoder().encode('<!doctype html><html><svg></svg>'))).toBeNull();
    expect(sniff(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull();
  });

  it('reads the header’s type, with Microsoft’s name for an icon', () => {
    expect(headerType('image/vnd.microsoft.icon')).toBe('image/x-icon');
    expect(headerType('image/svg+xml; charset=utf-8')).toBe('image/svg+xml');
    expect(headerType('text/html')).toBeNull();
    expect(headerType(null)).toBeNull();
  });

  it('refuses a type the bytes don’t back up, and falls back to /favicon.ico', async () => {
    const { fetch } = web({
      [SITE]: page('<link rel="icon" href="/icon.png">'),
      'https://example.test/icon.png': { type: 'image/png', body: '<html>not an image</html>' },
      'https://example.test/favicon.ico': { type: 'image/vnd.microsoft.icon', body: ICO },
    });
    expect(await fetchIcon(SITE, { fetch })).toEqual({
      ok: true,
      bytes: ICO,
      type: 'image/x-icon',
    });
    const lying = web({
      [SITE]: page(''),
      'https://example.test/favicon.ico': { type: 'image/png', body: SVG },
    });
    expect(await fetchIcon(SITE, { fetch: lying.fetch })).toEqual({
      ok: false,
      problem: 'Its type doesn’t match what the server says',
    });
  });

  it('refuses anything over 100 KB, whether or not the server says how big it is', async () => {
    const big = new Uint8Array(100 * 1024 + 1);
    big.set(PNG);
    const { fetch } = web({
      [SITE]: page('<link rel="icon" href="/big.png">'),
      'https://example.test/big.png': { type: 'image/png', body: big },
    });
    expect(await fetchIcon(SITE, { fetch })).toEqual({ ok: false, problem: 'Bigger than 100 KB' });
    // A stream with no length: cut off as it passes the cap.
    const streamed = (async (input: URL | string) => {
      const url = String(input);
      if (url === SITE) return new Response(page('').body as string, { status: 200 });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(PNG);
          for (let i = 0; i < 30; i++) c.enqueue(new Uint8Array(4096));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    expect(await fetchIcon(SITE, { fetch: streamed })).toEqual({
      ok: false,
      problem: 'Bigger than 100 KB',
    });
  });

  it('tries /apple-touch-icon.png before a small icon the page lists, quietly', async () => {
    const touch = web({
      [SITE]: page('<link rel="icon" href="/small.png" sizes="32x32">'),
      'https://example.test/apple-touch-icon.png': { type: 'image/png', body: PNG2 },
      'https://example.test/small.png': { type: 'image/png', body: PNG },
    });
    expect(await fetchIcon(SITE, { fetch: touch.fetch })).toEqual({
      ok: true,
      bytes: PNG2,
      type: 'image/png',
    });
    const none = web({ [SITE]: page('<link rel="icon" href="/small.png" sizes="32x32">') });
    expect(await fetchIcon(SITE, { fetch: none.fetch })).toEqual({
      ok: false,
      problem: 'HTTP 404',
    });
    expect(none.asked).toEqual([
      SITE,
      'https://example.test/apple-touch-icon.png',
      'https://example.test/small.png',
      'https://example.test/favicon.ico',
    ]);
  });

  it('won’t follow a link or redirect to an IP address or a local name', async () => {
    expect(mayFetch(new URL('http://127.0.0.1:10002/api/status'), new URL(SITE))).toBe(false);
    expect(mayFetch(new URL('https://mini.local/x.png'), new URL(SITE))).toBe(false);
    expect(mayFetch(new URL('http://cdn.example.org/x.png'), new URL(SITE))).toBe(false);
    expect(mayFetch(new URL('https://cdn.example.org/x.png'), new URL(SITE))).toBe(true);
    expect(mayFetch(new URL('http://www.example.test/x.png'), new URL(SITE))).toBe(true);
    const { fetch, asked } = web({
      [SITE]: page('<link rel="icon" href="http://192.168.1.10/icon.png">'),
      'https://example.test/favicon.ico': { status: 302, location: 'http://127.0.0.1/icon.ico' },
    });
    expect((await fetchIcon(SITE, { fetch })).ok).toBe(false);
    expect(asked).toEqual([
      SITE,
      'https://example.test/apple-touch-icon.png',
      'https://example.test/favicon.ico',
    ]);
  });
});

function site(db: Db, id: string, url = `https://${id}/`) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, ?, 'other', 'monitoring', 'done', ?)`,
  ).run(id, id, url, T);
}

const fetched = (outcomes: { ok: boolean }[]) => outcomes.filter((o) => o.ok).length;

describe('refreshing icons', () => {
  it('keeps the last icon when a fetch fails, and says why', async () => {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-icons-'));
    site(db, 'example.test');
    const good = web({
      [SITE]: page('<link rel="icon" href="/icon.png" sizes="32x32">'),
      'https://example.test/icon.png': { type: 'image/png', body: PNG },
    });
    expect(fetched(await refreshIcons(db, { dir, now: () => T, fetch: good.fetch }))).toBe(1);
    const first = storedIcon(db, dir, 'example.test');
    expect(first).toMatchObject({ type: 'image/png' });
    // Not due again until a day has passed.
    expect(await refreshIcons(db, { dir, now: () => T + 1000, fetch: good.fetch })).toEqual([]);
    // Unless it's asked for, as Refetch icon does.
    expect(
      await refetchIcon(db, 'example.test', { dir, now: () => T + 1000, fetch: good.fetch }),
    ).toEqual({ id: 'example.test', name: 'example.test', ok: true, problem: null });
    expect(
      await refetchIcon(db, 'nowhere.test', { dir, now: () => T, fetch: good.fetch }),
    ).toBeNull();
    // The site is down: the page and /favicon.ico both refuse.
    const down = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    await refreshIcons(db, { dir, now: () => T + 1000 + ICON_EVERY_MS, fetch: down });
    expect(storedIcon(db, dir, 'example.test')).toEqual(first);
    expect(
      db.prepare("SELECT problem FROM site_icons WHERE site_id = 'example.test'").get()?.problem,
    ).toBe('Connection refused');
  });

  it('replaces a changed icon and removes the old file; one site failing doesn’t stop the rest', async () => {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-icons-'));
    site(db, 'a.test');
    site(db, 'b.test');
    site(db, 'c.test');
    const answers = (icon: Uint8Array) =>
      web({
        'https://a.test/': () => {
          throw new Error('boom');
        },
        'https://b.test/favicon.ico': { type: 'image/png', body: icon },
        'https://c.test/favicon.ico': { type: 'image/x-icon', body: ICO },
      }).fetch;
    expect(await refreshIcons(db, { dir, now: () => T, fetch: answers(PNG) })).toEqual([
      { id: 'a.test', name: 'a.test', ok: false, problem: 'HTTP 404' },
      { id: 'b.test', name: 'b.test', ok: true, problem: null },
      { id: 'c.test', name: 'c.test', ok: true, problem: null },
    ]);
    const before = storedIcon(db, dir, 'b.test')!;
    await refreshIcons(db, { dir, now: () => T + ICON_EVERY_MS, fetch: answers(PNG2) });
    const after = storedIcon(db, dir, 'b.test')!;
    expect(after.sha256).not.toBe(before.sha256);
    expect(existsSync(join(dir, before.sha256))).toBe(false);
    expect(storedIcon(db, dir, 'c.test')?.type).toBe('image/x-icon');
    expect(storedIcon(db, dir, 'a.test')).toBeNull();
  });
});

describe('the cycle’s part', () => {
  it('starts a refresh without waiting for it, one at a time, and logs only that one failed', async () => {
    let calls = 0;
    let finish: () => void = () => {};
    const logged: string[] = [];
    const start = iconRefresher(
      () => {
        calls += 1;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      (m) => logged.push(m),
    );
    expect(start()).toBeUndefined();
    start();
    expect(calls).toBe(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    const failing = iconRefresher(
      () => Promise.reject(new Error('/secret/path')),
      (m) => logged.push(m),
    );
    failing();
    await new Promise((r) => setTimeout(r, 0));
    start();
    expect(calls).toBe(2);
    expect(logged).toEqual(['icons: the refresh failed']);
  });
});

describe('the icon routes', () => {
  async function setup() {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-icons-'));
    site(db, 'example.test');
    site(db, 'bare.test');
    const { fetch } = web({
      [SITE]: page('<link rel="icon" href="/icon.svg">'),
      'https://example.test/icon.svg': { type: 'image/svg+xml', body: SVG },
    });
    await refreshIcons(db, { dir, now: () => T, fetch });
    const app = createApp({
      db,
      login: 'tylercraft@github',
      webDist: mkdtempSync(join(tmpdir(), 'kamaji-web-')),
      iconsDir: dir,
      iconFetch: fetch,
      passkeys: testAuthenticator().config,
      now: () => T,
      statusInput: () => ({
        version: '0.1.0',
        commit: null,
        startedAt: 0,
        now: T,
        cycleSeconds: 300,
        heartbeatConfigured: false,
        alertsConfigured: false,
      }),
    });
    const get = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { headers: { 'Tailscale-User-Login': 'tylercraft@github', ...headers } });
    // No Kamaji-Passkey header: Refetch icons goes without one, as the page sends it.
    const refetch = (id: string, origin = 'https://kamaji.test') =>
      app.request(`/api/sites/${id}/icon/refetch`, {
        method: 'POST',
        headers: {
          'Tailscale-User-Login': 'tylercraft@github',
          Host: 'kamaji.test',
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    return { get, refetch };
  }

  it('serves the icon as an image that can’t load or run anything, cached for a day', async () => {
    const { get } = await setup();
    const res = await get('/api/sites/example.test/icon');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(SVG);
    expect((await get('/api/sites/example.test/icon', { 'If-None-Match': etag })).status).toBe(304);
  });

  it('is a 404 for a site with no icon, or no such site, and lists only sites with one', async () => {
    const { get } = await setup();
    expect((await get('/api/sites/bare.test/icon')).status).toBe(404);
    expect((await get('/api/sites/nowhere.test/icon')).status).toBe(404);
    const list = SiteIconsResponse.parse(await (await get('/api/site-icons')).json());
    expect(Object.keys(list.icons)).toEqual(['example.test']);
    expect(Object.keys(list.names).sort()).toEqual(['bare.test', 'example.test']);
  });

  it('refetches one site’s icon without a passkey, and its settings say how it went', async () => {
    const { get, refetch } = await setup();
    const res = await refetch('bare.test');
    expect(res.status).toBe(200);
    expect(SiteIconStatus.parse(await res.json())).toMatchObject({
      fetchedAt: null,
      problem: 'HTTP 404',
    });
    expect((await refetch('example.test')).status).toBe(200);
    const detail = SiteDetailResponse.parse(await (await get('/api/sites/example.test')).json());
    expect(detail.icon).toMatchObject({ problem: null });
    expect((await refetch('nowhere.test')).status).toBe(404);
    expect((await refetch('example.test', 'https://evil.example')).status).toBe(403);
  });
});
