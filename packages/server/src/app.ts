// The HTTP app. It listens on 127.0.0.1 only; `tailscale serve` puts it on the tailnet and sets
// Tailscale-User-Login to the caller's real login (replacing any forged one). Every request must
// carry the one allowed login, as the Calcifer dashboard does. No login configured, nobody gets in.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Db } from './db.js';
import {
  activity,
  listServers,
  overview,
  siteSummaries,
  status,
  type StatusInput,
} from './queries.js';

export interface AppOptions {
  db: Db;
  login: string;
  webDist: string;
  statusInput: () => StatusInput;
  log?: (message: string) => void;
}

export function createApp({ db, login, webDist, statusInput, log }: AppOptions): Hono {
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
    await next();
  });

  app.get('/api/status', (c) => c.json(status(db, statusInput())));
  app.get('/api/overview', (c) => c.json(overview(db)));
  app.get('/api/sites', (c) => c.json({ sites: siteSummaries(db) }));
  app.get('/api/servers', (c) => c.json({ servers: listServers(db) }));
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
