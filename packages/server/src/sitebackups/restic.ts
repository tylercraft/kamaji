// restic, as the backups process uses it (ops/backups-plan.md). The repository and its password
// come from the environment (RESTIC_REPOSITORY, RESTIC_PASSWORD, from Doppler's `backup`
// config), never the command line. Output is parsed as restic's docs describe it
// (fixtures/README.md); stderr is never stored, only the pull's own JSON problem line or what
// restic's exit code means.
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { z } from 'zod';

export type Result<T = object> = ({ ok: true } & T) | { ok: false; problem: string };

export interface Restic {
  /** One snapshot of what `command` writes to stdout, as `<site>.tar`, tagged site:<site>. */
  backup(
    site: string,
    command: string[],
    signal?: AbortSignal,
  ): Promise<Result<{ snapshotId: string; bytes: number; added: number }>>;
  /** Streams `<site>.tar` from a snapshot into `read`. */
  dump<T>(
    snapshotId: string,
    site: string,
    read: (stream: Readable) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<Result<{ value: T }>>;
  forget(snapshotIds: string[]): Promise<Result>;
  /** Retention for one site: 4 weekly, 6 monthly. */
  keep(site: string): Promise<Result>;
  snapshots(site: string): Promise<Result<{ ids: string[] }>>;
  prune(): Promise<Result>;
  check(): Promise<Result>;
  /** The repository's size on disk. */
  size(): Promise<Result<{ bytes: number }>>;
  restore(snapshotId: string, target: string, signal?: AbortSignal): Promise<Result>;
}

export const KEEP = ['--keep-weekly', '4', '--keep-monthly', '6'];

/** The pull's own refusal (server-pull/), which ssh passes through on stderr. */
const PULL_PROBLEM = /\{"format":1,"ok":false,"problem":"([^"\\]{1,200})"\}/;

/** What a failed restic said, in words Kamaji can store: never its stderr as such. */
export function problem(code: number | null, stderr: string): string {
  const pull = PULL_PROBLEM.exec(stderr);
  if (pull) return `craftish: ${pull[1]}`;
  // restic's documented exit codes (fixtures/README.md).
  switch (code) {
    case 3:
      return 'restic couldn’t read all of the source data';
    case 10:
      return 'the restic repository isn’t there';
    case 11:
      return 'the restic repository is locked by another restic';
    case 12:
      return 'the restic repository’s password is wrong';
    case 130:
      return 'restic was cancelled';
    case null:
      return 'restic didn’t finish';
    default:
      return `restic failed (exit ${code})`;
  }
}

const Summary = z.object({
  message_type: z.literal('summary'),
  snapshot_id: z.string().regex(/^[0-9a-f]{64}$/),
  total_bytes_processed: z.number().int(),
  data_added: z.number().int(),
});

/** `backup --json`'s summary line: the last line, after any status lines. */
export function parseBackup(stdout: string) {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const summary = Summary.safeParse(JSON.parse(line));
      if (summary.success) return summary.data;
    } catch {
      // A status line cut short, or not JSON: keep looking.
    }
  }
  return null;
}

const Snapshots = z.array(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), time: z.string() }));
export function parseSnapshots(stdout: string): string[] | null {
  try {
    const parsed = Snapshots.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.map((s) => s.id) : null;
  } catch {
    return null;
  }
}

const Stats = z.object({ total_size: z.number().int() });
export function parseStats(stdout: string): number | null {
  try {
    const parsed = Stats.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.total_size : null;
  } catch {
    return null;
  }
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

const CAP = 4 * 1024 * 1024;

export function realRestic(bin: string): Restic {
  function run(
    args: string[],
    options: { signal?: AbortSignal | undefined; stdout?: (s: Readable) => Promise<unknown> } = {},
  ): Promise<Ran & { value?: unknown; unread?: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let stdout = '';
      let stderr = '';
      let value: unknown;
      let unread = false;
      let reading: Promise<unknown> = Promise.resolve();
      if (options.stdout) {
        reading = options.stdout(child.stdout).then(
          (v) => (value = v),
          () => {
            unread = true;
            child.stdout.resume();
          },
        );
      } else {
        child.stdout.on('data', (d: Buffer) => {
          if (stdout.length < CAP) stdout += d.toString('utf8');
        });
      }
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += d.toString('utf8');
      });
      child.on('error', () => resolve({ code: null, stdout, stderr }));
      child.on('close', (code) => {
        void reading.then(() => resolve({ code, stdout, stderr, value, unread }));
      });
    });
  }
  const plain = async (args: string[]): Promise<Result> => {
    const ran = await run(args);
    return ran.code === 0 ? { ok: true } : { ok: false, problem: problem(ran.code, ran.stderr) };
  };
  return {
    async backup(site, command, signal) {
      const ran = await run(
        [
          'backup',
          '--json',
          '--host',
          'craftish',
          '--tag',
          `site:${site}`,
          '--stdin-filename',
          `${site}.tar`,
          '--stdin-from-command',
          '--',
          ...command,
        ],
        { signal },
      );
      if (ran.code !== 0) return { ok: false, problem: problem(ran.code, ran.stderr) };
      const summary = parseBackup(ran.stdout);
      if (!summary) return { ok: false, problem: 'restic’s answer had no snapshot in it' };
      return {
        ok: true,
        snapshotId: summary.snapshot_id,
        bytes: summary.total_bytes_processed,
        added: summary.data_added,
      };
    },
    async dump(snapshotId, site, read, signal) {
      const ran = await run(['dump', snapshotId, `/${site}.tar`], { signal, stdout: read });
      if (ran.code !== 0) return { ok: false, problem: problem(ran.code, ran.stderr) };
      if (ran.unread) return { ok: false, problem: 'the snapshot couldn’t be read back' };
      return { ok: true, value: ran.value as Awaited<ReturnType<typeof read>> };
    },
    forget: (ids) => plain(['forget', ...ids]),
    keep: (site) => plain(['forget', '--tag', `site:${site}`, '--group-by', 'tags', ...KEEP]),
    async snapshots(site) {
      const ran = await run(['snapshots', '--json', '--tag', `site:${site}`]);
      if (ran.code !== 0) return { ok: false, problem: problem(ran.code, ran.stderr) };
      const ids = parseSnapshots(ran.stdout);
      return ids
        ? { ok: true, ids }
        : { ok: false, problem: 'restic’s snapshot list wasn’t readable' };
    },
    prune: () => plain(['prune']),
    check: () => plain(['check', '--read-data-subset', '5%']),
    async size() {
      const ran = await run(['stats', '--json', '--mode', 'raw-data']);
      if (ran.code !== 0) return { ok: false, problem: problem(ran.code, ran.stderr) };
      const bytes = parseStats(ran.stdout);
      return bytes === null
        ? { ok: false, problem: 'restic’s stats weren’t readable' }
        : { ok: true, bytes };
    },
    async restore(snapshotId, target, signal) {
      const ran = await run(['restore', snapshotId, '--target', target], { signal });
      return ran.code === 0 ? { ok: true } : { ok: false, problem: problem(ran.code, ran.stderr) };
    },
  };
}
