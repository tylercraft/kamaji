// Calcifer's crash log (docs/crash-hook.md): one JSON line per uncaught Python exception, written
// by calcifer's ops/molcajete/crash_hook.py. Kamaji reads the new lines each cycle, keeps where
// each crash happened (job, type, where, line, frames) and raises one issue per new group.
//
// Message and traceback never reach the database, for any job: the hook writes them only for the
// allowlisted jobs, Kamaji drops them if they arrive for any other, and they're read from the log
// itself, on the mini, when the Servers page asks for one job's details.
//
// A group (job + type + where) alerts once when it first crashes, then stays quiet: no reminders
// and no "resolved" line. It closes after 7 days without a crash, so the next crash after that
// alerts again.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { localParts } from '../notify.js';
import { readState, writeState } from '../state.js';
import { fullText, shortName } from './jobs.js';
import { CRASH_KIND } from './kinds.js';

export { CRASH_KIND };

export const QUIET_MS = 7 * 86_400_000;
const STATE = 'crash-log';

const Frame = z.object({ file: z.string(), function: z.string(), line: z.number().nullish() });

export const CrashRecord = z.object({
  v: z.literal(1),
  at: z.string(),
  job: z.string(),
  script: z.string().nullish(),
  pid: z.number().nullish(),
  type: z.string(),
  where: z.string().nullish(),
  line: z.number().nullish(),
  frames: z.array(Frame).default([]),
  message: z.string().optional(),
  traceback: z.string().optional(),
});
export type CrashRecord = z.infer<typeof CrashRecord>;

/** Parses crash lines; message and traceback survive only for allowlisted jobs. */
export function parseCrashLines(text: string): { records: CrashRecord[]; bad: number } {
  const records: CrashRecord[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    const r = CrashRecord.safeParse(json);
    if (!r.success || Number.isNaN(Date.parse(r.data.at))) {
      bad++;
      continue;
    }
    const record = r.data;
    if (!fullText(record.job)) {
      delete record.message;
      delete record.traceback;
    }
    records.push(record);
  }
  return { records, bad };
}

export interface CrashFiles {
  /** ~/Library/Logs/calcifer-crashes.jsonl; the hook renames it to <path>.1 at 5 MB. */
  path: string;
}

interface Cursor {
  ino: number;
  offset: number;
}

function stat(path: string): { ino: number; size: number } | null {
  try {
    const s = statSync(path);
    return { ino: s.ino, size: s.size };
  } catch {
    return null;
  }
}

/** The complete lines from `offset` on, and where the next read starts. */
function readFrom(path: string, offset: number): { text: string; end: number } {
  const size = stat(path)?.size ?? 0;
  if (size <= offset) return { text: '', end: offset };
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { text: '', end: offset };
  return {
    text: buffer.subarray(0, lastNewline + 1).toString('utf8'),
    end: offset + lastNewline + 1,
  };
}

/** The lines written since the last call, following the hook's rename to .1. */
export function readNewCrashLines(db: Db, now: number, files: CrashFiles): string {
  const saved = readState<Cursor>(db, STATE);
  const current = stat(files.path);
  const rotated = `${files.path}.1`;
  let text = '';
  let next: Cursor | null = saved;

  if (!current) {
    // Renamed and nothing written since: finish the old file.
    const old = stat(rotated);
    if (saved && old?.ino === saved.ino) {
      const r = readFrom(rotated, saved.offset);
      text = r.text;
      next = { ino: saved.ino, offset: r.end };
    }
  } else if (saved && current.ino === saved.ino) {
    const r = readFrom(files.path, current.size < saved.offset ? 0 : saved.offset);
    text = r.text;
    next = { ino: current.ino, offset: r.end };
  } else {
    const old = stat(rotated);
    if (old && (!saved || old.ino === saved.ino)) {
      text = readFrom(rotated, saved ? saved.offset : 0).text;
    }
    const r = readFrom(files.path, 0);
    text += r.text;
    next = { ino: current.ino, offset: r.end };
  }
  if (next) writeState(db, STATE, next, now);
  return text;
}

export function groupId(job: string, type: string, where: string | null | undefined): string {
  return createHash('sha256')
    .update(`${job}\0${type}\0${where ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Stores the crashes (never their message or traceback). Returns how many. */
export function storeCrashes(db: Db, records: CrashRecord[]): number {
  const upsert = db.prepare(
    `INSERT INTO crash_groups (id, job, type, where_at, line, frames, first_at, last_at, count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (id) DO UPDATE SET
       line = CASE WHEN excluded.last_at >= last_at THEN excluded.line ELSE line END,
       frames = CASE WHEN excluded.last_at >= last_at THEN excluded.frames ELSE frames END,
       first_at = MIN(first_at, excluded.first_at),
       last_at = MAX(last_at, excluded.last_at),
       count = count + 1`,
  );
  const insert = db.prepare('INSERT INTO crashes (group_id, at, pid) VALUES (?, ?, ?)');
  for (const r of records) {
    const id = groupId(r.job, r.type, r.where);
    const at = Date.parse(r.at);
    const frames = JSON.stringify(
      r.frames.map((f) => ({ file: f.file, function: f.function, line: f.line ?? null })),
    );
    upsert.run(id, r.job, r.type, r.where ?? null, r.line ?? null, frames, at, at);
    insert.run(id, at, r.pid ?? null);
  }
  return records.length;
}

function when(at: number, now: number): string {
  const a = localParts(at);
  if (a.day === localParts(now).day) return a.time;
  const date = new Date(`${a.day}T00:00:00Z`).toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `${date} ${a.time}`;
}

const key = (id: string) =>
  ({ resourceType: 'server', resourceId: 'molcajete', kind: `${CRASH_KIND}${id}` }) as const;

/** Raises an issue for each group crashing now; closes those quiet for 7 days. */
export function judgeCrashes(db: Db, now: number): void {
  const recent = db
    .prepare('SELECT id, job FROM crash_groups WHERE last_at >= ?')
    .all(now - QUIET_MS);
  const times = db.prepare('SELECT at FROM crashes WHERE group_id = ? ORDER BY at DESC');
  for (const g of recent) {
    const id = String(g.id);
    // This run of crashes: back to the last 7-day gap.
    const ats = times.all(id).map((r) => Number(r.at));
    let start = ats[0] ?? now;
    let count = 0;
    for (const at of ats) {
      if (start - at > QUIET_MS) break;
      start = at;
      count++;
    }
    const name = shortName(String(g.job));
    raiseIssue(db, now, {
      ...key(id),
      severity: 'urgent',
      summary:
        count === 1
          ? `${name} crashed at ${when(start, now)}`
          : `${name} crashed ${count} times since ${when(start, now)}`,
    });
  }
  const open = db
    .prepare(
      `SELECT issues.kind, crash_groups.job, crash_groups.last_at FROM issues
       JOIN crash_groups ON issues.kind = '${CRASH_KIND}' || crash_groups.id
       WHERE issues.resolved_at IS NULL AND issues.resource_id = 'molcajete'`,
    )
    .all();
  for (const r of open) {
    if (Number(r.last_at) >= now - QUIET_MS) continue;
    const id = String(r.kind).slice(CRASH_KIND.length);
    clearIssue(db, now, key(id), `${shortName(String(r.job))}: no crashes for 7 days`);
  }
}

/** Reads, stores and judges the new crash lines. Returns how many crashes it stored. */
export function checkCrashes(db: Db, now: number, files: CrashFiles): number {
  const { records } = parseCrashLines(readNewCrashLines(db, now, files));
  const stored = storeCrashes(db, records);
  judgeCrashes(db, now);
  return stored;
}

export interface CrashGroup {
  id: string;
  job: string;
  type: string;
  where: string | null;
  line: number | null;
  frames: { file: string; function: string; line: number | null }[];
  lastAt: number;
  /** Crashes in the last 7 days. */
  recent: number;
}

/** Groups that crashed in the last 7 days, newest first. */
export function recentCrashGroups(db: Db, now: number): CrashGroup[] {
  return db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM crashes c WHERE c.group_id = g.id AND c.at >= ?) AS recent
       FROM crash_groups g WHERE g.last_at >= ? ORDER BY g.last_at DESC`,
    )
    .all(now - QUIET_MS, now - QUIET_MS)
    .map((r) => ({
      id: String(r.id),
      job: String(r.job),
      type: String(r.type),
      where: r.where_at === null ? null : String(r.where_at),
      line: r.line === null ? null : Number(r.line),
      frames: JSON.parse(String(r.frames)) as CrashGroup['frames'],
      lastAt: Number(r.last_at),
      recent: Number(r.recent),
    }));
}

/**
 * One job's latest crash, read from the log on the mini for the Servers page: never stored.
 * Message and traceback only for allowlisted jobs.
 */
export function latestCrash(files: CrashFiles, job: string): CrashRecord | null {
  for (const path of [files.path, `${files.path}.1`]) {
    const { text } = readFrom(path, 0);
    const mine = parseCrashLines(text).records.filter((r) => r.job === job);
    const last = mine.at(-1);
    if (last) return last;
  }
  return null;
}
