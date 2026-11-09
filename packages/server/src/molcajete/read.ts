// Runs molcajete's own tools, read-only, and hands their output to ./parse.ts. Full paths, a
// plain PATH, and a timeout on everything. A tool that fails gives null for its part, never a
// guess. Log files are opened only for allowlisted jobs (./jobs.ts).
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseBoottime,
  parseDiskutil,
  parseDockerPs,
  parseDockerVersion,
  parseLaunchctlList,
  parseLaunchctlPrint,
  parseMount,
  parseRepoPull,
  parseSoftwareUpdate,
  parseTailscale,
  type Container,
  type DiskInfo,
  type DockerVersion,
  type ListedJob,
  type PrintedJob,
  type RepoPull,
  type SoftwareUpdate,
  type TailscaleStatus,
} from './parse.js';

export const TOOLS = {
  launchctl: '/bin/launchctl',
  diskutil: '/usr/sbin/diskutil',
  mount: '/sbin/mount',
  softwareupdate: '/usr/sbin/softwareupdate',
  sysctl: '/usr/sbin/sysctl',
  // Docker Desktop's CLI link and the Tailscale app's own CLI, as calcifer's scripts call them
  // (ops/molcajete/mini-status.py, inbox-mover.sh).
  docker: '/usr/local/bin/docker',
  tailscale: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
};

/** The disks Kamaji watches: the internal drive and the two externals. */
export const DISKS = [
  { name: 'Internal', mount: '/', external: false },
  { name: 'Respaldo', mount: '/Volumes/Respaldo', external: true },
  { name: 'Palomitas', mount: '/Volumes/Palomitas', external: true },
] as const;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Run = (
  file: string,
  args: string[],
  options: { timeoutMs: number; signal: AbortSignal },
) => Promise<RunResult>;

/** Runs a tool; never throws. code is null when it couldn't run or ran out of time. */
export const run: Run = (file, args, { timeoutMs, signal }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' && !error.killed ? error.code : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export interface Files {
  exists: (path: string) => boolean;
  /** Lists ~/Library/LaunchAgents: names only, the plists aren't opened. */
  agentLabels: () => string[];
  /** The last bytes of a log, or null when it can't be read. Only called for allowlisted jobs. */
  tail: (path: string, bytes: number) => string | null;
}

export const files: Files = {
  exists: existsSync,
  agentLabels: () => {
    try {
      return readdirSync(join(homedir(), 'Library', 'LaunchAgents'))
        .filter((f) => f.startsWith('dev.craftish.') && f.endsWith('.plist'))
        .map((f) => f.slice(0, -'.plist'.length));
    } catch {
      return [];
    }
  },
  tail: (path, bytes) => {
    try {
      const size = statSync(path).size;
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, length, size - length);
      } finally {
        closeSync(fd);
      }
      const text = buffer.toString('utf8');
      // Start on a whole line when the tail was cut.
      return length < size ? text.slice(text.indexOf('\n') + 1) : text;
    } catch {
      return null;
    }
  },
};

export interface JobReading {
  label: string;
  listed: ListedJob | null;
  /** null when it isn't loaded. */
  printed: PrintedJob | null;
}

export interface DiskReading {
  name: string;
  mount: string;
  external: boolean;
  /** null when `mount` couldn't be read. */
  mounted: boolean | null;
  info: DiskInfo | null;
}

export interface Reading {
  jobs: JobReading[] | null;
  disks: DiskReading[];
  docker: { version: DockerVersion; containers: Container[] | null } | { problem: string };
  tailscale: TailscaleStatus | { problem: string };
  bootedAt: number | null;
  repoPull: RepoPull | { problem: string };
}

const uid = () => process.getuid?.() ?? 501;

export async function readJobs(
  exec: Run,
  fs: Files,
  signal: AbortSignal,
): Promise<JobReading[] | null> {
  const list = await exec(TOOLS.launchctl, ['list'], { timeoutMs: 15_000, signal });
  if (list.code !== 0) return null;
  const listed = new Map(parseLaunchctlList(list.stdout).map((j) => [j.label, j]));
  const labels = [...new Set([...listed.keys(), ...fs.agentLabels()])].sort();
  const out: JobReading[] = [];
  for (const label of labels) {
    const printed = await exec(TOOLS.launchctl, ['print', `gui/${uid()}/${label}`], {
      timeoutMs: 10_000,
      signal,
    });
    out.push({
      label,
      listed: listed.get(label) ?? null,
      printed: parseLaunchctlPrint(printed.stdout + printed.stderr),
    });
  }
  return out;
}

export async function readDisks(exec: Run, signal: AbortSignal): Promise<DiskReading[]> {
  const mount = await exec(TOOLS.mount, [], { timeoutMs: 10_000, signal });
  const mounts = mount.code === 0 ? parseMount(mount.stdout) : null;
  const out: DiskReading[] = [];
  for (const disk of DISKS) {
    const mounted = disk.mount === '/' ? true : mounts ? mounts.has(disk.mount) : null;
    let info: DiskInfo | null = null;
    if (mounted) {
      const r = await exec(TOOLS.diskutil, ['info', '-plist', disk.mount], {
        timeoutMs: 20_000,
        signal,
      });
      try {
        info = r.code === 0 ? parseDiskutil(r.stdout) : null;
      } catch {
        info = null;
      }
    }
    out.push({ ...disk, mounted, info });
  }
  return out;
}

/** Slow (it asks Apple), so the caller runs it a few times a day, not every cycle. */
export async function readUpdates(
  exec: Run,
  signal: AbortSignal,
): Promise<SoftwareUpdate[] | null> {
  const r = await exec(TOOLS.softwareupdate, ['--list'], { timeoutMs: 180_000, signal });
  return parseSoftwareUpdate(r.stdout + r.stderr, r.code);
}

export async function readDocker(
  exec: Run,
  fs: Files,
  signal: AbortSignal,
): Promise<Reading['docker']> {
  if (!fs.exists(TOOLS.docker)) return { problem: 'Docker’s command isn’t installed' };
  const v = await exec(TOOLS.docker, ['version', '--format', 'json'], {
    timeoutMs: 20_000,
    signal,
  });
  const version = parseDockerVersion(v.stdout);
  if (!version) return { problem: 'Docker isn’t answering' };
  const ps = await exec(TOOLS.docker, ['ps', '--all', '--format', 'json'], {
    timeoutMs: 20_000,
    signal,
  });
  return { version, containers: ps.code === 0 ? parseDockerPs(ps.stdout) : null };
}

export async function readTailscale(
  exec: Run,
  fs: Files,
  signal: AbortSignal,
): Promise<Reading['tailscale']> {
  if (!fs.exists(TOOLS.tailscale)) return { problem: 'Tailscale’s app isn’t installed' };
  const r = await exec(TOOLS.tailscale, ['status', '--json'], { timeoutMs: 15_000, signal });
  return parseTailscale(r.stdout) ?? { problem: 'Tailscale’s status couldn’t be read' };
}

export async function readBoottime(exec: Run, signal: AbortSignal): Promise<number | null> {
  const r = await exec(TOOLS.sysctl, ['-n', 'kern.boottime'], { timeoutMs: 5_000, signal });
  return r.code === 0 ? parseBoottime(r.stdout) : null;
}

export const REPO_PULL_LOG = join(homedir(), 'Library', 'Logs', 'calcifer-repo-pull.log');

export function readRepoPull(fs: Files, path = REPO_PULL_LOG): Reading['repoPull'] {
  const text = fs.tail(path, 64 * 1024);
  if (text === null) return { problem: 'repo-pull’s log couldn’t be read' };
  return parseRepoPull(text) ?? { problem: 'repo-pull hasn’t logged anything yet' };
}

/** Everything but software updates, in one pass. */
export async function readMolcajete(options: {
  exec?: Run;
  fs?: Files;
  signal: AbortSignal;
  repoPullLog?: string | undefined;
}): Promise<Reading> {
  const exec = options.exec ?? run;
  const fs = options.fs ?? files;
  const { signal } = options;
  const [jobs, disks, docker, tailscale, bootedAt] = await Promise.all([
    readJobs(exec, fs, signal),
    readDisks(exec, signal),
    readDocker(exec, fs, signal),
    readTailscale(exec, fs, signal),
    readBoottime(exec, signal),
  ]);
  return {
    jobs,
    disks,
    docker,
    tailscale,
    bootedAt,
    repoPull: readRepoPull(fs, options.repoPullLog),
  };
}
