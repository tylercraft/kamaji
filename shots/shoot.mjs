// The shot script, run in the kamaji-shots container (ops/screenshots-plan.md, "Taking one
// shot"). One JSON job as its argument: the pages, the sizes, the selectors to hide and to mask,
// the hosts to block, how many rounds. It writes each shot's PNG and thumbnail to /out and prints
// one JSON line per shot, then {"format":1,"kind":"done"}. It loads pages and reads them: no
// clicks, no typing, no forms, no consent (Tyler, 2026-11-19). Nothing it prints holds an error's
// text, only counts and fingerprints, since the screenshots process keeps what it prints.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPort, originOf, startGuard } from './guard.mjs';

const { chromium } = createRequire('/usr/lib/node_modules/')('playwright-core');

const job = JSON.parse(process.argv[2] ?? '{}');
const OUT = '/out';
const say = (line) => process.stdout.write(`${JSON.stringify({ format: 1, ...line })}\n`);

// Animations and transitions off, the caret hidden, smooth scrolling off: the same page twice
// should look the same.
const STILL =
  '*,*::before,*::after{animation:none!important;transition:none!important;' +
  'caret-color:transparent!important;scroll-behavior:auto!important}';

/** A fingerprint: the same error or request gives the same one, without keeping its text. */
const fingerprint = (text) =>
  createHash('sha256')
    .update(
      String(text)
        .replace(/\?[^\s'")]*/g, '')
        .replace(/\d+/g, '0')
        .slice(0, 300),
    )
    .digest('hex')
    .slice(0, 16);

// What the guard refused while the current shot loads: counted as blocked, never as failed.
let refused = { count: 0, hosts: new Set() };
const requestHost = (request) => {
  try {
    const u = new URL(request.url());
    return hostPort(
      u.hostname,
      u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80'),
    );
  } catch {
    return '';
  }
};

/** Whether a console message names a URL whose host:port the guard refused in this shot. */
const namesRefused = (text) =>
  [...text.matchAll(/\b(?:https?|wss?):\/\/[^\s'"]+/g)].some(([u]) =>
    refused.hosts.has(requestHost({ url: () => u })),
  );

const blockedHost = (host) => job.blocked.some((b) => host === b || host.endsWith(`.${b}`));

/** A failed request, as method, host, path (no query) and status, for "new since before". */
function requestKey(request, status) {
  try {
    const u = new URL(request.url());
    return `${request.method()} ${u.host}${u.pathname.slice(0, 200)} ${status}`;
  } catch {
    return `${request.method()} ? ${status}`;
  }
}

async function shoot(browser, round, position, url, viewport) {
  const name = `r${round}-p${position}-${viewport.name}`;
  const shot = { kind: 'shot', round, position, viewport: viewport.name };
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    ...(viewport.userAgent ? { userAgent: viewport.userAgent } : {}),
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    acceptDownloads: false,
    permissions: [],
  });
  const jsKeys = [];
  const failedKeys = [];
  refused = { count: 0, hosts: new Set() };
  try {
    await context.route('**/*', (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        // A data: or blob: URL has no host to block.
      }
      return host && blockedHost(host) ? route.abort('blockedbyclient') : route.continue();
    });
    const page = await context.newPage();
    // Nothing on the page may open a window, a dialog or a download that waits for an answer.
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));
    page.on('pageerror', (e) => jsKeys.push(fingerprint(`${e.name}: ${e.message}`)));
    page.on('console', (m) => {
      // A load that failed is a failed request, counted below; one the guard refused is Kamaji's
      // doing, whatever Chromium says about it (fixtures/chromium-console.txt).
      if (
        m.type() === 'error' &&
        !m.text().startsWith('Failed to load resource:') &&
        !namesRefused(m.text())
      )
        jsKeys.push(fingerprint(`${m.text()} ${m.location().url}`));
    });
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? 'failed';
      // What Kamaji blocked isn't the site's failure.
      if (!why.includes('BLOCKED_BY_CLIENT') && !refused.hosts.has(requestHost(r)))
        failedKeys.push(requestKey(r, 'failed'));
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.headers()['x-kamaji-blocked'])
        failedKeys.push(requestKey(r.request(), r.status()));
    });

    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    shot.status = response?.status() ?? null;
    const headers = response ? await response.allHeaders() : {};
    const title = await page.title().catch(() => '');
    // Cloudflare's bot check answers instead of the page (cf-mitigated: challenge), or its
    // "Just a moment…" page under a 403 or 503.
    if (
      headers['cf-mitigated'] === 'challenge' ||
      ([403, 503].includes(shot.status) && /just a moment/i.test(title))
    ) {
      shot.blocked = true;
      return say({
        ...shot,
        ok: false,
        problem: 'Cloudflare’s bot check answered instead of the page',
      });
    }
    if (shot.status !== null && shot.status >= 400) {
      return say({ ...shot, ok: false, problem: `the page answered HTTP ${shot.status}` });
    }
    let quiet = await page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await page.addStyleTag({ content: STILL });
    await page.evaluate(() => document.fonts.ready);
    // A screen at a time to the bottom, so lazy images load, then back to the top.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.documentElement.scrollHeight && y < 15_000; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    quiet =
      (await page
        .waitForLoadState('networkidle', { timeout: 5_000 })
        .then(() => true)
        .catch(() => false)) && quiet;
    await page.evaluate(() => document.fonts.ready);

    // Hidden: set on the elements themselves, so a selector never becomes CSS text.
    const masks = await page.evaluate(
      ({ hide, mask }) => {
        const all = (selector) => {
          try {
            return [...document.querySelectorAll(selector)];
          } catch {
            return [];
          }
        };
        for (const s of hide)
          for (const el of all(s)) el.style.setProperty('display', 'none', 'important');
        const boxes = [];
        const box = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0)
            boxes.push({
              x: Math.max(0, Math.floor(r.left + window.scrollX)),
              y: Math.max(0, Math.floor(r.top + window.scrollY)),
              width: Math.ceil(r.width),
              height: Math.ceil(r.height),
            });
        };
        for (const s of mask) for (const el of all(s)) box(el);
        // Always: video, and frames from other hosts (YouTube, Vimeo, maps).
        for (const el of all('video')) box(el);
        for (const el of all('iframe')) {
          try {
            if (new URL(el.src, location.href).host !== location.host) box(el);
          } catch {
            box(el);
          }
        }
        return boxes.slice(0, 200);
      },
      { hide: job.hide, mask: job.mask },
    );

    const height = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    );
    const cut = height > job.maxHeight;
    const file = `${name}.png`;
    const thumb = `${name}.jpg`;
    await page.screenshot({
      path: `${OUT}/${file}`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      ...(cut ? { clip: { x: 0, y: 0, width: viewport.width, height: job.maxHeight } } : {}),
    });
    await page.screenshot({
      path: `${OUT}/${thumb}`,
      type: 'jpeg',
      quality: 60,
      animations: 'disabled',
      caret: 'hide',
    });
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    say({
      ...shot,
      ok: true,
      file,
      thumb,
      width: Math.max(width, viewport.width),
      height: cut ? job.maxHeight : height,
      cut,
      quiet,
      masks,
      jsErrors: jsKeys.length,
      jsKeys: [...new Set(jsKeys)].slice(0, 100),
      failedRequests: failedKeys.length,
      failedKeys: [...new Set(failedKeys)].slice(0, 100),
      blockedRequests: refused.count,
      // For the end-to-end test only; Kamaji keeps the count.
      blockedHosts: [...refused.hosts].slice(0, 20),
    });
  } catch (error) {
    const what =
      error?.name === 'TimeoutError' ? 'it took too long to load' : 'the browser couldn’t load it';
    say({
      ...shot,
      ok: false,
      problem: what,
      jsErrors: jsKeys.length,
      failedRequests: failedKeys.length,
      blockedRequests: refused.count,
    });
  } finally {
    await context.close().catch(() => {});
  }
}

const guard = await startGuard({
  own: new Set(job.pages.map(originOf)),
  blocked: (where) => {
    refused.count += 1;
    refused.hosts.add(where);
  },
});
const browser = await chromium.launch({
  chromiumSandbox: true,
  // Every connection through the guard, loopback too (<-loopback> takes away Chromium's own
  // exception for it); no QUIC, which a proxy can't carry; and WebRTC kept from going around it.
  proxy: { server: guard.server, bypass: '<-loopback>' },
  args: [
    '--disable-dev-shm-usage',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ],
});
try {
  for (let round = 1; round <= job.rounds; round += 1) {
    if (round > 1) await delay(job.gapMs);
    for (const [position, url] of job.pages.entries())
      for (const viewport of job.viewports) await shoot(browser, round, position, url, viewport);
  }
} finally {
  await browser.close().catch(() => {});
  guard.close();
}
say({ kind: 'done' });
