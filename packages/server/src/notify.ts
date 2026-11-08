// What Tyler hears, and when (calcifer explore/kamaji.md, "Notifications"): once per problem at
// once, again when it's resolved, a reminder each 24 hours it stays open, and a morning digest
// only when there's something in it. Silence means fine.
//
// At once: urgent issues. Normal issues wait for the digest. A public site being down is the
// Worker's to announce once it runs, since it watches from outside and alerts even when the
// mini is dark; Kamaji announces it only for tailnet-only sites, or while there's no Worker.
//
// Bookkeeping is written only after Discord takes the message, so a failed send is retried
// next cycle rather than lost.
import type { Db } from './db.js';
import type { Discord } from './discord.js';
import { readState, writeState } from './state.js';

export const REMINDER_MS = 24 * 60 * 60 * 1000;
export const TIME_ZONE = 'Pacific/Auckland';

export interface NotifyOptions {
  /** Kamaji's own address, for the link in every message. */
  kamajiUrl: string;
  /** True once the Worker is announcing public sites going down. */
  workerAlerts: boolean;
  /** Local time (Pacific/Auckland) the digest goes, as HH:MM. */
  digestAt: string;
  signal?: AbortSignal;
}

type Row = Record<string, unknown>;

/** Whether Kamaji, rather than the Worker, announces this issue. */
function oursToAnnounce(r: Row, workerAlerts: boolean): boolean {
  if (r.resource_type === 'site' && r.kind === 'down') {
    return !workerAlerts || Number(r.tailnet_only) === 1;
  }
  return true;
}

const ISSUES = `SELECT issues.*, sites.tailnet_only FROM issues
  LEFT JOIN sites ON issues.resource_type = 'site' AND sites.id = issues.resource_id`;

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Sends what's due at once. Returns how many issues it told Tyler about. */
export async function notifyNow(
  db: Db,
  now: number,
  discord: Discord,
  options: NotifyOptions,
): Promise<number> {
  if (!discord.configured) return 0;
  const { workerAlerts } = options;

  const fresh = db
    .prepare(`${ISSUES} WHERE resolved_at IS NULL AND severity = 'urgent' AND notified_at IS NULL`)
    .all()
    .filter((r) => oursToAnnounce(r, workerAlerts));
  const recovered = db
    .prepare(
      `${ISSUES} WHERE resolved_at IS NOT NULL AND notified_at IS NOT NULL
       AND recovery_notified_at IS NULL`,
    )
    .all();
  const reminders = db
    .prepare(
      `${ISSUES} WHERE resolved_at IS NULL AND notified_at IS NOT NULL
       AND COALESCE(reminded_at, notified_at) <= ?`,
    )
    .all(now - REMINDER_MS);

  const lines = [
    ...fresh.map((r) => String(r.summary)),
    ...recovered.map(
      (r) =>
        `Resolved: ${String(r.summary)} (after ${duration(Number(r.resolved_at) - Number(r.first_seen_at))})`,
    ),
    ...reminders.map(
      (r) => `Still open after ${duration(now - Number(r.first_seen_at))}: ${String(r.summary)}`,
    ),
  ];
  if (lines.length === 0) return 0;

  const message = ['**Kamaji**', ...lines.map((l) => `- ${l}`), `<${options.kamajiUrl}>`].join(
    '\n',
  );
  if (!(await discord.send(message, options.signal))) return 0;

  const mark = (sql: string, rows: Row[]) => {
    const statement = db.prepare(sql);
    for (const r of rows) statement.run(now, String(r.id));
  };
  mark('UPDATE issues SET notified_at = ? WHERE id = ?', fresh);
  mark('UPDATE issues SET recovery_notified_at = ? WHERE id = ?', recovered);
  mark('UPDATE issues SET reminded_at = ? WHERE id = ?', reminders);
  return lines.length;
}

/** The local date and time in Pacific/Auckland, as YYYY-MM-DD and HH:MM. */
export function localParts(at: number): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

const DIGEST = 'digest';

/**
 * The morning digest: once a day from digestAt, the issues that don't warrant a ping. Nothing to
 * say, nothing sent. Returns whether it sent one.
 */
export async function sendDigest(
  db: Db,
  now: number,
  discord: Discord,
  options: NotifyOptions,
): Promise<boolean> {
  if (!discord.configured) return false;
  const { day, time } = localParts(now);
  if (time < options.digestAt) return false;
  if (readState<{ day: string }>(db, DIGEST)?.day === day) return false;

  const open = db
    .prepare(
      `SELECT summary FROM issues WHERE resolved_at IS NULL AND severity = 'normal'
              ORDER BY first_seen_at`,
    )
    .all()
    .map((r) => String(r.summary));
  if (open.length > 0) {
    const message = [
      `**Kamaji, this morning:** ${open.length} to look at when you have a moment`,
      ...open.map((s) => `- ${s}`),
      `<${options.kamajiUrl}>`,
    ].join('\n');
    if (!(await discord.send(message, options.signal))) return false;
  }
  writeState(db, DIGEST, { day, sent: open.length }, now);
  return open.length > 0;
}
