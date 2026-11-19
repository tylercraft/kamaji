// A finished rollback or undo, in words: one Discord line (counts and the site's name, never a
// component's: Discord is a third party) and the toast for whoever asked, with the names. Sent
// once each, by the app's cycle, after the updater's checks. One that stopped before changing
// anything isn't sent to Discord: the toast, Activity and the site's page say it.
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';
import type { FinishedRun } from '../updates/announce.js';
import { rollbackItems } from './offer.js';

type Row = Record<string, unknown>;

const DAY = 24 * 60 * 60_000;
const count = (n: number) => `${n} ${n === 1 ? 'update' : 'updates'}`;

/** How long ago, in a few words: "2 days", "5 hours". */
export function age(ms: number): string {
  if (ms < 60 * 60_000) return 'under an hour';
  const hours = Math.round(ms / (60 * 60_000));
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(ms / DAY);
  return `${days} days`;
}

const STEPS: Record<string, string> = {
  check: 'its checks on the server',
  receive: 'sending the files',
  stage: 'staging the files',
  save: 'saving the database first',
  maintenance: 'maintenance mode',
  swap: 'the swap',
  database: 'the database',
  snapshot: 'reading the restore point',
  pack: 'packing the files',
  connection: 'the connection',
  mini: 'the mini',
};
export const stepWords = (step: string) => STEPS[step] ?? step;

/** The line for one rollback or undo: with `names`, the toast's; without, Discord's. */
export function rollbackLine(db: Db, r: Row, names: boolean): string {
  const site = String(
    db.prepare('SELECT name FROM sites WHERE id = ?').get(String(r.site_id))?.name ?? r.site_id,
  );
  const items = rollbackItems(db, String(r.id));
  const what = names
    ? items.map((i) => `${i.name} ${i.now} → ${i.back}`).join(', ')
    : count(items.length);
  const bold = (s: string) => (names ? s : `**${s}**`);
  const undo = r.kind === 'undo';
  const changed = String(r.changed);
  const withDb = Number(r.with_database) === 1;
  const finishedAt = Number(r.finished_at ?? 0);
  const dbAge = r.database_at === null ? null : age(finishedAt - Number(r.database_at));
  const checks = Number(r.checks_ok) === 1;
  const problem = String(r.problem ?? 'it failed');
  if (changed === 'none')
    return `⚠️ ${undo ? 'The undo of the rollback of' : 'The rollback of'} ${bold(site)} stopped at ${stepWords(String(r.step))}: nothing was changed${names ? ` (${problem})` : ''}`;
  if (changed === 'all') {
    const how = undo
      ? withDb
        ? ', with the database as it was before the rollback'
        : ', files only'
      : withDb
        ? `, with the database from ${dbAge ?? 'before the run'} ago`
        : ', files only';
    if (!checks)
      return `⚠️ ${bold('Needs you:')} ${site} was ${undo ? 'put back as the run left it' : 'rolled back'} (${what}${how}), but its checks failed${names && r.checks_problem ? `: ${String(r.checks_problem)}` : ''}`;
    return undo
      ? `↩️ Undid the rollback of ${bold(site)}: ${what} back as the run left them${how}, checks passed`
      : `↩️ Rolled back ${bold(site)}: ${what} put back${how}, checks passed`;
  }
  if (changed === 'files')
    return `⚠️ ${bold('Needs you:')} ${site} was ${undo ? 'put back as the run left it' : 'rolled back'} (${what}), but its database couldn’t be put back; it’s as it was${checks ? '' : ', and its checks failed'}`;
  // partial, broken or unknown: part way, and only the server can say how far.
  return `⚠️ ${bold('Needs you:')} ${undo ? 'the undo of the rollback of' : 'the rollback of'} ${site} stopped at ${stepWords(String(r.step))} and left it part way${names ? `: ${problem}` : ''}`;
}

/** Told Discord? Not one that stopped before the site changed (before maintenance mode). */
const toDiscord = (r: Row) =>
  r.changed !== 'none' || ['maintenance', 'swap', 'database'].includes(String(r.step));

export function rollbackMessage(db: Db, r: Row, kamajiUrl: string): string {
  return `${rollbackLine(db, r, false)}\n<${kamajiUrl.replace(/\/$/, '')}/sites/${encodeURIComponent(String(r.site_id))}#updates>`;
}

/** The cycle's part: each checked rollback once, marked told only once Discord takes it. */
export async function announceRollbacks(
  db: Db,
  discord: Discord,
  kamajiUrl: string,
  signal?: AbortSignal,
): Promise<number> {
  let sent = 0;
  const rows = db
    .prepare(
      `SELECT * FROM rollbacks WHERE checked_at IS NOT NULL AND announced_at IS NULL
       ORDER BY checked_at`,
    )
    .all();
  const mark = db.prepare('UPDATE rollbacks SET announced_at = ? WHERE id = ?');
  for (const r of rows) {
    if (
      toDiscord(r) &&
      discord.configured &&
      !(await discord.send(rollbackMessage(db, r, kamajiUrl), signal))
    )
      continue;
    mark.run(Number(r.checked_at), String(r.id));
    sent += 1;
  }
  return sent;
}

/** Rollbacks checked in the last `withinMs`, for the toast, shaped as a finished run. */
export function recentRollbacks(db: Db, now: number, withinMs: number): FinishedRun[] {
  return db
    .prepare('SELECT * FROM rollbacks WHERE checked_at > ? ORDER BY checked_at')
    .all(now - withinMs)
    .map((r) => ({
      id: `rollback-${String(r.id)}`,
      approvedBy: String(r.requested_by),
      finishedAt: Number(r.checked_at),
      lines: [rollbackLine(db, r, true)],
      anchor: 'updates',
      href: `/sites/${encodeURIComponent(String(r.site_id))}#updates`,
    }));
}
