// The HTTP app. It listens on 127.0.0.1 only; `tailscale serve` puts it on the tailnet and sets
// Tailscale-User-Login to the caller's real login (replacing any forged one). Every request must
// carry the one allowed login, as the Calcifer dashboard does. No login configured, nobody gets in.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  ApproveRequest,
  ConfigureSiteRequest,
  WholeSiteRequest,
  NewSiteRequest,
  PasskeyChallengeRequest,
  ProposeRequest,
  RemoveSiteRequest,
  type PasskeysResponse,
  type BackupExpectation,
  type UpdatesResponse,
} from '@kamaji/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { openDownload, type FetchExport } from './backups/download.js';
import { latestExport, recordEvidence, siteBackups } from './backups/evidence.js';
import { requestWholeSite } from './sitebackups/view.js';
import type { CareKeys } from './care/keys.js';
import { pluginZip } from './care/zip.js';
import { reportSite } from './inventory/report.js';
import { checkSites } from './checks/sites.js';
import { latestObservations } from './observations.js';
import { approveBatch, batchViews, carryOn } from './updates/batches.js';
import type { Backup } from './updater/backup.js';
import type { UpdaterStart } from './updates/launcher.js';
import { checkWrite, issueNonce, type PasskeyConfig } from './passkeys/guard.js';
import { challengeFor } from './passkeys/webauthn.js';
import { latestProposal, proposeBatch } from './updates/proposals.js';
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
  /** The craftish export the updater runs before a batch, for "Back up now" (updater/backup.ts). */
  backup?: Backup;
  /** One export from craftish, streamed for "Download latest export" (backups/download.ts). */
  fetchExport?: FetchExport;
  /** Wakes the backups process for a request from a site's Backups panel. */
  startBackups?: () => void;
  /** The passkeys writes need (TY-170). Without it, every guarded write is refused. */
  passkeys?: PasskeyConfig;
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

/**
 * The one write a caller without the page's Origin may make: proposing a batch (Calcifer's
 * prepare_batch, from the mini). Browsers send an Origin with every POST, so a request without
 * one isn't a page Tyler has open; one with a foreign Origin is still refused. A proposal can't
 * approve, start or change anything else (updates/proposals.ts), so this is the whole of what a
 * local caller gets beyond reading.
 */
const ORIGINLESS_WRITES = new Set(['POST /api/proposals']);

/**
 * Writes that don't need a passkey (TY-170): a proposal (it starts nothing), asking for a
 * passkey's nonce, adding a site (it starts unconfigured, with no permission), and setup steps
 * that only ask the site read-only questions. Every other write, including any added later,
 * needs one.
 */
const PASSKEY_FREE = new Set([
  'POST /api/proposals',
  'POST /api/passkeys/challenge',
  'POST /api/sites',
]);
const PASSKEY_FREE_SITE_STEP = /^\/api\/sites\/[^/]+\/(mode|handshake|report)$/;

const passkeyFree = (method: string, path: string) =>
  PASSKEY_FREE.has(`${method} ${path}`) || (method === 'POST' && PASSKEY_FREE_SITE_STEP.test(path));

const NO_PASSKEYS: PasskeyConfig = {
  load: () => ({ ok: false, problem: 'passkeys aren’t set up' }),
  rpId: '',
  origin: '',
};

function allowedWrite(c: Context): boolean {
  if (sameOrigin(c)) return true;
  return (
    c.req.header('Origin') === undefined && ORIGINLESS_WRITES.has(`${c.req.method} ${c.req.path}`)
  );
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
  backup,
  fetchExport,
  startBackups = () => {},
  passkeys = NO_PASSKEYS,
  now = Date.now,
  log,
}: AppOptions): Hono<{ Variables: { approval: string } }> {
  const app = new Hono<{ Variables: { approval: string } }>();
  /** "Back up now" exports still going, by site: one at a time each. */
  const exporting = new Map<string, number>();

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
    if (!['GET', 'HEAD'].includes(c.req.method) && !allowedWrite(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // A passkey, for every write that starts or changes work on a site.
    const method = c.req.method;
    if (!['GET', 'HEAD'].includes(method) && !passkeyFree(method, c.req.path)) {
      const body = await c.req.text();
      const check = checkWrite(
        db,
        passkeys,
        { header: c.req.header('Kamaji-Passkey'), method, path: c.req.path, body },
        now(),
      );
      if (!check.ok) {
        if (check.error !== 'passkey_required')
          log?.(`passkey: ${method} ${c.req.path} refused: ${check.problem}`);
        const status = { passkey_required: 401, passkey_refused: 403, passkeys_unavailable: 503 }[
          check.error
        ] as 401 | 403 | 503;
        return c.json({ error: check.error }, status);
      }
      c.set('approval', JSON.stringify({ body, proof: check.proof }));
    }
    await next();
  });

  app.get('/api/status', (c) => c.json(status(db, statusInput())));
  // Passkeys (TY-170): which ones Kamaji accepts, and a nonce for one write.
  app.get('/api/passkeys', (c) => {
    const loaded = passkeys.load();
    const body: PasskeysResponse = {
      rpId: passkeys.rpId,
      origin: passkeys.origin,
      installed: loaded.ok ? loaded.passkeys.map((p) => ({ id: p.id, label: p.label })) : [],
      problem: loaded.ok ? null : loaded.problem,
    };
    return c.json(body);
  });
  app.post('/api/passkeys/challenge', async (c) => {
    const body = await readJson(c, PasskeyChallengeRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const loaded = passkeys.load();
    if (!loaded.ok) return c.json({ error: 'passkeys_unavailable' }, 503);
    const nonce = issueNonce(db, now());
    return c.json({
      nonce,
      challenge: challengeFor(nonce, body.method, body.path, body.bodySha256),
      rpId: passkeys.rpId,
      ids: loaded.passkeys.map((p) => p.id),
    });
  });
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
  // A site's backup evidence, and "Back up now": the export a run makes first, recorded the same
  // way (backups/evidence.ts). It can take minutes, so it runs in the background and the page
  // asks again.
  const backupSite = (id: string) =>
    db
      .prepare(
        'SELECT id, host_kind, backup_expectation FROM sites WHERE id = ? AND removed_at IS NULL',
      )
      .get(id);
  app.get('/api/sites/:id/backups', (c) => {
    const row = backupSite(c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    const id = String(row.id);
    return c.json(
      siteBackups(
        db,
        {
          id,
          hostKind: String(row.host_kind),
          backupExpectation:
            row.backup_expectation === null
              ? null
              : (String(row.backup_expectation) as BackupExpectation),
        },
        exporting.get(id),
      ),
    );
  });
  app.post('/api/sites/:id/backups', (c) => {
    const row = backupSite(c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    const id = String(row.id);
    const hostKind = String(row.host_kind);
    if (hostKind !== 'craftish') return c.json({ error: 'not_craftish' }, 400);
    if (!backup) return c.json({ error: 'not_set_up' }, 409);
    if (exporting.has(id)) return c.json({ error: 'already_exporting' }, 409);
    const updating = db
      .prepare("SELECT 1 FROM batch_sites WHERE site_id = ? AND state = 'running'")
      .get(id);
    if (updating) return c.json({ error: 'updating' }, 409);
    exporting.set(id, now());
    void backup({ id, hostKind })
      .catch(() => ({ ok: false, words: 'The export couldn’t be asked for', answer: undefined }))
      .then((result) => {
        recordEvidence(db, {
          siteId: id,
          batchId: null,
          requestedBy: login,
          at: now(),
          ok: result.ok,
          words: result.words,
          answer: result.answer,
        });
        log?.(`backup now: ${id} ${result.ok ? 'exported' : 'failed'}`);
      })
      .finally(() => exporting.delete(id));
    return c.json({ started: true }, 202);
  });
  // The latest export, from craftish to the browser; nothing is kept on the mini.
  app.get('/api/sites/:id/backups/download', async (c) => {
    const row = backupSite(c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    const id = String(row.id);
    if (String(row.host_kind) !== 'craftish') return c.json({ error: 'not_craftish' }, 400);
    const latest = latestExport(db, id);
    if (!latest) return c.json({ error: 'no_export' }, 404);
    const stream = fetchExport?.(id, latest.at);
    if (!stream) return c.json({ error: 'not_set_up' }, 409);
    const opened = await openDownload(stream, ({ sha256, exit }) => {
      if (exit !== 0) log?.(`download: ${id} stopped early`);
      else if (latest.sha256 && sha256 !== latest.sha256)
        log?.(`download: ${id} differs from its recorded SHA-256`);
      else log?.(`download: ${id} sent`);
    });
    if (!opened.ok) return c.json({ error: 'export_unavailable', problem: opened.problem }, 502);
    return new Response(opened.body, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${id}-${latest.at}.sql.gz"`,
        'Cache-Control': 'no-store',
      },
    });
  });
  // Whole-site backups: asks the backups process, which holds restic and the pull key.
  app.post('/api/sites/:id/backups/whole-site', async (c) => {
    const body = await readJson(c, WholeSiteRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const row = backupSite(c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    const result = requestWholeSite(db, String(row.id), body.kind, login, now());
    if (result === 'not-active') return c.json({ error: 'not_active' }, 409);
    if (result === 'already') return c.json({ error: 'already_requested' }, 409);
    startBackups();
    return c.json({ queued: true }, 202);
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
    const result = configureSite(db, c.req.param('id'), body, now(), login);
    if (result === 'not-found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not-craftish') return c.json({ error: 'not_craftish' }, 400);
    if (result === 'no-consent') return c.json({ error: 'no_consent' }, 400);
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
    let body: UpdatesResponse;
    if (site === undefined) {
      const q = queue(db);
      body = { ...q, batches: batchViews(db, 50), proposal: latestProposal(db, q.items) };
    } else {
      body = { ...queue(db, site), batches: batchViews(db, 1, site), proposal: null };
    }
    return c.json(body);
  });
  // A proposed batch: ticked in Updates with its notes, for Tyler to review and approve. Never an
  // approval; the only write open to a caller without the page's Origin (allowedWrite, above).
  app.post('/api/proposals', async (c) => {
    const body = await readJson(c, ProposeRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = proposeBatch(db, body, now());
    return c.json(result, result.ok ? 201 : 409);
  });
  app.post('/api/batches', async (c) => {
    const body = await readJson(c, ApproveRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const keys = care.keys;
    const result = await approveBatch(
      db,
      body,
      login,
      now,
      async (siteId) => {
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
      },
      c.get('approval'),
    );
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
