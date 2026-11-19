// Screenshot sets in the database (ops/screenshots-plan.md): asking for one (the updater's
// "before" and "after", or by hand from the site's page), what each holds, and where its images
// are. The screenshots process (shots/run.ts) takes what's asked; the app serves the images.
import { join } from 'node:path';
import type {
  ComparisonView,
  RunScreenshots,
  ScreenshotSetView,
  ScreenshotSettings,
  ShotView,
  SiteScreenshotsResponse,
} from '@kamaji/shared';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { newId } from '../rollback/offer.js';
import { readPages } from '../sites/pages.js';

export type SetKind = 'before' | 'after' | 'manual';

/** The screenshots process's one-at-a-time lock, and its heartbeat while it runs (state table). */
export const LOCK = 'shots.process';
export const HEARTBEAT = 'shots.heartbeat';
type Row = Record<string, unknown>;

const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown) => (ms === null || ms === undefined ? null : iso(ms));
const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** A set's folder: data/screenshots/<site>/<set>. Both are checked before they're a path. */
export function setDir(root: string, siteId: string, setId: string): string | null {
  if (!/^[a-z0-9.-]{1,253}$/.test(siteId) || /^\.|\.\./.test(siteId)) return null;
  if (!/^[0-9a-f]{16}$/.test(setId)) return null;
  return join(root, siteId, setId);
}

/** The pages a site's sets shoot: its home page, then its check pages, each once. */
export function sitePages(db: Db, siteId: string): string[] {
  const r = db.prepare('SELECT url, important_pages FROM sites WHERE id = ?').get(siteId);
  if (!r) return [];
  const home = String(r.url);
  const pages = readPages(String(r.important_pages ?? '[]'), home).map((p) => p.url);
  return [...new Set([home, ...pages])];
}

function readList(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function readSettings(db: Db, siteId: string): ScreenshotSettings {
  const r = db
    .prepare('SELECT screenshot_hide, screenshot_mask FROM sites WHERE id = ?')
    .get(siteId);
  return { hide: readList(r?.screenshot_hide), mask: readList(r?.screenshot_mask) };
}

export function saveSettings(
  db: Db,
  siteId: string,
  settings: ScreenshotSettings,
  now: number,
  login: string,
): boolean {
  const site = db.prepare('SELECT name FROM sites WHERE id = ? AND removed_at IS NULL').get(siteId);
  if (!site) return false;
  db.prepare('UPDATE sites SET screenshot_hide = ?, screenshot_mask = ? WHERE id = ?').run(
    JSON.stringify(settings.hide),
    JSON.stringify(settings.mask),
    siteId,
  );
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  recordEvent(db, now, {
    kind: 'site.screenshots-configured',
    summary: `${login} set ${String(site.name)}’s screenshots to hide ${n(settings.hide.length, 'selector')} and mask ${n(settings.mask.length, 'selector')}`,
    resourceType: 'site',
    resourceId: siteId,
  });
  return true;
}

/**
 * Asks for a set. One taken by hand that's already waiting or being taken is shown again rather
 * than asked twice. A "before" set shoots two rounds, for the automatic masks.
 */
export function requestSet(
  db: Db,
  ask: { siteId: string; batchId: string | null; kind: SetKind; by: string | null },
  now: number,
): string | null {
  if (!db.prepare('SELECT 1 FROM sites WHERE id = ? AND removed_at IS NULL').get(ask.siteId))
    return null;
  if (ask.kind === 'manual') {
    const same = db
      .prepare(
        `SELECT id FROM screenshot_sets WHERE site_id = ? AND kind = 'manual'
         AND state IN ('waiting', 'running') LIMIT 1`,
      )
      .get(ask.siteId);
    if (same) return String(same.id);
  }
  const id = newId();
  db.prepare(
    `INSERT INTO screenshot_sets (id, site_id, batch_id, kind, rounds, requested_at, requested_by, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')`,
  ).run(id, ask.siteId, ask.batchId, ask.kind, ask.kind === 'before' ? 2 : 1, now, ask.by);
  return id;
}

/** One taken by hand that's waited this long isn't going to be taken: the process didn't start. */
export const MANUAL_WAIT_MS = 15 * 60_000;

/** Fails sets taken by hand that have waited too long, so the site page doesn't wait forever. */
export function staleManual(db: Db, now: number): number {
  return Number(
    db
      .prepare(
        `UPDATE screenshot_sets SET state = 'failed', finished_at = ?,
           problem = 'the screenshots process didn’t start'
         WHERE kind = 'manual' AND state = 'waiting' AND requested_at < ?`,
      )
      .run(now, now - MANUAL_WAIT_MS).changes,
  );
}

/** Whether any set waits for the screenshots process. */
export function setsWaiting(db: Db): boolean {
  return (
    db.prepare("SELECT 1 FROM screenshot_sets WHERE state = 'waiting' LIMIT 1").get() !== undefined
  );
}

const imageUrl = (setId: string, file: unknown) =>
  file === null || file === undefined ? null : `/api/screenshots/${setId}/${String(file)}`;

function shotView(r: Row): ShotView {
  const setId = String(r.set_id);
  return {
    id: Number(r.id),
    pageUrl: String(r.page_url),
    viewport: String(r.viewport) as ShotView['viewport'],
    image: imageUrl(setId, r.file),
    thumb: imageUrl(setId, r.thumb),
    width: num(r.width),
    height: num(r.height),
    cut: Number(r.cut) === 1,
    quiet: Number(r.quiet) === 1,
    status: num(r.status),
    blocked: Number(r.blocked) === 1,
    jsErrors: Number(r.js_errors),
    failedRequests: Number(r.failed_requests),
    blockedRequests: Number(r.blocked_requests),
    problem: text(r.problem),
  };
}

function comparisons(db: Db, setId: string): ComparisonView[] {
  const shot = db.prepare('SELECT * FROM screenshots WHERE id = ?');
  return db
    .prepare('SELECT * FROM screenshot_comparisons WHERE set_id = ? ORDER BY id')
    .all(setId)
    .map((c) => {
      const before = c.before_id === null ? undefined : shot.get(Number(c.before_id));
      const after = c.after_id === null ? undefined : shot.get(Number(c.after_id));
      return {
        pageUrl: String(c.page_url),
        viewport: String(c.viewport) as ComparisonView['viewport'],
        compared: String(c.compared) as ComparisonView['compared'],
        changedPct: num(c.changed_pct),
        maskedPct: num(c.masked_pct),
        heightBefore: num(c.height_before),
        heightAfter: num(c.height_after),
        newJsErrors: Number(c.new_js_errors),
        newFailedRequests: Number(c.new_failed_requests),
        diff: imageUrl(setId, c.diff_file),
        before: before ? shotView(before) : null,
        after: after ? shotView(after) : null,
        problem: text(c.problem),
      };
    });
}

export function setView(db: Db, setId: string): ScreenshotSetView | null {
  const r = db.prepare('SELECT * FROM screenshot_sets WHERE id = ?').get(setId);
  if (!r) return null;
  return {
    id: setId,
    kind: String(r.kind) as SetKind,
    state: String(r.state) as ScreenshotSetView['state'],
    requestedAt: iso(r.requested_at),
    requestedBy: text(r.requested_by),
    finishedAt: isoOrNull(r.finished_at),
    problem: text(r.problem),
    shots: db
      .prepare(
        `SELECT * FROM screenshots WHERE set_id = ? AND round = 1
         ORDER BY position, CASE viewport WHEN 'desktop' THEN 0 ELSE 1 END`,
      )
      .all(setId)
      .map(shotView),
    comparisons: comparisons(db, setId),
  };
}

export function siteScreenshots(db: Db, siteId: string): SiteScreenshotsResponse {
  const latest = db
    .prepare(
      `SELECT id FROM screenshot_sets WHERE site_id = ? AND state IN ('done', 'failed')
       ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
    )
    .get(siteId);
  const pending = db
    .prepare(
      `SELECT id FROM screenshot_sets WHERE site_id = ? AND kind = 'manual'
       AND state IN ('waiting', 'running') ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(siteId);
  return {
    latest: latest ? setView(db, String(latest.id)) : null,
    pending: pending ? setView(db, String(pending.id)) : null,
    pages: sitePages(db, siteId),
    settings: readSettings(db, siteId),
  };
}

/** A site's part of a run: its latest "before" and "after" sets, and what they compared. */
export function runScreenshots(db: Db, batchId: string, siteId: string): RunScreenshots | null {
  const latest = (kind: SetKind) =>
    db
      .prepare(
        `SELECT id, state, problem FROM screenshot_sets WHERE batch_id = ? AND site_id = ? AND kind = ?
         ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
      )
      .get(batchId, siteId, kind);
  const before = latest('before');
  const after = latest('after');
  if (!before && !after) return null;
  const state = (r: Row | undefined) =>
    r ? { state: String(r.state) as ScreenshotSetView['state'], problem: text(r.problem) } : null;
  return {
    before: state(before),
    after: state(after),
    comparisons: after ? comparisons(db, String(after.id)) : [],
  };
}

/** A file of a set, as the app serves it: only one its rows name. */
export function setFile(
  db: Db,
  root: string,
  setId: string,
  file: string,
): { path: string; type: string } | null {
  if (!/^[a-z0-9-]{1,40}\.(png|jpg)$/.test(file)) return null;
  const set = db.prepare('SELECT site_id FROM screenshot_sets WHERE id = ?').get(setId);
  if (!set) return null;
  const named =
    db
      .prepare('SELECT 1 FROM screenshots WHERE set_id = ? AND (file = ? OR thumb = ?)')
      .get(setId, file, file) ??
    db
      .prepare('SELECT 1 FROM screenshot_comparisons WHERE set_id = ? AND diff_file = ?')
      .get(setId, file);
  const dir = setDir(root, String(set.site_id), setId);
  if (!named || !dir) return null;
  return { path: join(dir, file), type: file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
}
