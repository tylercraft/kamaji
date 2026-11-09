// Adding and removing a site (calcifer explore/kamaji.md, "Adding and managing a site"): identify,
// then connect through craftish-care or choose monitoring only, then configure. A setup is saved
// from the first step so it can be resumed. Kamaji never installs the plugin: it offers the zip,
// and the handshake is its first signed request.
import {
  CareHello,
  type ConfigureSiteRequest,
  type Handshake,
  type NewSiteRequest,
  type RemoveSiteResponse,
  type SiteDetailResponse,
} from '@kamaji/shared';
import type { CareResult } from '../care/client.js';
import type { CareKeys, SigningKey } from '../care/keys.js';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { latestObservations, recordObservation } from '../observations.js';
import { siteInventory } from '../inventory/report.js';
import { siteSummaries } from '../queries.js';

/** Sends one signed request to a site; careRequest in production, a fake in tests. */
export type CareSend = (
  home: URL,
  key: SigningKey,
  endpoint: string,
  body: Record<string, unknown>,
) => Promise<CareResult>;

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
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, client_slug, mode, setup, created_at)
     VALUES (?, ?, ?, ?, ?, 'monitoring', 'connect', ?)`,
  ).run(id, request.name, url.href, request.hostKind, request.clientSlug, now);
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
  const result = db
    .prepare(
      `UPDATE sites SET mode = ?, setup = CASE WHEN ? = 'monitoring' THEN 'configure' ELSE setup END
       WHERE id = ? AND removed_at IS NULL AND setup = 'connect'`,
    )
    .run(mode, mode, id);
  return Number(result.changes) === 1;
}

function latestHandshake(db: Db, id: string): Handshake | null {
  const [last] = latestObservations<HandshakeValue>(db, 'site', id, 'hello', 'plugin', 1);
  return last ? { at: new Date(last.at).toISOString(), result: last.value } : null;
}

/** The handshake: craftish-care's hello, signed with the report key. A partial answer is a site with gaps, not a failure. */
export async function handshake(
  db: Db,
  id: string,
  keys: CareKeys,
  send: CareSend,
  now: () => number,
): Promise<Handshake | null> {
  const row = siteRow(db, id);
  if (!row || row.mode !== 'connected') return null;
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
    db.prepare("UPDATE sites SET setup = 'configure' WHERE id = ? AND setup = 'connect'").run(id);
  }
  return { at: new Date(at).toISOString(), result: value };
}

/** Step 3. Finishing grants no update permission: every update is still approved. */
export function configureSite(
  db: Db,
  id: string,
  request: ConfigureSiteRequest,
  now: number,
): boolean {
  const row = siteRow(db, id);
  if (!row || (row.setup !== 'configure' && row.setup !== 'done')) return false;
  db.prepare(
    `UPDATE sites SET expected_text = ?, backup_expectation = ?, notifications = ?, setup = 'done'
     WHERE id = ?`,
  ).run(request.expectedText || null, request.backupExpectation, request.notifications, id);
  if (row.setup !== 'done') {
    recordEvent(db, now, {
      kind: 'site.added',
      summary: `Added ${String(row.name)}: first checks pending`,
      resourceType: 'site',
      resourceId: id,
    });
  }
  return true;
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
    canConnect: options.canConnect,
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
