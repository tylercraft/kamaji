// Adding and removing a site (calcifer explore/kamaji.md, "Adding and managing a site"): identify,
// then connect through craftish-care or choose monitoring only, then configure. A setup is saved
// from the first step so it can be resumed. Kamaji never installs the plugin: it offers the zip,
// and the handshake is its first signed request.
import { iconStatus } from '../checks/icons.js';
import { kinstaBlocked, kinstaView } from '../sitebackups/kinsta.js';
import {
  CareHello,
  type ConfigureSiteRequest,
  type Handshake,
  type NewSiteRequest,
  type Platform,
  type RemoveSiteResponse,
  type SiteBackupSchedule,
  type SiteDetailResponse,
} from '@kamaji/shared';
import type { CareResult } from '../care/client.js';
import type { CareKeys, SigningKey } from '../care/keys.js';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { latestObservations, recordObservation } from '../observations.js';
import { siteInventory } from '../inventory/report.js';
import { siteSummaries } from '../queries.js';
import { checkPages, readPages } from './pages.js';
import { validZone } from '../sitebackups/schedule.js';

/** Sends one signed request to a site; careRequest in production, a fake in tests. */
export type CareSend = (
  home: URL,
  key: SigningKey,
  endpoint: string,
  body: Record<string, unknown>,
) => Promise<CareResult>;

const PLATFORM_WORDS: Record<Platform, string> = {
  wordpress: 'WordPress',
  static: 'a static site',
  app: 'an app',
};

type HandshakeValue = { ok: true; hello: CareHello } | { ok: false; problem: string };

type Row = Record<string, unknown>;

function siteRow(db: Db, id: string): Row | undefined {
  return db.prepare('SELECT * FROM sites WHERE id = ? AND removed_at IS NULL').get(id);
}

/** The site's address as stored: its origin, plus WordPress's own path when it isn't at the root. */
function normalizeUrl(raw: string): URL {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

export function createSite(
  db: Db,
  request: NewSiteRequest,
  now: number,
): { id: string } | { error: 'exists' } {
  const url = normalizeUrl(request.url);
  const id = url.host;
  if (db.prepare('SELECT 1 FROM sites WHERE id = ?').get(id)) return { error: 'exists' };
  // A static site or an app has no Craftish Care to connect: straight to Configure.
  const setup = request.platform === 'wordpress' ? 'connect' : 'configure';
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, client_slug, mode, platform, setup, created_at)
     VALUES (?, ?, ?, ?, ?, 'monitoring', ?, ?, ?)`,
  ).run(
    id,
    request.name,
    url.href,
    request.hostKind,
    request.clientSlug,
    request.platform,
    setup,
    now,
  );
  recordEvent(db, now, {
    kind: 'site.setup-started',
    summary: `Started adding ${request.name}`,
    resourceType: 'site',
    resourceId: id,
  });
  return { id };
}

/** Step 2, either way. Connecting stays on this step until a handshake succeeds. */
export function chooseMode(db: Db, id: string, mode: 'connected' | 'monitoring'): boolean {
  // Only WordPress connects; a static site or an app is monitoring only by design.
  const result = db
    .prepare(
      `UPDATE sites SET mode = ?, setup = CASE WHEN ? = 'monitoring' THEN 'configure' ELSE setup END
       WHERE id = ? AND removed_at IS NULL AND setup = 'connect'
       AND (? = 'monitoring' OR platform = 'wordpress')`,
    )
    .run(mode, mode, id, mode);
  return Number(result.changes) === 1;
}

function latestHandshake(db: Db, id: string): Handshake | null {
  const [last] = latestObservations<HandshakeValue>(db, 'site', id, 'hello', 'plugin', 1);
  return last ? { at: new Date(last.at).toISOString(), result: last.value } : null;
}

/**
 * The handshake: craftish-care's hello, signed with the report key. A partial answer is a site
 * with gaps, not a failure. A site already set up as monitoring only (M2's estate, like the M3
 * pilot) connects the same way: it keeps its checks and settings, and becomes connected only
 * once the handshake succeeds, so a half-finished install never shows as a failing report.
 */
export async function handshake(
  db: Db,
  id: string,
  keys: CareKeys,
  send: CareSend,
  now: () => number,
): Promise<Handshake | null> {
  const row = siteRow(db, id);
  if (!row || row.platform !== 'wordpress') return null;
  if (row.mode !== 'connected' && row.setup !== 'done') return null;
  const result = await send(new URL(String(row.url)), keys.report, 'hello', {});
  let value: HandshakeValue;
  if (!result.ok) {
    value = { ok: false, problem: result.problem };
  } else {
    const hello = CareHello.safeParse(result.data);
    value = hello.success
      ? { ok: true, hello: hello.data }
      : { ok: false, problem: 'The plugin answered, but not in a form this Kamaji understands' };
  }
  const at = now();
  recordObservation(db, {
    resourceType: 'site',
    resourceId: id,
    check: 'hello',
    source: 'plugin',
    at,
    ok: value.ok,
    value,
  });
  recordEvent(db, at, {
    kind: value.ok ? 'site.connected' : 'site.handshake-failed',
    summary: value.ok
      ? `Connected to Craftish Care on ${String(row.name)}`
      : `Couldn’t connect to ${String(row.name)}: ${value.problem}`,
    resourceType: 'site',
    resourceId: id,
  });
  if (value.ok) {
    db.prepare(
      `UPDATE sites SET mode = 'connected',
         setup = CASE WHEN setup = 'connect' THEN 'configure' ELSE setup END
       WHERE id = ?`,
    ).run(id);
  }
  return { at: new Date(at).toISOString(), result: value };
}

/**
 * Step 3. Finishing grants no update permission: every update is still approved. Kamaji's own
 * backup before an update is the database export on craftish, or on Kinsta a whole-site snapshot
 * (Tyler, 2026-11-18), so a Kinsta site needs whole-site backups on to choose it. Whole-site
 * backups pull from craftish, or from Kinsta over SSH once Test connection has worked there and,
 * over 20 GB, Tyler has okayed the size (sitebackups/kinsta.ts). Turning whole-site backups on for a client's site
 * needs the client's agreement, ticked here and recorded with who ticked it and when (calcifer
 * explore/kamaji.md, "Backups (TY-166)"); turning them off clears it, so it's asked again.
 */
export function configureSite(
  db: Db,
  id: string,
  request: ConfigureSiteRequest,
  now: number,
  login: string,
):
  | 'saved'
  | 'not-found'
  | 'not-craftish'
  | 'kinsta-needs-backups'
  | { kinsta: string }
  | 'no-consent'
  | 'connected'
  | 'bad-zone'
  | { refused: string } {
  const row = siteRow(db, id);
  if (!row || (row.setup !== 'configure' && row.setup !== 'done')) return 'not-found';
  const beforePlatform = String(row.platform) as Platform;
  const platform = request.platform ?? beforePlatform;
  const wordpress = platform === 'wordpress';
  // A connected site is WordPress until it's disconnected (Remove asks the plugin to forget it).
  if (!wordpress && row.mode === 'connected') return 'connected';
  const craftish = row.host_kind === 'craftish';
  const kinsta = row.host_kind === 'kinsta';
  const own = request.own ?? Number(row.own) === 1;
  const before = String(row.site_backup_schedule) as SiteBackupSchedule;
  // A static site or an app has no backups to expect, from Kamaji or anyone.
  const schedule = wordpress ? (request.siteBackups ?? before) : 'off';
  if (wordpress && request.backupExpectation === 'kamaji' && !craftish) {
    if (!kinsta) return 'not-craftish';
    if (schedule === 'off') return 'kinsta-needs-backups';
  }
  const backupExpectation = wordpress ? request.backupExpectation : null;
  // Pages to check go with updates, so only WordPress keeps any.
  let pages = readPages(String(row.important_pages ?? '[]'), String(row.url));
  if (request.pages) {
    const checked = checkPages(request.pages, String(row.url));
    if (!checked.ok) return { refused: checked.refused };
    pages = checked.pages;
  }
  if (!wordpress) pages = [];
  const beforeZone = String(row.time_zone);
  const timeZone = request.timeZone ?? beforeZone;
  if (!validZone(timeZone)) return 'bad-zone';
  const hadConsent = row.site_backup_consent_at !== null;
  if (schedule !== 'off') {
    if (!craftish && !kinsta) return 'not-craftish';
    // Turning them on waits for a good test (and the size okay); once on, they stay saveable.
    const waiting = kinsta && before === 'off' ? kinstaBlocked(db, id) : null;
    if (waiting) return { kinsta: waiting };
    if (!own && !hadConsent && !request.clientAgreed) return 'no-consent';
  }
  const consent =
    schedule === 'off' || own
      ? null
      : hadConsent
        ? { at: Number(row.site_backup_consent_at), by: String(row.site_backup_consent_by) }
        : { at: now, by: login };
  const beforeName = String(row.name);
  const name = request.name ?? beforeName;
  db.prepare(
    `UPDATE sites SET name = ?, expected_text = ?, backup_expectation = ?, notifications = ?, setup = 'done',
       own = ?, site_backup_schedule = ?, site_backup_consent_at = ?, site_backup_consent_by = ?,
       platform = ?, important_pages = ?, time_zone = ?
     WHERE id = ?`,
  ).run(
    name,
    request.expectedText || null,
    backupExpectation,
    request.notifications,
    own ? 1 : 0,
    schedule,
    consent?.at ?? null,
    consent?.by ?? null,
    platform,
    JSON.stringify(pages),
    timeZone,
    id,
  );
  const event = (kind: string, summary: string) =>
    recordEvent(db, now, { kind, summary, resourceType: 'site', resourceId: id });
  if (name !== beforeName) event('site.renamed', `Renamed ${beforeName} to ${name}`);
  if (platform !== beforePlatform)
    event(
      'site.platform',
      `${name} is ${PLATFORM_WORDS[platform]} (was ${PLATFORM_WORDS[beforePlatform]})`,
    );
  if (row.setup !== 'done') event('site.added', `Added ${name}: first checks pending`);
  if (consent && !hadConsent) {
    event(
      'site.backup-consent',
      `${name}’s client agreed to whole-site backups (ticked by ${login})`,
    );
  }
  if (!consent && hadConsent) {
    event(
      'site.backup-consent-cleared',
      own
        ? `${name} marked as Tyler’s own: no client’s agreement needed for its backups`
        : `Whole-site backups of ${name} turned off; the client’s agreement is asked again next time`,
    );
  }
  if (timeZone !== beforeZone) event('site.time-zone', `${name}’s time zone: ${timeZone}`);
  if (schedule !== before) {
    event('site.backup-schedule', `Whole-site backups of ${name}: ${schedule}`);
  }
  return 'saved';
}

export function siteDetail(
  db: Db,
  id: string,
  options: { workerOn: boolean; canConnect: boolean },
): SiteDetailResponse | null {
  const row = siteRow(db, id);
  const site = siteSummaries(db, options.workerOn).find((s) => s.id === id);
  if (!row || !site) return null;
  return {
    site,
    handshake: latestHandshake(db, id),
    inventory: siteInventory(db, { id, mode: String(row.mode) }),
    backupExpectation:
      row.backup_expectation === null
        ? null
        : (String(row.backup_expectation) as SiteDetailResponse['backupExpectation']),
    notifications: String(row.notifications) as SiteDetailResponse['notifications'],
    pages: readPages(String(row.important_pages ?? '[]'), String(row.url)),
    canConnect: options.canConnect,
    own: Number(row.own) === 1,
    siteBackups: {
      schedule: String(row.site_backup_schedule) as SiteBackupSchedule,
      consentAt:
        row.site_backup_consent_at === null
          ? null
          : new Date(Number(row.site_backup_consent_at)).toISOString(),
      consentBy: row.site_backup_consent_by === null ? null : String(row.site_backup_consent_by),
    },
    icon: iconStatus(db, id),
    timeZone: String(row.time_zone),
    kinsta: row.host_kind === 'kinsta' ? kinstaView(db, id) : null,
  };
}

/**
 * Remove: history kept, the site marked removed. A connected site is first told to forget its
 * keys, which needs the update key: only the laptop holds it until M4's updater. When the
 * disconnect can't be sent or fails, the answer says so, and the cleanup is Tyler's.
 */
export async function removeSite(
  db: Db,
  id: string,
  confirm: string,
  keys: CareKeys | undefined,
  send: CareSend,
  now: () => number,
): Promise<RemoveSiteResponse | 'not-found' | 'not-confirmed'> {
  const row = siteRow(db, id);
  if (!row) return 'not-found';
  if (confirm.trim() !== String(row.name)) return 'not-confirmed';
  const everConnected = latestHandshake(db, id)?.result.ok === true;
  let disconnect: RemoveSiteResponse['disconnect'] = 'not-connected';
  let problem: string | null = null;
  if (row.mode === 'connected' && everConnected) {
    if (!keys?.update) {
      disconnect = 'no-update-key';
      problem = 'This Kamaji can’t sign a disconnect yet: remove Craftish Care in wp-admin';
    } else {
      const result = await send(new URL(String(row.url)), keys.update, 'disconnect', {});
      disconnect = result.ok || result.code === 'disconnected' ? 'done' : 'failed';
      problem =
        disconnect === 'failed' && !result.ok
          ? `${result.problem}: remove Craftish Care in wp-admin`
          : null;
    }
  }
  const at = now();
  db.prepare('UPDATE sites SET removed_at = ? WHERE id = ?').run(at, id);
  recordEvent(db, at, {
    kind: 'site.removed',
    summary:
      disconnect === 'done'
        ? `Removed ${String(row.name)}; Craftish Care forgot its keys`
        : `Removed ${String(row.name)}`,
    resourceType: 'site',
    resourceId: id,
    detail: { disconnect },
  });
  return { removed: true, disconnect, problem };
}
