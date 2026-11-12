// The HTTP app. It listens on 127.0.0.1 only; `tailscale serve` puts it on the tailnet and sets
// Tailscale-User-Login to the caller's real login (replacing any forged one). Every request must
// carry the one allowed login, as the Calcifer dashboard does. No login configured, nobody gets in.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  ApproveRequest,
  ConfigureSiteRequest,
  NewSiteRequest,
  RemoveSiteRequest,
  type UpdatesResponse,
} from '@kamaji/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CareKeys } from './care/keys.js';
import { pluginZip } from './care/zip.js';
import { reportSite } from './inventory/report.js';
import { checkSites } from './checks/sites.js';
import { latestObservations } from './observations.js';
import { approveBatch, batchViews, carryOn } from './updates/batches.js';
import type { UpdaterStart } from './updates/launcher.js';
import { queue } from './updates/queue.js';
import type { Db } from './db.js';
import { jobDetail, type JobFiles } from './molcajete/detail.js';
import {
  activity,
  overview,
  serverSummaries,
  siteSummaries,
  status,
  type StatusInput,
} from './queries.js';
import {
  chooseMode,
  configureSite,
  createSite,
  handshake,
  removeSite,
  siteDetail,
  type CareSend,
} from './sites/setup.js';

export interface AppOptions {
  db: Db;
  login: string;
  webDist: string;
  statusInput: () => StatusInput;
  /** Whether the Worker's outside checks are set up. */
  workerOn?: boolean;
  /** Where molcajete's job logs and crash log are, for one job's details. */
  jobFiles?: JobFiles;
  /** craftish-care: Kamaji's keys (undefined where connecting isn't set up), the plugin's source and the sender. */
  care?: { keys: CareKeys | undefined; pluginDir: string; send: CareSend };
  /** Starts the updater after an approval (updates/launcher.ts). */
  startUpdater?: UpdaterStart;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Writes come only from Kamaji's own page. tailscale serve adds Tyler's login to any request his
 * browser makes, including one a hostile page triggers, so a write must be JSON (a form can't
 * send that without a preflight) and its Origin must be this host.
 */
function sameOrigin(c: Context): boolean {
  const origin = c.req.header('Origin');
  const host = c.req.header('Host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  if (!(c.req.header('Content-Type') ?? '').startsWith('application/json')) return null;
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : null;
}

const MODE = z.object({ mode: z.enum(['connected', 'monitoring']) });

export function createApp({
  db,
  login,
  webDist,
  statusInput,
  workerOn = false,
  jobFiles,
  care,
  startUpdater = () => {},
  now = Date.now,
  log,
}: AppOptions): Hono {
  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    log?.(`${c.req.method} ${c.req.path} ${c.res.status}`);
  });

  app.use(async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    // Emotion injects <style> tags at runtime, hence 'unsafe-inline' for styles only.
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const who = (c.req.header('Tailscale-User-Login') ?? '').trim().toLowerCase();
    if (!login || who !== login) return c.json({ error: 'forbidden' }, 403);
    if (!['GET', 'HEAD'].includes(c.req.method) && !sameOrigin(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  app.get('/api/status', (c) => c.json(status(db, statusInput())));
  app.get('/api/overview', (c) => c.json(overview(db)));
  app.get('/api/sites', (c) => c.json({ sites: siteSummaries(db, workerOn) }));
  // Add site and Remove (sites/setup.ts).
  app.post('/api/sites', async (c) => {
    const body = await readJson(c, NewSiteRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = createSite(db, body, now());
    return 'error' in result ? c.json(result, 409) : c.json(result, 201);
  });
  app.get('/api/sites/:id', (c) => {
    const detail = siteDetail(db, c.req.param('id'), { workerOn, canConnect: Boolean(care?.keys) });
    return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/api/sites/:id/mode', async (c) => {
    const body = await readJson(c, MODE);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    if (body.mode === 'connected' && !care?.keys) return c.json({ error: 'not_set_up' }, 409);
    return chooseMode(db, c.req.param('id'), body.mode)
      ? c.json({ ok: true })
      : c.json({ error: 'not_found' }, 404);
  });
  app.get('/api/sites/:id/craftish-care.zip', (c) => {
    const detail = siteDetail(db, c.req.param('id'), { workerOn, canConnect: Boolean(care?.keys) });
    // Connecting: a new site that chose to, or one already set up as monitoring only.
    if (!detail || (detail.site.mode !== 'connected' && detail.site.setup !== 'done')) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const zip = pluginZip(care.pluginDir, care.keys, detail.site.id, new Date(now()));
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="craftish-care.zip"',
      'Cache-Control': 'no-store',
    });
  });
  app.post('/api/sites/:id/handshake', async (c) => {
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const result = await handshake(db, c.req.param('id'), care.keys, care.send, now);
    return result ? c.json(result) : c.json({ error: 'not_found' }, 404);
  });
  // Refresh now: a report with WordPress's own update checks first (the plugin allows one per 10 minutes).
  app.post('/api/sites/:id/report', async (c) => {
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const site = siteDetail(db, c.req.param('id'), { workerOn, canConnect: true })?.site;
    if (!site || site.mode !== 'connected' || site.setup !== 'done') {
      return c.json({ error: 'not_found' }, 404);
    }
    const ok = await reportSite(db, site, care.keys, care.send, now, { refresh: true });
    return c.json({ ok });
  });
  app.post('/api/sites/:id/configure', async (c) => {
    const body = await readJson(c, ConfigureSiteRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = configureSite(db, c.req.param('id'), body, now());
    if (result === 'not-found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not-craftish') return c.json({ error: 'not_craftish' }, 400);
    return c.json({ ok: true });
  });
  app.post('/api/sites/:id/remove', async (c) => {
    const body = await readJson(c, RemoveSiteRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = await removeSite(
      db,
      c.req.param('id'),
      body.confirm,
      care?.keys,
      care?.send ?? (async () => ({ ok: false, status: null, code: null, problem: 'Not set up' })),
      now,
    );
    if (result === 'not-found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not-confirmed') return c.json({ error: 'not_confirmed' }, 400);
    return c.json(result);
  });
  // Updates: the queue, approving a batch, and a held site's options (updates/).
  // With ?site=, one site's page: what's waiting there and its latest run.
  app.get('/api/updates', (c) => {
    const site = c.req.query('site');
    const body: UpdatesResponse =
      site === undefined
        ? { ...queue(db), batches: batchViews(db) }
        : { ...queue(db, site), batches: batchViews(db, 1, site) };
    return c.json(body);
  });
  app.post('/api/batches', async (c) => {
    const body = await readJson(c, ApproveRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const keys = care.keys;
    const result = await approveBatch(db, body, login, now, async (siteId) => {
      const site = db.prepare('SELECT id, name, url FROM sites WHERE id = ?').get(siteId);
      if (!site) return false;
      return reportSite(
        db,
        { id: String(site.id), name: String(site.name), url: String(site.url) },
        keys,
        care.send,
        now,
        { refresh: true },
      );
    });
    if (result.ok) startUpdater();
    // 200 either way: "changed" is an answer to show, with its list, not an error.
    return c.json(result, result.ok ? 201 : 200);
  });
  app.post('/api/batches/:id/sites/:site/carry-on', (c) => {
    if (!carryOn(db, c.req.param('id'), c.req.param('site'), login, now())) {
      return c.json({ error: 'not_found' }, 404);
    }
    startUpdater();
    return c.json({ ok: true });
  });
  // Re-run the checks: the home page from the mini, recorded like any check.
  app.post('/api/batches/:id/sites/:site/recheck', async (c) => {
    const siteId = c.req.param('site');
    await checkSites(db, { now, signal: AbortSignal.timeout(60_000), only: [siteId] });
    const [last] = latestObservations<{ problem: string | null }>(
      db,
      'site',
      siteId,
      'http',
      'mini',
      1,
    );
    return c.json({ ok: last?.ok ?? false, problem: last?.value.problem ?? null });
  });

  app.get('/api/servers', (c) => c.json({ servers: serverSummaries(db) }));
  app.get('/api/servers/molcajete/jobs/:name', (c) => {
    const detail = jobFiles ? jobDetail(db, c.req.param('name'), jobFiles) : null;
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });
  app.get('/api/activity', (c) => {
    const before = Number(c.req.query('before'));
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
    return c.json(activity(db, Number.isInteger(before) && before > 0 ? before : null, limit));
  });
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  // The built web app. Hashed assets cache for a year; anything else falls back to the page.
  // (serveStatic's onFound runs after the response is built, so headers are set here instead.)
  const index = join(webDist, 'index.html');
  app.use('*', async (c, next) => {
    await next();
    if (c.res.status !== 200) return;
    c.res.headers.set(
      'Cache-Control',
      c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
  });
  app.use('*', serveStatic({ root: webDist }));
  app.get('/assets/*', (c) => c.text('Not found', 404));
  app.get('*', serveStatic({ path: index }));
  app.get('*', (c) =>
    c.text(existsSync(index) ? 'Not found' : 'The web app is not built: npm run build', 404),
  );

  return app;
}
