// "Ready to update" (Tyler, 2026-11-17): at the weekly update time, a fresh report from every
// connected site (Recheck all), then one message, to Discord and the top of Overview: each site's
// backup for this update and the updates waiting on it, majors marked. A failed backup leads.
// Kamaji approves nothing itself: the message links to Updates, where Tyler does.
//
// Discord is a third party, so it gets labels and counts, never plugin names (discord.ts); the
// list itself is on Overview. Like notify.ts, the message is marked sent only once Discord takes
// it, and a failed send is retried each cycle for 3 hours after the update time. The recheck
// runs once.
//
// Overview shows it live (liveReady, Tyler, 2026-11-18): worked out on each load from the update
// time until the next, each site's backup as it is now and the updates still waiting; a site with
// nothing left drops off, and one updated since shows when. The stored message is Discord's.
import type { ReadyBackup, ReadySite, ReadyToUpdate } from '@kamaji/shared';
import type { Db } from './db.js';
import type { Discord } from './discord.js';
import { recordEvent } from './events.js';
import { readUpdateTime } from './settings.js';
import { eligible } from './sitebackups/eligible.js';
import { backupNight, KAMAJI_ZONE, updateTimes } from './sitebackups/schedule.js';
import { readState, writeState } from './state.js';
import { queue, updatableSites } from './updates/queue.js';

const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;
/** Kamaji down over the update time sends it late, up to this long after; not the next morning. */
export const READY_WINDOW = 3 * HOUR;
const KEY = 'ready-to-update';

interface Stored {
  ready: ReadyToUpdate;
  sent: boolean;
}

const HOSTS: Record<string, string> = { kinsta: 'Kinsta', wpengine: 'WP Engine' };
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * This update's whole-site backup: the latest good snapshot from its night up to `upTo`, or why
 * there isn't one. The message sent at the update time looks up to then; Overview's live card up
 * to now, so a failure fixed after the update time (Back up site now) clears.
 */
function wholeSite(db: Db, siteId: string, update: number, upTo: number): ReadyBackup {
  const row = db
    .prepare('SELECT time_zone, site_backup_schedule FROM sites WHERE id = ?')
    .get(siteId);
  const night = backupNight(update, String(row?.time_zone));
  // A fortnightly site's off week rests on last week's snapshot. An hour's slack, as schedule.ts.
  const since = (row?.site_backup_schedule === 'fortnightly' ? night - WEEK : night) - HOUR;
  const good = db
    .prepare(
      `SELECT started_at, snapshot_id FROM site_snapshots
       WHERE site_id = ? AND ok = 1 AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(siteId, since, upTo);
  if (good) {
    // The scheduled backup's own restore check (sitebackups/run.ts), of this very snapshot.
    const check = db
      .prepare(
        `SELECT ok, failed_step, problem, finished_at FROM restore_checks
         WHERE site_id = ? AND snapshot_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(siteId, String(good.snapshot_id));
    if (check && Number(check.ok) !== 1)
      return {
        state: 'failed',
        step: 'restore',
        problem: `at “${String(check.failed_step)}”: ${String(check.problem ?? 'it failed')}`,
        at: iso(Number(good.started_at)),
      };
    return {
      state: 'fresh',
      at: iso(Number(good.started_at)),
      restoredAt: check ? iso(Number(check.finished_at)) : null,
    };
  }
  const failed = db
    .prepare(
      `SELECT started_at, problem FROM site_snapshots
       WHERE site_id = ? AND ok = 0 AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(siteId, since, upTo);
  return failed
    ? {
        state: 'failed',
        step: 'backup',
        problem: String(failed.problem ?? 'the backup failed'),
        at: iso(Number(failed.started_at)),
      }
    : { state: 'failed', step: 'backup', problem: 'no backup ran for this update', at: null };
}

function backupFor(
  db: Db,
  site: { id: string; hostKind: string; backupKind: string | null },
  update: number,
  upTo: number,
): ReadyBackup {
  if (eligible(db, site.id)) return wholeSite(db, site.id, update, upTo);
  switch (site.backupKind) {
    case 'host':
      return { state: 'host', host: HOSTS[site.hostKind] ?? 'the host' };
    case 'kamaji':
      return { state: 'export' };
    case 'client':
      return { state: 'client' };
    case 'tyler':
      return { state: 'tyler' };
    default:
      return { state: 'unknown' };
  }
}

/**
 * The message's content: every site Kamaji can update, and any with whole-site backups on. Backups
 * count up to `upTo`: the update time for the message, now for Overview's live card.
 */
export function readyToUpdate(
  db: Db,
  now: number,
  update: number,
  unreachable: Map<string, string> = new Map(),
  upTo: number = update,
): ReadyToUpdate {
  const { items } = queue(db);
  const updatable = updatableSites(db);
  const known = new Set(updatable.map((s) => s.id));
  const backedUp = db
    .prepare(
      `SELECT id, name, host_kind, backup_expectation FROM sites WHERE removed_at IS NULL
       ORDER BY name COLLATE NOCASE`,
    )
    .all()
    .filter((r) => !known.has(String(r.id)) && eligible(db, String(r.id)))
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      hostKind: String(r.host_kind),
      backupKind: r.backup_expectation === null ? null : String(r.backup_expectation),
      blocked: null as string | null,
    }));
  const rows = db
    .prepare('SELECT id, backup_expectation FROM sites WHERE removed_at IS NULL')
    .all()
    .map((r) => [
      String(r.id),
      r.backup_expectation === null ? null : String(r.backup_expectation),
    ]);
  const expectation = new Map(rows as [string, string | null][]);
  const sites: ReadySite[] = [
    ...updatable.map((s) => ({ ...s, backupKind: expectation.get(s.id) ?? null })),
    ...backedUp,
  ].map((s) => ({
    siteId: s.id,
    siteName: s.name,
    backup: backupFor(db, s, update, upTo),
    updates: items
      .filter((i) => i.siteId === s.id)
      .map((i) => ({ name: i.name, from: i.from, to: i.to, major: i.major, security: i.security })),
    note: unreachable.has(s.id)
      ? `Recheck all couldn’t reach it (${unreachable.get(s.id)}): its updates are from the last report`
      : s.blocked,
    updatedAt: null,
  }));
  sites.sort(
    (a, b) =>
      Number(b.backup.state === 'failed') - Number(a.backup.state === 'failed') ||
      a.siteName.localeCompare(b.siteName),
  );
  return { for: iso(update), sentAt: iso(now), sites };
}

const clock = (at: string) =>
  new Intl.DateTimeFormat('en-NZ', {
    timeZone: KAMAJI_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));

export function backupWords(b: ReadyBackup): string {
  switch (b.state) {
    case 'fresh':
      return b.restoredAt
        ? `backed up and restore-checked ${clock(b.at)}`
        : `backed up ${clock(b.at)}`;
    case 'failed':
      return b.step === 'restore'
        ? `backed up ${b.at ? clock(b.at) : ''}, but the restore check failed ${b.problem}. Fix it before updating`
        : `backup failed: ${b.problem}. Fix it before updating`;
    case 'host':
      return `${b.host}’s backups`;
    case 'export':
      return 'pre-update export only';
    case 'client':
      return 'the client’s backups';
    case 'tyler':
      return 'your own backup, confirmed when you approve';
    case 'unknown':
      return 'backups not decided: set them under Configure';
  }
}

function updateWords(site: ReadySite): string {
  const n = site.updates.length;
  if (n === 0) return 'nothing waiting';
  const majors = site.updates.filter((u) => u.major).length;
  const security = site.updates.filter((u) => u.security).length;
  const extra = [majors > 0 && `${majors} major`, security > 0 && `${security} security`]
    .filter(Boolean)
    .join(', ');
  return `${n} update${n === 1 ? '' : 's'}${extra ? ` (${extra})` : ''}`;
}

/** "a backup", "2 restore checks", "3 backups or restore checks": whatever failed, named. */
function failedWhat(failed: ReadySite[]): string {
  const restores = failed.filter((s) => s.backup.state === 'failed' && s.backup.step === 'restore');
  const n = failed.length;
  if (restores.length === n) return n === 1 ? 'a restore check' : `${n} restore checks`;
  if (restores.length === 0) return n === 1 ? 'a backup' : `${n} backups`;
  return `${n} backups or restore checks`;
}

/** Labels and counts only: no plugin names leave for Discord. */
export function readyMessage(ready: ReadyToUpdate, kamajiUrl: string): string {
  const failed = ready.sites.filter((s) => s.backup.state === 'failed');
  const waiting = ready.sites.reduce((n, s) => n + s.updates.length, 0);
  const head =
    failed.length > 0
      ? `**Kamaji: ${failedWhat(failed)} failed before the update time.** Fix ${failed.length === 1 ? 'it' : 'them'} before updating.`
      : '**Kamaji: ready to update.**';
  const lines = ready.sites.map(
    (s) =>
      `- ${s.siteName}: ${backupWords(s.backup)} · ${updateWords(s)}${s.note && s.backup.state !== 'failed' ? ' · not rechecked' : ''}`,
  );
  return [
    head,
    `${waiting} update${waiting === 1 ? '' : 's'} waiting. Nothing is approved until you approve it.`,
    ...lines,
    `<${kamajiUrl.replace(/\/$/, '')}/updates>`,
  ].join('\n');
}

/**
 * Overview's Ready to update, worked out now: from the update time it was sent for until the next
 * one. Each site with updates still waiting, with its backup as it stands now (a snapshot after
 * the update time counts), a failed one first; then each site updated since with nothing left,
 * which shows only when it was updated ("Updated Wed 10:50") and never counts as failed
 * (web ReadyToUpdate.tsx). Null outside that stretch, or when nothing is left to say.
 */
export function liveReady(db: Db, now: number): ReadyToUpdate | null {
  const update = updateTimes(now, readUpdateTime(db)).last;
  const stored = readState<Stored>(db, KEY);
  if (!stored || stored.ready.for !== iso(update)) return null;
  const updated = new Map(
    db
      .prepare(
        `SELECT site_id, MAX(finished_at) AS at FROM batch_sites
         WHERE state = 'done' AND finished_at >= ? GROUP BY site_id`,
      )
      .all(update)
      .map((r) => [String(r.site_id), iso(Number(r.at))] as const),
  );
  const live = readyToUpdate(db, now, update, new Map(), now);
  const done = (s: ReadySite) => s.updates.length === 0;
  const failed = (s: ReadySite) => !done(s) && s.backup.state === 'failed';
  const sites = live.sites
    .map((s) => ({ ...s, updatedAt: updated.get(s.siteId) ?? null }))
    .filter((s) => !done(s) || s.updatedAt !== null)
    .sort(
      (a, b) =>
        Number(done(a)) - Number(done(b)) ||
        Number(failed(b)) - Number(failed(a)) ||
        a.siteName.localeCompare(b.siteName),
    );
  if (sites.length === 0) return null;
  // When it was rechecked is the stored message's: the reports since are the hourly ones.
  return { ...live, sentAt: stored.ready.sentAt, sites };
}

export interface ReadyDeps {
  discord: Discord;
  kamajiUrl: string;
  /** Recheck all: a fresh report from each connected site, with why any didn't answer. */
  recheck: (() => Promise<{ id: string; ok: boolean; problem: string | null }[]>) | null;
  signal?: AbortSignal;
}

/** The cycle's part: at the update time, once. Returns whether it composed one this cycle. */
export async function checkReady(db: Db, now: number, deps: ReadyDeps): Promise<boolean> {
  const update = updateTimes(now, readUpdateTime(db)).last;
  if (now - update > READY_WINDOW) return false;
  const stored = readState<Stored>(db, KEY);
  if (stored && stored.ready.for === iso(update)) {
    if (stored.sent || !deps.discord.configured) return false;
    if (await deps.discord.send(readyMessage(stored.ready, deps.kamajiUrl), deps.signal))
      writeState(db, KEY, { ...stored, sent: true }, now);
    return false;
  }
  const unreachable = new Map<string, string>();
  if (deps.recheck)
    for (const r of await deps.recheck())
      if (!r.ok) unreachable.set(r.id, r.problem ?? 'no report');
  const ready = readyToUpdate(db, now, update, unreachable);
  const failed = ready.sites.filter((s) => s.backup.state === 'failed').length;
  const waiting = ready.sites.reduce((n, s) => n + s.updates.length, 0);
  recordEvent(db, now, {
    kind: 'kamaji.ready-to-update',
    summary:
      failed > 0
        ? `Ready to update, with ${failed} failed backup${failed === 1 ? '' : 's'} to fix first: ${waiting} updates waiting`
        : `Ready to update: ${waiting} updates waiting, no backup failed`,
  });
  // Written before the send, so the recheck isn't repeated if Discord is down.
  writeState(db, KEY, { ready, sent: false } satisfies Stored, now);
  if (
    deps.discord.configured &&
    (await deps.discord.send(readyMessage(ready, deps.kamajiUrl), deps.signal))
  )
    writeState(db, KEY, { ready, sent: true } satisfies Stored, now);
  return true;
}
