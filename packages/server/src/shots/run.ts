// The screenshots process's work (ops/screenshots-plan.md, "Who does it"): each set that waits,
// one at a time, in a kamaji-shots container that's killed at its cap; then, for an "after" set
// or one taken by hand, the comparison with the set before it. It holds no keys: Docker, the
// screenshots folder and the database. A screenshot failure never touches an update run: the
// updater reads what's here, and goes on without it.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { Exec } from '../sitebackups/restore.js';
import { BLOCKED_HOSTS } from './blocked.js';
import { compareShots, type Box } from './compare.js';
import { readSettings, setDir, sitePages, type SetKind } from './sets.js';

export interface ShotsDeps {
  db: Db;
  exec: Exec;
  docker: string;
  /** data/screenshots. */
  dir: string;
  /** shots/seccomp.json: Playwright's profile, so Chromium's own sandbox works. */
  seccomp: string;
  /** The built image's tag (image.ts). */
  image: string;
  now: () => number;
  log: (message: string) => void;
}

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  {
    name: 'mobile',
    width: 390,
    height: 844,
    mobile: true,
    // A phone's Chrome, since it's Chromium that draws it (Playwright's Pixel 7).
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  },
] as const;
const SCREEN = { desktop: 900, mobile: 844 } as const;
export const MAX_HEIGHT = 15_000;
/** Inside the updater's waits (4 minutes before, 3 after), so it's the container that stops. */
export const CAP_MS: Record<SetKind, number> = {
  before: 225_000,
  after: 165_000,
  manual: 165_000,
};
const GAP_MS = 5_000;
export const KEEP_MS = 30 * 24 * 60 * 60_000;

const ShotLine = z.object({
  format: z.literal(1),
  kind: z.literal('shot'),
  round: z.union([z.literal(1), z.literal(2)]),
  position: z.number().int().min(0).max(10),
  viewport: z.enum(['desktop', 'mobile']),
  ok: z.boolean(),
  file: z.string().optional(),
  thumb: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  cut: z.boolean().optional(),
  quiet: z.boolean().optional(),
  status: z.number().int().nullable().optional(),
  blocked: z.boolean().optional(),
  masks: z
    .array(
      z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .max(200)
    .optional(),
  jsErrors: z.number().int().min(0).optional(),
  jsKeys: z
    .array(z.string().regex(/^[0-9a-f]{16}$/))
    .max(100)
    .optional(),
  failedRequests: z.number().int().min(0).optional(),
  failedKeys: z.array(z.string().max(400)).max(100).optional(),
  blockedRequests: z.number().int().min(0).optional(),
  problem: z.string().max(200).optional(),
});
type ShotLine = z.infer<typeof ShotLine>;

const imageName = (round: number, position: number, viewport: string, ext: 'png' | 'jpg') =>
  `r${round}-p${position}-${viewport}.${ext}`;

/** The lines a container printed that are shots, each checked; anything else is ignored. */
export function readShots(stdout: string): { shots: ShotLine[]; done: boolean } {
  const shots: ShotLine[] = [];
  let done = false;
  for (const line of stdout.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if ((parsed as { kind?: unknown })?.kind === 'done') done = true;
    const shot = ShotLine.safeParse(parsed);
    if (shot.success) shots.push(shot.data);
  }
  return { shots, done };
}

/** The docker run for a set: no capabilities to gain, read only, its own folder and nothing else. */
export function dockerArgs(
  deps: Pick<ShotsDeps, 'seccomp' | 'image'>,
  name: string,
  out: string,
  job: unknown,
): string[] {
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--pull',
    'never',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=512m',
    '--tmpfs',
    '/home/pwuser:rw,size=256m',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${deps.seccomp}`,
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '512',
    '--user',
    'pwuser',
    '--volume',
    `${out}:/out:rw`,
    deps.image,
    JSON.stringify(job),
  ];
}

/** Takes the oldest set that waits, the updater's before any taken by hand. */
function nextSet(db: Db): string | null {
  const r = db
    .prepare(
      `SELECT id FROM screenshot_sets WHERE state = 'waiting'
       ORDER BY CASE kind WHEN 'manual' THEN 1 ELSE 0 END, requested_at LIMIT 1`,
    )
    .get();
  return r ? String(r.id) : null;
}

/** Sets left running when the process stopped. */
export function orphanedSets(db: Db, now: number): void {
  db.prepare(
    `UPDATE screenshot_sets SET state = 'failed', finished_at = ?,
       problem = 'the screenshots process stopped while it shot'
     WHERE state = 'running'`,
  ).run(now);
}

/** Every set that waits fails with the same words: Docker or the image isn't there. */
export function failWaiting(db: Db, now: number, problem: string): void {
  db.prepare(
    "UPDATE screenshot_sets SET state = 'failed', finished_at = ?, problem = ? WHERE state = 'waiting'",
  ).run(now, problem);
}

export async function runShots(deps: ShotsDeps, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) return;
    const id = nextSet(deps.db);
    if (!id) break;
    await runSet(deps, id);
  }
  await retain(deps, deps.now());
}

export async function runSet(deps: ShotsDeps, id: string): Promise<void> {
  const { db } = deps;
  const taken = db
    .prepare(
      "UPDATE screenshot_sets SET state = 'running', started_at = ? WHERE id = ? AND state = 'waiting'",
    )
    .run(deps.now(), id);
  if (Number(taken.changes) === 0) return;
  const set = db.prepare('SELECT * FROM screenshot_sets WHERE id = ?').get(id)!;
  const siteId = String(set.site_id);
  const kind = String(set.kind) as SetKind;
  const out = setDir(deps.dir, siteId, id);
  const finish = (state: 'done' | 'failed', problem: string | null) =>
    // Only while it's still running: the updater may have gone on without it.
    Number(
      db
        .prepare(
          `UPDATE screenshot_sets SET state = ?, problem = ?, finished_at = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(state, problem, deps.now(), id).changes,
    ) > 0;
  const pages = sitePages(db, siteId);
  if (!out || pages.length === 0) {
    finish('failed', 'the site has no pages to shoot');
    return;
  }
  await mkdir(out, { recursive: true, mode: 0o700 });
  const settings = readSettings(db, siteId);
  const job = {
    rounds: Number(set.rounds),
    gapMs: GAP_MS,
    pages,
    viewports: VIEWPORTS,
    hide: settings.hide,
    mask: settings.mask,
    blocked: BLOCKED_HOSTS,
    maxHeight: MAX_HEIGHT,
  };
  const name = `kamaji-shots-${id}`;
  const ran = await deps.exec(deps.docker, dockerArgs(deps, name, out, job), {
    timeoutMs: CAP_MS[kind],
  });
  if (ran.code === null)
    // The CLI stopped at the cap; the container may not have.
    await deps.exec(deps.docker, ['kill', name], { timeoutMs: 30_000 });
  const { shots } = readShots(ran.stdout);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO screenshots (set_id, round, position, page_url, viewport, file, thumb,
       width, height, cut, quiet, status, blocked, js_errors, js_keys, failed_requests,
       failed_keys, blocked_requests, masks, problem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let good = 0;
  for (const s of shots) {
    const url = pages[s.position];
    if (!url) continue;
    // Only the names the script was told to use, and only files that are there.
    const file = s.file === imageName(s.round, s.position, s.viewport, 'png') ? s.file : null;
    const thumb = s.thumb === imageName(s.round, s.position, s.viewport, 'jpg') ? s.thumb : null;
    const ok = s.ok && file !== null && existsSync(join(out, file));
    if (ok && s.round === 1) good += 1;
    insert.run(
      id,
      s.round,
      s.position,
      url,
      s.viewport,
      ok ? file : null,
      ok && thumb && existsSync(join(out, thumb)) ? thumb : null,
      s.width ?? null,
      s.height ?? null,
      s.cut ? 1 : 0,
      s.quiet === false ? 0 : 1,
      s.status ?? null,
      s.blocked ? 1 : 0,
      s.jsErrors ?? 0,
      JSON.stringify(s.jsKeys ?? []),
      s.failedRequests ?? 0,
      JSON.stringify(s.failedKeys ?? []),
      s.blockedRequests ?? 0,
      JSON.stringify(s.masks ?? []),
      ok ? null : (s.problem ?? 'the browser took no shot'),
    );
  }
  const expected = pages.length * VIEWPORTS.length;
  if (good === 0) {
    const problem =
      ran.code === null
        ? 'it took too long, and no shot was finished'
        : ran.code === 125
          ? 'Docker couldn’t start the browser'
          : shots.length > 0
            ? 'none of the pages could be shot'
            : `the browser took no shots (exit ${ran.code})`;
    if (!finish('failed', problem)) await rm(out, { recursive: true, force: true });
    deps.log(`shots: ${siteId} ${kind} failed`);
    return;
  }
  if (kind !== 'before') await compareSet(deps, id).catch(() => {});
  const problem =
    ran.code === null ? `it took too long: ${good} of ${expected} shots were finished` : null;
  if (!finish('done', problem)) await rm(out, { recursive: true, force: true });
  deps.log(`shots: ${siteId} ${kind} done, ${good} of ${expected}`);
}

/** The set an "after" or a manual set is compared against. */
function againstSet(db: Db, set: Record<string, unknown>): string | null {
  const r =
    set.kind === 'after'
      ? db
          .prepare(
            `SELECT id FROM screenshot_sets WHERE batch_id = ? AND site_id = ? AND kind = 'before'
             AND state = 'done' ORDER BY requested_at DESC LIMIT 1`,
          )
          .get(String(set.batch_id), String(set.site_id))
      : db
          .prepare(
            `SELECT id FROM screenshot_sets WHERE site_id = ? AND id != ? AND state = 'done'
             AND requested_at < ? ORDER BY requested_at DESC LIMIT 1`,
          )
          .get(String(set.site_id), String(set.id), Number(set.requested_at));
  return r ? String(r.id) : null;
}

const keys = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const masksOf = (raw: unknown): Box[] => {
  try {
    return JSON.parse(String(raw ?? '[]')) as Box[];
  } catch {
    return [];
  }
};

/** Compares each page and size of a set with the set before it, then lets the mask round go. */
export async function compareSet(deps: ShotsDeps, id: string): Promise<void> {
  const { db } = deps;
  const set = db.prepare('SELECT * FROM screenshot_sets WHERE id = ?').get(id)!;
  const against = againstSet(db, set);
  if (!against) return;
  const siteId = String(set.site_id);
  const out = setDir(deps.dir, siteId, id)!;
  const beforeDir = setDir(deps.dir, siteId, against)!;
  const shots = db.prepare(
    'SELECT * FROM screenshots WHERE set_id = ? AND round = ? AND page_url = ? AND viewport = ?',
  );
  const insert = db.prepare(
    `INSERT INTO screenshot_comparisons (set_id, against_set_id, site_id, page_url, viewport,
       before_id, after_id, compared, changed_pct, masked_pct, height_before, height_after,
       new_js_errors, new_failed_requests, diff_file, problem, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const afters = db
    .prepare('SELECT * FROM screenshots WHERE set_id = ? AND round = 1 ORDER BY position')
    .all(id);
  for (const a of afters) {
    const url = String(a.page_url);
    const viewport = String(a.viewport) as 'desktop' | 'mobile';
    const b = shots.get(against, 1, url, viewport);
    const again = shots.get(against, 2, url, viewport);
    const row = (o: {
      compared: 'page' | 'first screen' | 'none';
      changed?: number | null;
      masked?: number | null;
      diff?: string | null;
      problem?: string | null;
    }) => {
      const beforeKeys = new Set([...keys(b?.js_keys), ...keys(again?.js_keys)]);
      const beforeFailed = new Set([...keys(b?.failed_keys), ...keys(again?.failed_keys)]);
      insert.run(
        id,
        against,
        siteId,
        url,
        viewport,
        b ? Number(b.id) : null,
        Number(a.id),
        o.compared,
        o.changed ?? null,
        o.masked ?? null,
        b?.height ?? null,
        a.height ?? null,
        b ? keys(a.js_keys).filter((k) => !beforeKeys.has(k)).length : 0,
        b ? keys(a.failed_keys).filter((k) => !beforeFailed.has(k)).length : 0,
        o.diff ?? null,
        o.problem ?? null,
        deps.now(),
      );
    };
    if (!b) {
      row({ compared: 'none', problem: 'there’s no earlier shot of it to compare with' });
      continue;
    }
    if (b.file === null) {
      row({
        compared: 'none',
        problem: 'it couldn’t be shot before, so there’s nothing to compare',
      });
      continue;
    }
    if (a.file === null) {
      row({
        compared: 'none',
        problem: Number(a.blocked)
          ? 'Cloudflare’s bot check answered instead of the page'
          : `it was shot before, but not after: ${String(a.problem ?? 'it failed')}`,
      });
      continue;
    }
    try {
      const result = compareShots(
        { png: await readFile(join(beforeDir, String(b.file))), masks: masksOf(b.masks) },
        { png: await readFile(join(out, String(a.file))), masks: masksOf(a.masks) },
        {
          screenHeight: SCREEN[viewport],
          beforeAgain:
            again?.file && set.kind === 'after'
              ? {
                  png: await readFile(join(beforeDir, String(again.file))),
                  masks: masksOf(again.masks),
                }
              : null,
        },
      );
      const diff = `diff-p${String(a.position)}-${viewport}.png`;
      await writeFile(join(out, diff), result.diff, { mode: 0o600 });
      row({
        compared: result.compared,
        changed: result.changedPct,
        masked: result.maskedPct,
        diff,
      });
    } catch {
      row({ compared: 'none', problem: 'the images couldn’t be compared' });
    }
  }
  // The second "before" round was only for the masks.
  if (set.kind === 'after') {
    for (const r of db
      .prepare('SELECT id, file, thumb FROM screenshots WHERE set_id = ? AND round = 2')
      .all(against)) {
      for (const f of [r.file, r.thumb])
        if (f) await rm(join(beforeDir, String(f)), { force: true });
    }
    db.prepare(
      'UPDATE screenshots SET file = NULL, thumb = NULL WHERE set_id = ? AND round = 2',
    ).run(against);
  }
}

/**
 * Kept 30 days, and each site's latest finished set whatever its age, with the "before" set it
 * was compared against (Tyler, 2026-11-19).
 */
export async function retain(deps: Pick<ShotsDeps, 'db' | 'dir'>, now: number): Promise<number> {
  const { db } = deps;
  const keep = new Set<string>();
  for (const r of db
    .prepare(
      `SELECT s.id, s.site_id FROM screenshot_sets s WHERE s.state = 'done' AND s.requested_at = (
         SELECT MAX(requested_at) FROM screenshot_sets t WHERE t.site_id = s.site_id AND t.state = 'done')`,
    )
    .all()) {
    keep.add(String(r.id));
    for (const c of db
      .prepare('SELECT DISTINCT against_set_id FROM screenshot_comparisons WHERE set_id = ?')
      .all(String(r.id)))
      keep.add(String(c.against_set_id));
  }
  const old = db
    .prepare(
      "SELECT id, site_id FROM screenshot_sets WHERE requested_at < ? AND state IN ('done', 'failed')",
    )
    .all(now - KEEP_MS)
    .filter((r) => !keep.has(String(r.id)));
  for (const r of old) {
    const id = String(r.id);
    db.prepare('DELETE FROM screenshot_comparisons WHERE set_id = ? OR against_set_id = ?').run(
      id,
      id,
    );
    db.prepare('DELETE FROM screenshots WHERE set_id = ?').run(id);
    db.prepare('DELETE FROM screenshot_sets WHERE id = ?').run(id);
    const dir = setDir(deps.dir, String(r.site_id), id);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  return old.length;
}
