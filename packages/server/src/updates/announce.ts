// A finished run, in words (Tyler, 2026-11-18): one line per site, in Discord and in the toast on
// whatever page Tyler has open. A site that went through says what changed, that the checks
// passed, and which backup came first; a held one leads with ⚠️ and the reason, marked as needing
// Tyler. The app's cycle sends each finished run once (announced_at); a run carried on after a
// hold finishes again, and that time only the sites it finished are told.
//
// Discord is a third party, so its lines give counts ("1 update"), never component names: those
// stay in the toast and on Updates (`names`). The held reason is the one Kamaji wrote, as the
// held issue's alert already sends it.
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';

type Row = Record<string, unknown>;

/** Which backup came first, in a few words, from what the run recorded. */
export function backupFirst(kind: string, words: string | null): string {
  if (kind === 'host') return 'the host’s backups';
  if (kind === 'client') return 'the client’s backups';
  if (kind === 'tyler') return 'your word there was a backup';
  if (words?.startsWith('Tyler carried on')) return 'carried on without a fresh backup';
  if (words?.startsWith('Whole-site backup before update')) return 'whole-site backup first';
  return 'database export first';
}

const items = (rows: Row[]) =>
  rows
    .map((i) => `${String(i.name)} ${String(i.from_version)} → ${String(i.to_version)}`)
    .join(', ');

const count = (rows: Row[]) => `${rows.length} ${rows.length === 1 ? 'update' : 'updates'}`;

/**
 * One line per site the run finished after `since` (every site when null), in run order. With
 * `names`, what changed by name and version (the toast); without, a count (Discord).
 */
export function runLines(
  db: Db,
  batchId: string,
  since: number | null = null,
  names = false,
): string[] {
  const what = names ? items : count;
  const sites = db
    .prepare(
      `SELECT bs.*, s.name FROM batch_sites bs JOIN sites s ON s.id = bs.site_id
       WHERE bs.batch_id = ? AND bs.state IN ('done', 'held') AND bs.finished_at > ?
       ORDER BY bs.position`,
    )
    .all(batchId, since ?? -1);
  const done = db.prepare(
    `SELECT name, from_version, to_version FROM batch_items
     WHERE batch_id = ? AND site_id = ? AND state = 'done' AND outcome = 'passed' ORDER BY position`,
  );
  return sites.map((s) => {
    const name = String(s.name);
    const updated = done.all(batchId, String(s.site_id));
    if (s.state === 'held') {
      const why = String(s.held_reason ?? 'held').replace(/^Held: /, '');
      const first = updated.length > 0 ? ` Updated before the hold: ${what(updated)}.` : '';
      return `⚠️ **Needs you:** ${name} is held: ${why}${/[.!?]$/.test(why) ? '' : '.'}${first}`;
    }
    const backup = backupFirst(String(s.backup_kind), s.backup === null ? null : String(s.backup));
    return updated.length > 0
      ? `✅ Updated ${name}: ${what(updated)}, checks passed (${backup})`
      : `✅ ${name}: nothing left to update (${backup})`;
  });
}

export interface FinishedRun {
  id: string;
  approvedBy: string;
  finishedAt: number;
  lines: string[];
  /** Updates' anchor for the run's first site (web runHistory.ts, runAnchor). */
  anchor: string;
}

function anchorFor(db: Db, batchId: string): string {
  const first = db
    .prepare('SELECT site_id FROM batch_sites WHERE batch_id = ? ORDER BY position LIMIT 1')
    .get(batchId)?.site_id;
  return `run-${batchId}-${String(first ?? '')}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** Runs finished and not yet told: each with the lines for what finished since it was last told. */
export function unannounced(db: Db): FinishedRun[] {
  return db
    .prepare(
      `SELECT id, approved_by, finished_at, announced_at FROM batches
       WHERE state = 'finished' AND finished_at > COALESCE(announced_at, -1)
       ORDER BY finished_at`,
    )
    .all()
    .map((b) => ({
      id: String(b.id),
      approvedBy: String(b.approved_by),
      finishedAt: Number(b.finished_at),
      lines: runLines(db, String(b.id), b.announced_at === null ? null : Number(b.announced_at)),
      anchor: anchorFor(db, String(b.id)),
    }))
    .filter((r) => r.lines.length > 0);
}

/** Runs that finished in the last `withinMs`, for the toast: every site, by name. */
export function recentRuns(db: Db, now: number, withinMs: number): FinishedRun[] {
  return db
    .prepare(
      `SELECT id, approved_by, finished_at FROM batches
       WHERE state = 'finished' AND finished_at > ? ORDER BY finished_at`,
    )
    .all(now - withinMs)
    .map((b) => ({
      id: String(b.id),
      approvedBy: String(b.approved_by),
      finishedAt: Number(b.finished_at),
      lines: runLines(db, String(b.id), null, true),
      anchor: anchorFor(db, String(b.id)),
    }));
}

export const runMessage = (run: FinishedRun, kamajiUrl: string) =>
  [...run.lines, `<${kamajiUrl.replace(/\/$/, '')}/updates#${run.anchor}>`].join('\n');

/** The cycle's part: one message per finished run, marked told only once Discord takes it. */
export async function announceRuns(
  db: Db,
  now: number,
  discord: Discord,
  kamajiUrl: string,
  signal?: AbortSignal,
): Promise<number> {
  let sent = 0;
  const mark = db.prepare('UPDATE batches SET announced_at = ? WHERE id = ?');
  for (const run of unannounced(db)) {
    if (discord.configured && !(await discord.send(runMessage(run, kamajiUrl), signal))) continue;
    // With no Discord, still marked: the toast and Updates say it.
    mark.run(run.finishedAt, run.id);
    sent += 1;
  }
  return sent;
}
