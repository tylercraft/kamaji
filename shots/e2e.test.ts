// Screenshot checks end to end, laptop only, never the mini or a real site: `npm run test:shots`.
// The real kamaji-shots image (built if it isn't there), run by Kamaji's own code with the flags
// it runs with on the mini (read only, Playwright's seccomp profile, its non-root user, a 700
// folder), against a fixture page served from this machine: an animation, a carousel that
// changes on its own, a lazy image, a cookie banner, an analytics tag. Then the same page
// "after an update" twice: unchanged (the carousel is masked by the two "before" rounds), and
// broken (a red header, a taller page, a JavaScript error).
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../packages/server/src/db.js';
import { realExec } from '../packages/server/src/sitebackups/exec.js';
import { ensureImage } from '../packages/server/src/shots/image.js';
import { runShots, type ShotsDeps } from '../packages/server/src/shots/run.js';
import { requestSet, saveSettings, setView } from '../packages/server/src/shots/sets.js';
import { testDb } from '../packages/server/src/testing.js';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const DOCKER = '/usr/local/bin/docker';
/** The cookie banner's colour: hidden by the site's setting, so never in a shot. */
const BANNER = [255, 0, 170];

let mode: 'normal' | 'broken' = 'normal';
const requests: string[] = [];
let server: Server;
let port = 0;
let db: Db;
let deps: ShotsDeps;

function page(): string {
  const broken = mode === 'broken';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; font: 16px sans-serif; }
  header { height: 80px; background: ${broken ? '#c00' : '#234'}; color: #fff; padding: 20px; }
  .spin { width: 40px; height: 40px; background: #888; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #carousel { height: 200px; margin: 20px; }
  #cookie { position: fixed; bottom: 0; left: 0; right: 0; height: 60px; background: rgb(${BANNER.join(',')}); }
  .tall { height: 1800px; background: linear-gradient(#fff, #eee); }
</style>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
</head><body>
<header>Fixture</header>
<div class="spin"></div>
<div id="carousel"></div>
<script>
  // A slide that changes on its own every second, as a carousel does.
  const slides = ['#6a6', '#66a', '#a66', '#aa6'];
  const show = () => (document.getElementById('carousel').style.background = slides[Math.floor(Date.now() / 1000) % 4]);
  show(); setInterval(show, 1000);
</script>
${broken ? '<div style="height:400px;background:#fcc">An update broke this.</div><script>undefinedFunction()</script>' : ''}
<div class="tall"></div>
<img src="/lazy.svg" loading="lazy" width="200" height="100" alt="">
<div id="cookie">We use cookies</div>
</body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/lazy.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#39f"/></svg>',
      );
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(page());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  db = testDb();
  // Docker Desktop's way back to this machine.
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES ('fixture.test', 'Fixture', ?, 'other', 'monitoring', 'done', 0)`,
  ).run(`http://host.docker.internal:${port}/`);
  db.prepare(
    `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES ('b1', 0, 'tyler', 0, 'running')`,
  ).run();
  saveSettings(db, 'fixture.test', { hide: ['#cookie'], mask: [] }, Date.now(), 'tyler');
  const exec = realExec();
  const image = await ensureImage(exec, DOCKER, DIR, () => {});
  if (!image.ok) throw new Error(image.problem);
  deps = {
    db,
    exec,
    docker: DOCKER,
    dir: mkdtempSync(join(tmpdir(), 'kamaji-shots-e2e-')),
    seccomp: join(DIR, 'seccomp.json'),
    image: image.tag,
    now: Date.now,
    log: () => {},
  };
}, 30 * 60_000);

afterAll(() => {
  server?.close();
});

const ask = (kind: 'before' | 'after' | 'manual') =>
  requestSet(
    db,
    { siteId: 'fixture.test', batchId: kind === 'manual' ? null : 'b1', kind, by: null },
    Date.now(),
  )!;

describe('screenshots with the real browser', () => {
  it(
    'shoots “before” twice, hiding the banner, loading lazy images, blocking analytics',
    async () => {
      const id = ask('before');
      await runShots(deps);
      const view = setView(db, id)!;
      expect(view).toMatchObject({ state: 'done', problem: null });
      expect(view.shots.map((s) => [s.viewport, s.status, s.jsErrors, s.failedRequests])).toEqual([
        ['desktop', 200, 0, 0],
        ['mobile', 200, 0, 0],
      ]);
      expect(view.shots[0]).toMatchObject({ width: 1440, quiet: true, cut: false });
      expect(view.shots[1]).toMatchObject({ width: 390 });
      expect(requests.filter((r) => r === '/lazy.svg').length).toBeGreaterThanOrEqual(1);
      const dir = join(deps.dir, 'fixture.test', id);
      expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
      const png = PNG.sync.read(readFileSync(join(dir, 'r1-p0-desktop.png')));
      let banner = 0;
      for (let i = 0; i < png.data.length; i += 4)
        if (
          png.data[i] === BANNER[0] &&
          png.data[i + 1] === BANNER[1] &&
          png.data[i + 2] === BANNER[2]
        )
          banner += 1;
      expect(banner).toBe(0);
    },
    5 * 60_000,
  );

  it(
    'finds no change in the same page, the carousel masked by the two “before” rounds',
    async () => {
      const id = ask('after');
      await runShots(deps);
      const view = setView(db, id)!;
      expect(view.state).toBe('done');
      for (const c of view.comparisons) {
        expect(c).toMatchObject({ compared: 'page', newJsErrors: 0, newFailedRequests: 0 });
        expect(c.changedPct!).toBeLessThan(1);
        expect(c.maskedPct!).toBeGreaterThan(0);
      }
    },
    5 * 60_000,
  );

  it(
    'catches the broken page: taller, a red header, a new JavaScript error',
    async () => {
      mode = 'broken';
      const id = ask('after');
      await runShots(deps);
      const view = setView(db, id)!;
      for (const c of view.comparisons) {
        expect(c).toMatchObject({ compared: 'first screen', newJsErrors: 1 });
        expect(c.heightAfter! - c.heightBefore!).toBeGreaterThanOrEqual(400);
        expect(c.changedPct!).toBeGreaterThan(1);
        expect(c.diff).toMatch(/^\/api\/screenshots\/[0-9a-f]{16}\/diff-p0-(desktop|mobile)\.png$/);
      }
    },
    5 * 60_000,
  );
});
