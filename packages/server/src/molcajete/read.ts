// Runs molcajete's own tools, read-only, and hands their output to ./parse.ts. Full paths, a
// plain PATH, and a timeout on everything. A tool that fails gives null for its part, never a
// guess. Log files are opened only for allowlisted jobs (./jobs.ts).
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { cpus, homedir, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  busiest,
  describeCalendar,
  parseBoottime,
  parseCalendar,
  parseDiskutil,
  parseDockerPs,
  parseDockerStats,
  parseDockerVersion,
  parseLaunchctlList,
  parseLaunchctlPrint,
  parseMount,
  parsePs,
  parseRepoPull,
  parseSoftwareUpdate,
  parseTailscale,
  parseVmStat,
  type BusyContainer,
  type BusyProcess,
  type Container,
  type DiskInfo,
  type DockerVersion,
  type ListedJob,
  type PrintedJob,
  type RepoPull,
  type SoftwareUpdate,
  type TailscaleStatus,
  type VmStat,
} from './parse.js';

export const TOOLS = {
  launchctl: '/bin/launchctl',
  diskutil: '/usr/sbin/diskutil',
  mount: '/sbin/mount',
  softwareupdate: '/usr/sbin/softwareupdate',
  sysctl: '/usr/sbin/sysctl',
  plutil: '/usr/bin/plutil',
  ps: '/bin/ps',
  vmStat: '/usr/bin/vm_stat',
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
  options: {
    timeoutMs: number;
    signal: AbortSignal;
    /** Added to the plain environment for this one tool. Never a secret. */
    env?: Record<string, string>;
  },
) => Promise<RunResult>;

/** The whole environment a tool gets: no Doppler secrets reach a child. */
export const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() };

/** Runs a tool; never throws. code is null when it couldn't run or ran out of time. */
export const run: Run = (file, args, { timeoutMs, signal, env }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: { ...BASE_ENV, ...env },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' && !error.killed ? error.code : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** Why a tool failed, for the Servers page: what failed, its exit code, stderr's first line. */
export function failure(what: string, r: RunResult): string {
  const how = r.code === null ? 'didn’t finish' : `exit ${r.code}`;
  const line = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ? `${what} (${how}: ${line.slice(0, 200)})` : `${what} (${how})`;
}

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
  /** Why it couldn't be read, or null. */
  problem: string | null;
}

export interface Reading {
  jobs: JobReading[] | { problem: string };
  disks: DiskReading[];
  docker:
    | { version: DockerVersion; containers: Container[] | null }
    | { problem: string; installed: boolean };
  tailscale: TailscaleStatus | { problem: string };
  bootedAt: number | { problem: string };
  repoPull: RepoPull | { problem: string };
  load: LoadReading;
}

/** The load and memory Node reads from the kernel itself; tests stand in for it. */
export interface System {
  /** 1, 5 and 15 minutes. */
  loadavg: () => number[];
  cpus: () => number;
  totalmem: () => number;
}
export const system: System = { loadavg, cpus: () => cpus().length, totalmem };

/** Overloaded above this many times the core count (5-minute load); calm again below 1×. */
export const LOAD_HIGH = 1.5;
export const LOAD_CALM = 1;
/** Between ps's two reads: what each process used in this time is its CPU. */
export const PS_GAP_MS = 2_000;

export interface LoadReading {
  one: number;
  five: number;
  fifteen: number;
  cpus: number;
  totalBytes: number;
  memory: VmStat | { problem: string };
  /** Only read while the load is high; null otherwise, or when ps couldn't be read. */
  busiest: BusyProcess[] | null;
  /** Only read when Docker's VM is the busiest process; null otherwise, or without Docker. */
  containers: BusyContainer[] | null;
}

/** Docker Desktop's VM, as ps names it: its containers' CPU is all counted to it. */
export const isDockerVm = (name: string) => name.startsWith('com.apple.Virtualization');

export async function readLoad(
  exec: Run,
  fs: Files,
  sys: System,
  signal: AbortSignal,
  wait: (ms: number) => Promise<void>,
): Promise<LoadReading> {
  const [one = 0, five = 0, fifteen = 0] = sys.loadavg();
  const cores = Math.max(sys.cpus(), 1);
  const vm = await exec(TOOLS.vmStat, [], { timeoutMs: 10_000, signal });
  const memory = (vm.code === 0 ? parseVmStat(vm.stdout) : null) ?? {
    problem: failure('vm_stat failed', vm),
  };
  const reading: LoadReading = {
    one,
    five,
    fifteen,
    cpus: cores,
    totalBytes: sys.totalmem(),
    memory,
    busiest: null,
    containers: null,
  };
  if (five <= cores * LOAD_HIGH) return reading;

  // Two reads of each process's CPU time, apart: ps's own %CPU is a decaying average.
  const ps = () => exec(TOOLS.ps, ['-Ao', 'pid,cputime,rss,comm'], { timeoutMs: 15_000, signal });
  const first = await ps();
  const started = Date.now();
  await wait(PS_GAP_MS);
  const second = await ps();
  const seconds = Math.max((Date.now() - started) / 1000, PS_GAP_MS / 1000);
  const before = first.code === 0 ? parsePs(first.stdout) : null;
  const after = second.code === 0 ? parsePs(second.stdout) : null;
  if (!before || !after) return reading;
  reading.busiest = busiest(before, after, seconds);

  // Docker's VM at the top says only "Docker"; its containers say which one. Names and
  // numbers only: never docker inspect, never a container's environment.
  if (reading.busiest[0] && isDockerVm(reading.busiest[0].name) && fs.exists(TOOLS.docker)) {
    const stats = await exec(TOOLS.docker, ['stats', '--no-stream', '--format', 'json'], {
      timeoutMs: 30_000,
      signal,
    });
    if (stats.code === 0) reading.containers = parseDockerStats(stats.stdout);
  }
  return reading;
}

const uid = () => process.getuid?.() ?? 501;

export async function readJobs(
  exec: Run,
  fs: Files,
  signal: AbortSignal,
): Promise<Reading['jobs']> {
  const list = await exec(TOOLS.launchctl, ['list'], { timeoutMs: 15_000, signal });
  if (list.code !== 0) return { problem: failure('launchctl list failed', list) };
  const listed = new Map(parseLaunchctlList(list.stdout).map((j) => [j.label, j]));
  const labels = [...new Set([...listed.keys(), ...fs.agentLabels()])].sort();
  const out: JobReading[] = [];
  for (const label of labels) {
    const printed = await exec(TOOLS.launchctl, ['print', `gui/${uid()}/${label}`], {
      timeoutMs: 10_000,
      signal,
    });
    const job = parseLaunchctlPrint(printed.stdout + printed.stderr);
    if (job?.schedule === 'on a calendar') {
      // Only this one key is read from the plist.
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      const r = await exec(
        TOOLS.plutil,
        ['-extract', 'StartCalendarInterval', 'json', '-o', '-', plist],
        { timeoutMs: 5_000, signal },
      );
      const entries = r.code === 0 ? parseCalendar(r.stdout) : null;
      if (entries && entries.length > 0) job.schedule = describeCalendar(entries);
    }
    out.push({ label, listed: listed.get(label) ?? null, printed: job });
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
    let problem = mounted === null ? failure('mount failed', mount) : null;
    if (mounted) {
      const r = await exec(TOOLS.diskutil, ['info', '-plist', disk.mount], {
        timeoutMs: 20_000,
        signal,
      });
      if (r.code !== 0) problem = failure(`diskutil couldn’t read ${disk.name}`, r);
      else {
        try {
          info = parseDiskutil(r.stdout);
        } catch {
          problem = `diskutil’s output for ${disk.name} wasn’t understood`;
        }
      }
    }
    out.push({ ...disk, mounted, info, problem });
  }
  return out;
}

/** Slow (it asks Apple), so the caller runs it a few times a day, not every cycle. */
export async function readUpdates(
  exec: Run,
  signal: AbortSignal,
): Promise<SoftwareUpdate[] | { problem: string }> {
  const r = await exec(TOOLS.softwareupdate, ['--list'], { timeoutMs: 180_000, signal });
  return (
    parseSoftwareUpdate(r.stdout + r.stderr, r.code) ?? {
      problem: failure('softwareupdate failed', r),
    }
  );
}

export async function readDocker(
  exec: Run,
  fs: Files,
  signal: AbortSignal,
): Promise<Reading['docker']> {
  if (!fs.exists(TOOLS.docker)) {
    return { problem: 'Docker’s command isn’t installed', installed: false };
  }
  const v = await exec(TOOLS.docker, ['version', '--format', 'json'], {
    timeoutMs: 20_000,
    signal,
  });
  const version = parseDockerVersion(v.stdout);
  if (!version) return { problem: failure('Docker isn’t answering', v), installed: true };
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
  // Without a GUI session's environment the app's binary tries to start its GUI; this makes it
  // act as the CLI (checked on the mini, 2026-11-09).
  const r = await exec(TOOLS.tailscale, ['status', '--json'], {
    timeoutMs: 15_000,
    signal,
    env: { TAILSCALE_BE_CLI: '1' },
  });
  return parseTailscale(r.stdout) ?? { problem: failure('Tailscale’s status couldn’t be read', r) };
}

export async function readBoottime(exec: Run, signal: AbortSignal): Promise<Reading['bootedAt']> {
  const r = await exec(TOOLS.sysctl, ['-n', 'kern.boottime'], { timeoutMs: 5_000, signal });
  const at = r.code === 0 ? parseBoottime(r.stdout) : null;
  return at ?? { problem: failure('sysctl kern.boottime failed', r) };
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
  system?: System | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  signal: AbortSignal;
  repoPullLog?: string | undefined;
}): Promise<Reading> {
  const exec = options.exec ?? run;
  const fs = options.fs ?? files;
  const { signal } = options;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const [jobs, disks, docker, tailscale, bootedAt, load] = await Promise.all([
    readJobs(exec, fs, signal),
    readDisks(exec, signal),
    readDocker(exec, fs, signal),
    readTailscale(exec, fs, signal),
    readBoottime(exec, signal),
    readLoad(exec, fs, options.system ?? system, signal, wait),
  ]);
  return {
    jobs,
    disks,
    docker,
    tailscale,
    bootedAt,
    repoPull: readRepoPull(fs, options.repoPullLog),
    load,
  };
}
