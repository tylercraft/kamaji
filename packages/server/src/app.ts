// The HTTP app. It listens on 127.0.0.1 only; `tailscale serve` puts it on the tailnet and sets
// Tailscale-User-Login to the caller's real login (replacing any forged one). Every request must
// carry the one allowed login, as the Calcifer dashboard does. No login configured, nobody gets in.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie } from 'hono/cookie';
import {
  ApproveRequest,
  ConfigureSiteRequest,
  KinstaAccessInput,
  RollbackCountRequest,
  ScreenshotSettings,
  RollbackRequest,
  RuleBody,
  type RuleSaved,
  type RulePreview,
  type RulesResponse,
  UndoRequest,
  DetectPlatformRequest,
  type DetectPlatformResponse,
  WholeSiteRequest,
  NewSiteRequest,
  PasskeyChallengeRequest,
  ProposeRequest,
  RemoveSiteRequest,
  type PasskeysResponse,
  type SiteIconStatus,
  type RecheckAllResponse,
  type SiteIconsResponse,
  type BackupExpectation,
  type UpdatesResponse,
  type SettingsResponse,
  UpdateTime,
  SeenRequest,
} from '@kamaji/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { openDownload, type FetchExport } from './backups/download.js';
import { latestExport, recordEvidence, siteBackups } from './backups/evidence.js';
import { okSize, requestTest, saveAccess } from './sitebackups/kinsta.js';
import { requestRollback, requestUndo, siteRollback } from './rollback/request.js';
import { countView, requestCount } from './rollback/count.js';
import { requestWholeSite } from './sitebackups/view.js';
import type { CareKeys } from './care/keys.js';
import { pluginZip } from './care/zip.js';
import { reportAll, reportSite } from './inventory/report.js';
import { iconStatus, iconVersions, refetchIcon, siteNames, storedIcon } from './checks/icons.js';
import { checkDomain, siteDomain } from './checks/domains.js';
import { detectPlatform } from './checks/platform.js';
import { checkServer, type ServerCheckOptions } from './checks/serverCheck.js';
import { checkSites, type SiteCheckers } from './checks/sites.js';
import { checkEndOfLife } from './endOfLife/check.js';
import { judgeAbandoned } from './inventory/directory.js';
import { dismissIssue, undismissIssue } from './issues.js';
import { judgeVulnerabilities } from './wordfence/feed.js';
import { latestObservations } from './observations.js';
import { approveBatch, batchViews, carryOn } from './updates/batches.js';
import type { Backup } from './updater/backup.js';
import type { UpdaterStart } from './updates/launcher.js';
import { checkWrite, issueNonce, type PasskeyConfig } from './passkeys/guard.js';
import { challengeFor } from './passkeys/webauthn.js';
import { latestProposal, proposeBatch } from './updates/proposals.js';
import { queue } from './updates/queue.js';
import { NOT_LISTED, type OrgLookup } from './rules/org.js';
import { labelQueue, pauseRun, rulePreview, ruleViews } from './rules/runs.js';
import { bodyProblem, deleteRule, pauseRule, ruleRow, ruleSites, saveRule } from './rules/store.js';
import type { Db } from './db.js';
import { readUpdateTime, writeUpdateTime } from './settings.js';
import { markSeen, news } from './viewers.js';
import { recordEvent } from './events.js';
import { requestSet, saveSettings, setFile, siteScreenshots } from './shots/sets.js';
import { updateTimes } from './sitebackups/schedule.js';
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
  /** Wakes the screenshots process for Take screenshots now (shots/main.ts). */
  startShots?: () => void;
  /** Where screenshot sets' images are (config.ts, shotsDir). Without it, none are served. */
  shotsDir?: string;
  /** The passkeys writes need (TY-170). Without it, every guarded write is refused. */
  passkeys?: PasskeyConfig;
  /** Where sites' icons are kept (checks/icons.ts). Without it, no site has one. */
  iconsDir?: string;
  /** Where icons are fetched from; tests stand in for the web. */
  iconFetch?: typeof fetch;
  /** The home page and certificate checks; tests stand in for the web. */
  siteCheckers?: SiteCheckers;
  /** Where domains' renewal dates are read from (checks/domains.ts); tests stand in for RDAP. */
  rdapFetch?: typeof fetch;
  /** What Check now needs to read a server (checks/serverCheck.ts). Without it, it's refused. */
  serverCheck?: ServerCheckOptions;
  /** wordpress.org's release dates, for rules (rules/org.ts). Without it, none are known. */
  org?: OrgLookup;
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
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
  // Recheck all: a report from each connected site, which changes nothing on any of them.
  'POST /api/sites/report',
  // Add site's look at a home page: the plain GET the icon fetch makes.
  'POST /api/sites/detect',
  // Opening a page: when this viewer last looked, for "new" dots. Nothing on any site.
  'POST /api/me/seen',
  // The rule editor's preview: what a rule as written would take, read only. Nothing is saved.
  'POST /api/rules/preview',
]);
// Refetch icon: the plain GETs of the home page and its icon, as when the site was added.
// Check: the cycle's home page and certificate checks, for one site (an issue's Check again).
// Domain check: the daily RDAP read of the site's renewal date, now.
// Kinsta's Test connection: fixed read-only commands over SSH (kinsta-pull/test). Saving the
// access and okaying a size take a passkey.
// Rollback's count: orders, comments and users since the restore point, read only, for the
// dialog before the passkey.
// Take screenshots now: the site's check pages in a headless browser, read only.
// Pausing a rule, or a rule's run before it starts: it only stops something. Resuming is signing
// the rule again.
const PASSKEY_FREE_SITE_STEP =
  /^\/api\/sites\/[^/]+\/(mode|handshake|report|check|icon\/refetch|domain\/check|kinsta\/test|rollback\/count|screenshots)$/;
// Check now, for a server: the cycle's read of it (its report, or molcajete's readers), on demand.
const PASSKEY_FREE_SERVER_STEP = /^\/api\/servers\/[^/]+\/check$/;
// Undo a dismissal: it only shows a warning again. Dismissing hides one, so it takes a passkey.
const PASSKEY_FREE_ISSUE_STEP = /^\/api\/issues\/[^/]+\/undismiss$/;
const PASSKEY_FREE_PAUSE = /^\/api\/(rules|batches)\/[^/]+\/pause$/;

/**
 * One passkey for a run of writes: any signed write that succeeds opens a 10-minute window in which
 * that browser's other passkey writes go through without one. A random token in an HttpOnly,
 * SameSite=Strict cookie for /api; Kamaji keeps the token's hash in memory, not the database,
 * since anything on the mini can write the database. It's fixed from the signing, not extended
 * by use, and a restart closes it.
 *
 * Approving a batch always signs: the updater checks that approval's own signature again before
 * it runs anything (passkeys/guard.ts, approvalProblem), so a batch written straight into the
 * database doesn't run. An approval sent under the window would have no signature to check. A
 * rollback and its undo the same: the backups process checks theirs before it pushes
 * (rollbackApprovalProblem). A rule, too: each version is its approval for every run it makes,
 * checked by the updater (rules/check.ts).
 */
export const PASSKEY_WINDOW_MS = 10 * 60_000;
const WINDOW_COOKIE = 'kamaji_passkey';
const SIGN_EACH_TIME = /^\/api\/(batches|rules|sites\/[^/]+\/rollback(\/undo)?)$/;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');

const passkeyFree = (method: string, path: string) =>
  PASSKEY_FREE.has(`${method} ${path}`) ||
  (method === 'POST' &&
    [
      PASSKEY_FREE_SITE_STEP,
      PASSKEY_FREE_SERVER_STEP,
      PASSKEY_FREE_ISSUE_STEP,
      PASSKEY_FREE_PAUSE,
    ].some((step) => step.test(path)));

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
  startShots = () => {},
  shotsDir,
  passkeys = NO_PASSKEYS,
  org = async () => NOT_LISTED,
  iconsDir,
  iconFetch,
  siteCheckers,
  rdapFetch,
  serverCheck,
  now = Date.now,
  log,
}: AppOptions): Hono<{ Variables: { approval: string } }> {
  const app = new Hono<{ Variables: { approval: string } }>();
  /** Open passkey windows: the token's hash, and when it closes. */
  const passkeyWindows = new Map<string, number>();
  /** Servers being checked now: one Check now at a time each. */
  const checkingServers = new Set<string>();
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
    const guarded = !['GET', 'HEAD'].includes(method) && !passkeyFree(method, c.req.path);
    if (guarded && !(method === 'POST' && SIGN_EACH_TIME.test(c.req.path))) {
      for (const [hash, closes] of passkeyWindows) if (closes <= now()) passkeyWindows.delete(hash);
      const token = getCookie(c, WINDOW_COOKIE);
      if (token && passkeyWindows.has(tokenHash(token))) return next();
    }
    if (guarded) {
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
    // Here only after a signed write: one under the window returned above.
    if (guarded && c.res.status >= 200 && c.res.status < 300) {
      const token = randomBytes(32).toString('base64url');
      passkeyWindows.set(tokenHash(token), now() + PASSKEY_WINDOW_MS);
      setCookie(c, WINDOW_COOKIE, token, {
        path: '/api',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        maxAge: PASSKEY_WINDOW_MS / 1000,
      });
    }
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
  app.get('/api/overview', (c) => c.json(overview(db, now())));

  // Settings: the weekly update time. Changing it moves every site's backup night, so it's a
  // write like any other, behind a passkey.
  const settings = (): SettingsResponse => {
    const updateTime = readUpdateTime(db);
    return {
      updateTime,
      nextUpdateAt: new Date(updateTimes(now(), updateTime).next).toISOString(),
    };
  };
  app.get('/api/settings', (c) => c.json(settings()));

  // What's new for this viewer (viewers.ts): the shell polls it for tab dots and run toasts.
  app.get('/api/me/news', (c) => c.json(news(db, login, now())));
  app.post('/api/me/seen', async (c) => {
    const body = await readJson(c, SeenRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    markSeen(db, login, body.page, now());
    return c.json({ ok: true });
  });
  app.post('/api/settings/update-time', async (c) => {
    const body = await readJson(c, UpdateTime);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const before = readUpdateTime(db);
    writeUpdateTime(db, body, now(), login);
    if (before.weekday !== body.weekday || before.hour !== body.hour)
      recordEvent(db, now(), {
        kind: 'kamaji.update-time',
        summary: `Update time set to ${WEEKDAYS[body.weekday]} ${String(body.hour).padStart(2, '0')}:00 NZ time (by ${login})`,
      });
    return c.json(settings());
  });
  app.get('/api/sites', (c) => c.json({ sites: siteSummaries(db, workerOn) }));
  // Add site and Remove (sites/setup.ts).
  app.post('/api/sites', async (c) => {
    const body = await readJson(c, NewSiteRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = createSite(db, body, now());
    if ('error' in result) return c.json(result, 409);
    // Its icon, once, in the background: adding never waits on the site.
    if (iconsDir)
      void refetchIcon(db, result.id, {
        dir: iconsDir,
        now,
        ...(iconFetch ? { fetch: iconFetch } : {}),
      }).catch(() => log?.('icons: fetching a new site’s icon failed'));
    return c.json(result, 201);
  });
  // Add site's guess at the platform: one GET of the home page, as the icon fetch makes it.
  app.post('/api/sites/detect', async (c) => {
    const body = await readJson(c, DetectPlatformRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const answer: DetectPlatformResponse = await detectPlatform(
      body.url,
      iconFetch ? { fetch: iconFetch } : {},
    );
    return c.json(answer);
  });
  // Sites' icons, fetched by Kamaji (checks/icons.ts): which sites have one, then each one's
  // bytes. Served as an image only, with nothing it could load or run, so an SVG stays a picture.
  app.get('/api/site-icons', (c) => {
    const body: SiteIconsResponse = {
      icons: iconsDir ? iconVersions(db) : {},
      names: siteNames(db),
    };
    return c.json(body);
  });
  app.post('/api/sites/:id/icon/refetch', async (c) => {
    if (!iconsDir) return c.json({ error: 'not_set_up' }, 409);
    const id = c.req.param('id');
    const done = await refetchIcon(db, id, {
      dir: iconsDir,
      now,
      ...(iconFetch ? { fetch: iconFetch } : {}),
    });
    const icon = done && iconStatus(db, id);
    if (!icon) return c.json({ error: 'not_found' }, 404);
    const body: SiteIconStatus = icon;
    return c.json(body);
  });
  app.get('/api/sites/:id/icon', (c) => {
    const icon = iconsDir ? storedIcon(db, iconsDir, c.req.param('id')) : null;
    if (!icon) return c.json({ error: 'not_found' }, 404);
    const etag = `"${icon.sha256}"`;
    const headers = {
      'Content-Type': icon.type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, max-age=86400',
      ETag: etag,
    };
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(icon.bytes), 200, headers);
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
    if (
      !detail ||
      detail.site.platform !== 'wordpress' ||
      (detail.site.mode !== 'connected' && detail.site.setup !== 'done')
    ) {
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
  // Only WordPress backs up: a static site or an app has nothing to export or pull. Its evidence
  // still reads (there's none), so its page needn't ask differently.
  const siteRowFor = (id: string) =>
    db
      .prepare(
        `SELECT id, host_kind, backup_expectation, platform FROM sites
         WHERE id = ? AND removed_at IS NULL`,
      )
      .get(id);
  const backupSite = (id: string) => {
    const row = siteRowFor(id);
    return row?.platform === 'wordpress' ? row : undefined;
  };
  app.get('/api/sites/:id/backups', (c) => {
    const row = siteRowFor(c.req.param('id'));
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
        now(),
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
  // Rollback (rollback/): what it would do, and asking for it or its undo, each signed with the
  // passkey, never under the window. The backups process takes what's asked, and checks the
  // signature again first. The database box's count comes before: no passkey, read only.
  app.get('/api/sites/:id/rollback', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ? AND removed_at IS NULL').get(id))
      return c.json({ error: 'not_found' }, 404);
    return c.json(siteRollback(db, id, now()));
  });
  app.post('/api/sites/:id/rollback/count', async (c) => {
    const body = await readJson(c, RollbackCountRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = requestCount(db, c.req.param('id'), body, now());
    if (!result.ok) return c.json({ error: result.error, problem: result.why }, 409);
    startBackups();
    return c.json({ queued: true, id: result.id }, 202);
  });
  app.get('/api/sites/:id/rollback/count/:count', (c) => {
    const view = countView(db, c.req.param('id'), c.req.param('count'));
    return view ? c.json(view) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/api/sites/:id/rollback', async (c) => {
    const body = await readJson(c, RollbackRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = requestRollback(db, c.req.param('id'), body, login, now(), c.get('approval'));
    if (!result.ok) return c.json({ error: result.error, problem: result.why }, 409);
    startBackups();
    return c.json({ queued: true, id: result.id }, 202);
  });
  app.post('/api/sites/:id/rollback/undo', async (c) => {
    const body = await readJson(c, UndoRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = requestUndo(db, c.req.param('id'), body, login, now(), c.get('approval'));
    if (!result.ok) return c.json({ error: result.error, problem: result.why }, 409);
    startBackups();
    return c.json({ queued: true, id: result.id }, 202);
  });
  // Kinsta's SSH access for whole-site backups (sitebackups/kinsta.ts): saved here; tested, and
  // pulled, by the backups process, which holds the key.
  // Screenshot checks (shots/): a site's latest set, Take screenshots now (no passkey: it changes
  // nothing on the site), what's hidden and masked (a passkey, as Configure), and the images,
  // only those a set's rows name.
  app.get('/api/sites/:id/screenshots', (c) => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ? AND removed_at IS NULL').get(id))
      return c.json({ error: 'not_found' }, 404);
    return c.json(siteScreenshots(db, id));
  });
  app.post('/api/sites/:id/screenshots', (c) => {
    const id = requestSet(
      db,
      { siteId: c.req.param('id'), batchId: null, kind: 'manual', by: login },
      now(),
    );
    if (!id) return c.json({ error: 'not_found' }, 404);
    startShots();
    return c.json({ queued: true, id }, 202);
  });
  app.post('/api/sites/:id/screenshots/settings', async (c) => {
    const body = await readJson(c, ScreenshotSettings);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    if (!saveSettings(db, c.req.param('id'), body, now(), login))
      return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });
  app.get('/api/screenshots/:set/:file', async (c) => {
    const found = shotsDir ? setFile(db, shotsDir, c.req.param('set'), c.req.param('file')) : null;
    if (!found) return c.json({ error: 'not_found' }, 404);
    let bytes: Buffer;
    try {
      bytes = await readFile(found.path);
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': found.type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });
  app.post('/api/sites/:id/kinsta', async (c) => {
    const body = await readJson(c, KinstaAccessInput);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = saveAccess(db, c.req.param('id'), body, login, now());
    if (result === 'not-kinsta') return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });
  app.post('/api/sites/:id/kinsta/test', (c) => {
    const result = requestTest(db, c.req.param('id'), now());
    if (result === 'no-access') return c.json({ error: 'not_found' }, 404);
    if (result === 'already') return c.json({ error: 'already_requested' }, 409);
    startBackups();
    return c.json({ queued: true }, 202);
  });
  app.post('/api/sites/:id/kinsta/size-ok', (c) => {
    const result = okSize(db, c.req.param('id'), login, now());
    if (result === 'not-needed') return c.json({ error: 'not_needed' }, 409);
    return c.json({ ok: true });
  });
  // Refresh now: a report with WordPress's own update checks first (the plugin allows one per 10 minutes).
  app.post('/api/sites/:id/report', async (c) => {
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const site = siteDetail(db, c.req.param('id'), { workerOn, canConnect: true })?.site;
    if (!site || site.mode !== 'connected' || site.setup !== 'done') {
      return c.json({ error: 'not_found' }, 404);
    }
    const ok = await reportSite(db, site, care.keys, care.send, now, { refresh: true });
    // Its findings judged now from the fresh inventory, as the cycle would: an issue's Refresh
    // inventory clears what the report no longer shows.
    judgeVulnerabilities(db, now());
    judgeAbandoned(db, now());
    checkEndOfLife(db, now());
    return c.json({ ok });
  });
  // Check again: the home page and certificate, for one site, as the cycle checks them.
  app.post('/api/sites/:id/check', async (c) => {
    const siteId = c.req.param('id');
    const checked = await checkSites(db, {
      now,
      signal: AbortSignal.timeout(60_000),
      only: [siteId],
      ...(siteCheckers ? { checkers: siteCheckers } : {}),
    });
    if (checked === 0) return c.json({ error: 'not_found' }, 404);
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
  // Check now, for a server: the cycle's read of it, now. The issues it clears are gone when it
  // answers; the page reloads to show them.
  app.post('/api/servers/:id/check', async (c) => {
    if (!serverCheck) return c.json({ error: 'not_set_up' }, 409);
    const id = c.req.param('id');
    if (checkingServers.has(id)) return c.json({ error: 'already_checking' }, 409);
    checkingServers.add(id);
    try {
      const result = await checkServer(db, id, {
        ...serverCheck,
        now,
        signal: AbortSignal.timeout(120_000),
      });
      if (result === 'not-found') return c.json({ error: 'not_found' }, 404);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'check_failed' }, 504);
    } finally {
      checkingServers.delete(id);
    }
  });
  // Check again, for a site's domain: its renewal date read through RDAP now, as the daily read.
  app.post('/api/sites/:id/domain/check', async (c) => {
    const domain = siteDomain(db, c.req.param('id'));
    if (!domain) return c.json({ error: 'not_found' }, 404);
    const read = await checkDomain(db, domain, { now, ...(rdapFetch ? { fetch: rdapFetch } : {}) });
    return c.json({ ok: read.state !== 'failed', state: read.state });
  });
  // Recheck all: the same, for every connected site that isn't paused, three at a time.
  app.post('/api/sites/report', async (c) => {
    if (!care?.keys) return c.json({ error: 'not_set_up' }, 409);
    const sites = await reportAll(db, { keys: care.keys, send: care.send, now });
    const body: RecheckAllResponse = { sites };
    return c.json(body);
  });
  app.post('/api/sites/:id/configure', async (c) => {
    const body = await readJson(c, ConfigureSiteRequest);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const result = configureSite(db, c.req.param('id'), body, now(), login);
    if (result === 'not-found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not-craftish') return c.json({ error: 'not_craftish' }, 400);
    if (result === 'no-consent') return c.json({ error: 'no_consent' }, 400);
    if (result === 'connected') return c.json({ error: 'connected' }, 409);
    if (result === 'bad-zone') return c.json({ error: 'bad_zone' }, 400);
    if (result === 'kinsta-needs-backups') return c.json({ error: 'kinsta_needs_backups' }, 400);
    if (typeof result === 'object' && 'kinsta' in result)
      return c.json({ error: 'kinsta_not_ready', problem: result.kinsta }, 409);
    if (typeof result === 'object') return c.json({ error: 'bad_page', page: result.refused }, 400);
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
  app.get('/api/updates', async (c) => {
    const site = c.req.query('site');
    let body: UpdatesResponse;
    if (site === undefined) {
      const q = queue(db);
      const items = await labelQueue(db, q.items, now(), org);
      body = { ...q, items, batches: batchViews(db, 50), proposal: latestProposal(db, q.items) };
    } else {
      const q = queue(db, site);
      const items = await labelQueue(db, q.items, now(), org);
      body = { ...q, items, batches: batchViews(db, 1, site), proposal: null };
    }
    return c.json(body);
  });
  // Rules (ops/rules-plan.md): each signed with the passkey, every time, since the signature is
  // what the updater checks before a run the rule makes.
  app.get('/api/rules', async (c) => {
    const body: RulesResponse = {
      rules: await ruleViews(db, now(), org),
      ...ruleSites(db),
      updateTime: readUpdateTime(db),
    };
    return c.json(body);
  });
  app.post('/api/rules', async (c) => {
    const body = await readJson(c, RuleBody);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const problem = bodyProblem(db, body);
    if (problem) return c.json({ error: 'invalid', problem }, 409);
    const saved = saveRule(db, body, c.get('approval'), login, now());
    return c.json({ ok: true, ...saved } satisfies RuleSaved, 201);
  });
  app.post('/api/rules/preview', async (c) => {
    const body = await readJson(c, RuleBody);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const preview: RulePreview = {
      ...(await rulePreview(db, body, now(), org)),
      problem: bodyProblem(db, body),
    };
    return c.json(preview);
  });
  app.post('/api/rules/:id/pause', (c) =>
    ruleRow(db, c.req.param('id')) &&
    pauseRule(db, c.req.param('id'), login, 'Paused by Tyler', now())
      ? c.json({ ok: true })
      : c.json({ error: 'not_found' }, 404),
  );
  app.post('/api/rules/:id/delete', (c) =>
    deleteRule(db, c.req.param('id'), login, now())
      ? c.json({ ok: true })
      : c.json({ error: 'not_found' }, 404),
  );
  app.post('/api/batches/:id/pause', (c) =>
    pauseRun(db, c.req.param('id'), login, now())
      ? c.json({ ok: true })
      : c.json({ error: 'not_found' }, 404),
  );
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
  // Dismiss: hides an issue Kamaji can't check again, until something new happens (issues.ts).
  app.post('/api/issues/:id/dismiss', (c) => {
    const result = dismissIssue(db, now(), c.req.param('id'), login);
    if (result === 'not-found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not-dismissable') return c.json({ error: 'not_dismissable' }, 409);
    return c.json({ ok: true });
  });
  app.post('/api/issues/:id/undismiss', (c) =>
    undismissIssue(db, now(), c.req.param('id'), login)
      ? c.json({ ok: true })
      : c.json({ error: 'not_found' }, 404),
  );
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
