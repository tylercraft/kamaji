// A rollback or undo, run by the backups process (ops/rollback-plan.md, "The push"), which holds
// the restic password and the SSH keys. For a rollback: ask again whether it's still offered;
// read the run's snapshot back and take out only the folders the run changed (and database.sql,
// on Kinsta, when the database comes too); check each one's version is what the run replaced;
// send them, with plan.txt first, as one tar to site-push/push on the host. An undo sends nothing
// but its words. What the script says is recorded on the row; the updater runs the checks after.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import type { PullHost } from '../sitebackups/eligible.js';
import type { Exec, Ran } from '../sitebackups/restore.js';
import type { Restic } from '../sitebackups/restic.js';
import { stderrTail } from '../sitebackups/stderrTail.js';
import { rollbackItems, rollbackOffer, undoOffer, type RollbackItem } from './offer.js';

export interface PushDeps {
  db: Db;
  restic: Restic;
  exec: Exec;
  /** Where the snapshot's folders are taken out to: ~/kamaji-restore, mode 700, like the check's. */
  workDir: string;
  /** The mini's tar, for reading the snapshot and writing what's sent. */
  tar: string;
  /** ssh's argv for site-push on the site's host with these words, or null with no access. */
  pushCommand: (siteId: string, host: PullHost, words: string[]) => string[] | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  signal?: AbortSignal;
}

/** The uptime pause while the push runs: maintenance mode answers 503. */
const PAUSE_MS = 15 * 60_000;
/** A push with a big database to import can take a while. */
const PUSH_TIMEOUT_MS = 45 * 60_000;
/** Asking for the result again, when the connection dropped after the site started changing. */
const RESULT_TRIES = 3;
const RESULT_WAIT_MS = 20_000;

const Changed = z.enum(['none', 'files', 'all', 'partial', 'broken', 'unknown']);
/** One line from site-push/push (its header comment): progress, the count, or the result. */
const PushLine = z.looseObject({
  format: z.literal(1),
  ok: z.boolean(),
  step: z.string().max(40),
  problem: z.string().max(500).optional(),
  changed: Changed.optional(),
  database: z.boolean().optional(),
  warnings: z.array(z.string().max(200)).max(10).optional(),
  orders: z.number().int().nonnegative().nullable().optional(),
  comments: z.number().int().nonnegative().optional(),
  users: z.number().int().nonnegative().optional(),
});
type PushLine = z.infer<typeof PushLine>;

export interface PushRead {
  steps: string[];
  counts: { orders: number | null; comments: number; users: number } | null;
  result: PushLine | null;
}

/** What the script said, line by line; anything that isn't one of its lines is ignored. */
export function readPush(stdout: string): PushRead {
  const out: PushRead = { steps: [], counts: null, result: null };
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let parsed;
    try {
      parsed = PushLine.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const l = parsed.data;
    if (!l.ok || l.step === 'done') {
      out.result = l;
      continue;
    }
    out.steps.push(l.step);
    if (l.step === 'count' && l.comments !== undefined && l.users !== undefined)
      out.counts = { orders: l.orders ?? null, comments: l.comments, users: l.users };
  }
  return out;
}

/** The steps after which the site may have changed: from maintenance on, the script carries on. */
const COMMITTED = ['save', 'maintenance', 'swap', 'database'];

/** A plugin's or theme's Version header, read the way WordPress's get_file_data() reads it. */
export function headerVersion(text: string): string | null {
  const head = text.slice(0, 8192).replace(/\r/g, '\n');
  const m = /^[ \t/*#@]*Version:(.*)$/im.exec(head);
  if (!m) return null;
  return m[1]!.replace(/\s*(?:\*\/|\?>).*/, '').trim() || null;
}

/** Where an item is in a pull's tar, and the file holding its version. */
export function itemPaths(i: RollbackItem): { member: string; versionFile: string } | null {
  if (i.type === 'plugin') {
    const dir = i.item.split('/')[0]!;
    return { member: `wp-content/plugins/${dir}`, versionFile: `wp-content/plugins/${i.item}` };
  }
  if (i.type === 'theme')
    return {
      member: `wp-content/themes/${i.item}`,
      versionFile: `wp-content/themes/${i.item}/style.css`,
    };
  return null;
}

/** The plan the script reads first: one fact a line (site-push/push, read_plan). */
export function planText(o: {
  id: string;
  site: string;
  items: RollbackItem[];
  database: { from: 'export'; time: string } | { from: 'tar' } | null;
  since: string | null;
}): string {
  const lines = ['format 1', `id ${o.id}`, `site ${o.site}`];
  for (const i of o.items) lines.push(`item ${i.type} ${i.item} ${i.now} ${i.back}`);
  if (o.database)
    lines.push(
      o.database.from === 'export' ? `database export ${o.database.time}` : 'database tar',
    );
  if (o.since) lines.push(`since ${o.since}`);
  return `${lines.join('\n')}\n`;
}

/** db-export's own way of naming a time, which the plan's `since` uses too. */
export const compactTime = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

/** Pipes the snapshot's tar into the mini's tar, taking out only `members`. */
function extract(tar: string, dir: string, members: string[], stream: Readable): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(tar, ['-x', '-p', '-f', '-', '-C', dir, ...members], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-64 * 1024);
    });
    // tar stopping early (a member that isn't there) shouldn't leave the dump hanging.
    child.stdin.on('error', () => stream.resume());
    stream.pipe(child.stdin);
    child.on('error', () => resolve({ code: null, stdout: '', stderr }));
    child.on('close', (code) => resolve({ code, stdout: '', stderr }));
  });
}

type Row = Record<string, unknown>;
type Outcome = {
  state: 'done' | 'failed';
  step: string;
  problem: string | null;
  detail?: string | null;
  changed: z.infer<typeof Changed>;
  counts?: PushRead['counts'];
  warnings?: string[];
};

const siteName = (db: Db, siteId: string) =>
  String(db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId)?.name ?? siteId);

function record(deps: PushDeps, row: Row, o: Outcome): void {
  const { db } = deps;
  const at = deps.now();
  const nothing = o.changed === 'none';
  db.prepare(
    `UPDATE rollbacks SET state = ?, step = ?, problem = ?, problem_detail = ?, changed = ?,
       counts = ?, warnings = ?, finished_at = ?, checked_at = ? WHERE id = ?`,
  ).run(
    o.state,
    o.step,
    o.problem,
    o.detail ?? null,
    o.changed,
    o.counts ? JSON.stringify(o.counts) : null,
    o.warnings && o.warnings.length > 0 ? JSON.stringify(o.warnings) : null,
    at,
    // Nothing changed: no checks to run, so it's ready to tell.
    nothing ? at : null,
    String(row.id),
  );
  if (nothing) {
    db.prepare('UPDATE sites SET updating_until = NULL WHERE id = ?').run(String(row.site_id));
    const what = row.kind === 'undo' ? 'undo of the rollback of' : 'rollback of';
    recordEvent(db, at, {
      kind: 'site.rollback-failed',
      summary: `The ${what} ${siteName(db, String(row.site_id))} stopped at “${o.step}” with nothing changed: ${o.problem ?? 'it failed'}`,
      resourceType: 'site',
      resourceId: String(row.site_id),
      detail: { rollback: String(row.id) },
    });
  }
  deps.log(
    `rollback: ${String(row.site_id)} ${String(row.kind)} ${o.state} at ${o.step} (${o.changed})`,
  );
}

const fail = (step: string, problem: string, detail?: string | null): Outcome => ({
  state: 'failed',
  step,
  problem,
  detail: detail ?? null,
  changed: 'none',
});

/** From a finished push: the outcome as the script told it, or asked for again. */
async function outcomeOf(
  deps: PushDeps,
  row: Row,
  ran: Ran,
  resultWords: string[],
): Promise<Outcome> {
  let read = readPush(ran.stdout);
  if (!read.result && read.steps.some((s) => COMMITTED.includes(s))) {
    // The connection dropped after the script stopped minding it: it finishes on its own, and
    // leaves its result where `result` reads it.
    for (let n = 0; n < RESULT_TRIES && !read.result; n++) {
      await deps.sleep(RESULT_WAIT_MS);
      const command = deps.pushCommand(
        String(row.site_id),
        String(row.host) as PullHost,
        resultWords,
      );
      if (!command) break;
      const [bin, ...args] = command;
      const asked = await deps.exec(bin!, args, { timeoutMs: 2 * 60_000 });
      const again = readPush(asked.stdout).result;
      if (again && again.step !== 'unknown') read = { ...read, result: again };
    }
    if (!read.result)
      return {
        state: 'failed',
        step: 'connection',
        problem:
          'the connection dropped after it began changing the site, and its result couldn’t be read; look on the server',
        detail: stderrTail(ran.stderr),
        changed: 'unknown',
        counts: read.counts,
      };
  }
  const result = read.result;
  if (!result)
    return fail(
      'connection',
      ran.code === 255
        ? 'SSH couldn’t connect to the host'
        : ran.code === null
          ? 'it took too long, or couldn’t start'
          : `the push ended without saying how (exit ${ran.code})`,
      stderrTail(ran.stderr),
    );
  if (result.ok)
    return {
      state: 'done',
      step: 'done',
      problem: null,
      changed: result.database === false && Number(row.with_database) === 1 ? 'files' : 'all',
      counts: read.counts,
      warnings: result.warnings ?? [],
    };
  return {
    state: 'failed',
    step: result.step,
    problem: result.problem ?? 'it failed',
    changed: result.changed ?? 'unknown',
    counts: read.counts,
  };
}

/** Runs one waiting rollback or undo. */
export async function runRollback(deps: PushDeps, id: string): Promise<void> {
  const { db } = deps;
  const row = db.prepare("SELECT * FROM rollbacks WHERE id = ? AND state = 'waiting'").get(id);
  if (!row) return;
  db.prepare("UPDATE rollbacks SET state = 'running', started_at = ? WHERE id = ?").run(
    deps.now(),
    id,
  );
  try {
    const outcome = row.kind === 'undo' ? await undo(deps, row) : await rollback(deps, row);
    record(deps, row, outcome);
  } catch (error) {
    record(
      deps,
      row,
      fail('mini', `it stopped on the mini (${error instanceof Error ? error.name : 'error'})`),
    );
  }
}

function pause(deps: PushDeps, siteId: string): void {
  deps.db
    .prepare('UPDATE sites SET updating_until = MAX(COALESCE(updating_until, 0), ?) WHERE id = ?')
    .run(deps.now() + PAUSE_MS, siteId);
}

async function rollback(deps: PushDeps, row: Row): Promise<Outcome> {
  const { db } = deps;
  const id = String(row.id);
  const siteId = String(row.site_id);
  const host = String(row.host) as PullHost;
  const items = rollbackItems(db, id);
  // Asked again: the site may have moved on since Tyler asked.
  const offer = rollbackOffer(db, siteId, deps.now(), id);
  if (!offer.ok) return fail('check', offer.why);
  const same =
    offer.batchId === String(row.batch_id) &&
    offer.restorePoint.snapshotId === String(row.snapshot_id) &&
    JSON.stringify(offer.items) === JSON.stringify(items);
  if (!same) return fail('check', 'the site changed since you asked; look again');
  const withDatabase = Number(row.with_database) === 1;
  const exportTime = row.export_time === null ? null : String(row.export_time);
  const fromTar = withDatabase && !exportTime;

  await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(deps.workDir, `rollback-${siteId}-`));
  try {
    const files = join(dir, 'files');
    await mkdir(files, { mode: 0o700 });
    const members = items.flatMap((i) => itemPaths(i)?.member ?? []);
    if (fromTar) members.push('database.sql');
    if (members.length > 0) {
      const dumped = await deps.restic.dump(
        String(row.snapshot_id),
        siteId,
        (stream) => extract(deps.tar, files, members, stream),
        deps.signal,
      );
      if (!dumped.ok)
        return fail('snapshot', `the restore point couldn’t be read: ${dumped.problem}`);
      if (dumped.value.code !== 0)
        return fail(
          'snapshot',
          'the restore point doesn’t hold every folder the run changed',
          stderrTail(dumped.value.stderr),
        );
    }
    // Readable and removable here, whatever modes the snapshot carried: owner bits only, which
    // the server's own copies already have.
    await deps.exec('/bin/chmod', ['-R', 'u+rwX', files]);
    for (const i of items) {
      const paths = itemPaths(i);
      if (!paths) continue;
      let text: string;
      try {
        text = await readFile(join(files, paths.versionFile), 'utf8');
      } catch {
        return fail('snapshot', `the restore point has no ${i.name}`);
      }
      const version = headerVersion(text);
      if (version !== i.back)
        return fail(
          'snapshot',
          `the restore point’s ${i.name} is ${version ?? 'of no version'}, not ${i.back}: it’s older than a change made outside Kamaji`,
        );
    }
    await writeFile(
      join(files, 'plan.txt'),
      planText({
        id,
        site: siteId,
        items,
        database: withDatabase
          ? exportTime
            ? { from: 'export', time: exportTime }
            : { from: 'tar' }
          : null,
        since: withDatabase ? compactTime(Number(row.database_at)) : null,
      }),
      { mode: 0o600 },
    );
    const sent = join(dir, 'push.tar');
    const parts = ['plan.txt'];
    if (items.some((i) => i.type !== 'core')) parts.push('wp-content');
    if (fromTar) parts.push('database.sql');
    // GNU tar's format, which the host's GNU tar reads; no macOS metadata files in it.
    const packed = await deps.exec(
      deps.tar,
      ['-c', '-f', sent, '--format', 'gnutar', '--no-mac-metadata', '-C', files, ...parts],
      { env: { COPYFILE_DISABLE: '1' }, timeoutMs: 10 * 60_000 },
    );
    if (packed.code !== 0)
      return fail('pack', 'what’s sent couldn’t be packed', stderrTail(packed.stderr));
    // Only database.sql held client data; it's in the tar now, which goes when the folder does.
    await rm(join(files, 'database.sql'), { force: true });

    const command = deps.pushCommand(siteId, host, ['rollback', siteId, id]);
    if (!command) return fail('connection', 'its SSH access isn’t set');
    pause(deps, siteId);
    const [bin, ...args] = command;
    const ran = await deps.exec(bin!, args, { stdinFile: sent, timeoutMs: PUSH_TIMEOUT_MS });
    return outcomeOf(deps, row, ran, ['result', siteId, id, 'rollback']);
  } finally {
    await deps.exec('/bin/chmod', ['-R', 'u+rwX', dir]);
    await rm(dir, { recursive: true, force: true });
  }
}

async function undo(deps: PushDeps, row: Row): Promise<Outcome> {
  const { db } = deps;
  const siteId = String(row.site_id);
  const host = String(row.host) as PullHost;
  const undoes = String(row.undoes);
  const offer = undoOffer(db, siteId, deps.now(), String(row.id));
  if (!offer?.ok) return fail('check', offer ? offer.why : 'there’s no rollback to undo');
  if (offer.rollbackId !== undoes)
    return fail('check', 'the rollback to undo has changed; look again');
  const withDatabase = Number(row.with_database) === 1;
  const command = deps.pushCommand(siteId, host, [
    'undo',
    siteId,
    undoes,
    withDatabase ? 'database' : 'files',
  ]);
  if (!command) return fail('connection', 'its SSH access isn’t set');
  pause(deps, siteId);
  const [bin, ...args] = command;
  const ran = await deps.exec(bin!, args, { timeoutMs: PUSH_TIMEOUT_MS });
  return outcomeOf(deps, row, ran, ['result', siteId, undoes, 'undo']);
}

/** Rollbacks a backups process left running when it stopped: none can still be going. */
export function orphaned(db: Db, now: number): number {
  return db
    .prepare(
      `UPDATE rollbacks SET state = 'failed', step = 'mini', changed = 'unknown', finished_at = ?,
         problem = 'the backups process stopped while it ran; look on the server'
       WHERE state = 'running'`,
    )
    .run(now).changes as number;
}
