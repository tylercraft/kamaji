// Parsers for what molcajete's own tools print. Each one is written against a capture in
// ./fixtures (calcifer explore/kamaji/fixtures, 2026-11-09) and tested on it; a format with no
// capture isn't guessed at. Pure functions: the commands are run in ./read.ts.
import { z } from 'zod';
import { parsePlist, type PlistValue } from './plist.js';

// launchd

export interface ListedJob {
  label: string;
  pid: number | null;
  /** The last exit status launchd keeps; negative is the signal that ended it. */
  status: number;
}

/** `launchctl list`, Kamaji's and Calcifer's jobs only (labels starting dev.craftish.). */
export function parseLaunchctlList(text: string): ListedJob[] {
  const out: ListedJob[] = [];
  for (const line of text.split('\n')) {
    const [pid, status, label] = line.split('\t');
    if (!label || !label.startsWith('dev.craftish.')) continue;
    out.push({
      label: label.trim(),
      pid: pid === '-' ? null : Number(pid),
      status: Number(status),
    });
  }
  return out;
}

export interface PrintedJob {
  running: boolean;
  pid: number | null;
  /** null when it has never exited (still on its first run). */
  lastExitCode: number | null;
  runs: number | null;
  keepAlive: boolean;
  /** In plain words, or null when launchd shows no schedule. */
  schedule: string | null;
  stdoutPath: string | null;
}

/** `launchctl print gui/501/<label>`, or null when the job isn't loaded. */
export function parseLaunchctlPrint(text: string): PrintedJob | null {
  if (/Could not find service/.test(text)) return null;
  // Top-level fields sit one tab in; nested blocks (coalitions, triggers) sit deeper.
  const top = new Map<string, string>();
  for (const m of text.matchAll(/^\t([a-z][a-z ()]*?) = (.*)$/gm)) {
    if (m[1] && m[2] !== undefined && !top.has(m[1])) top.set(m[1], m[2].trim());
  }
  const int = (key: string) => {
    const v = top.get(key);
    return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
  };
  const keepAlive = /\bkeepalive\b/.test(top.get('properties') ?? '');
  return {
    running: top.get('state') === 'running',
    pid: int('pid'),
    lastExitCode: int('last exit code'),
    runs: int('runs'),
    keepAlive,
    schedule: schedule(text, top, keepAlive),
    stdoutPath: top.get('stdout path') ?? null,
  };
}

function schedule(text: string, top: Map<string, string>, keepAlive: boolean): string | null {
  if (keepAlive) return 'always running';
  const interval = /^(\d+) seconds$/.exec(top.get('run interval') ?? '');
  if (interval) {
    const n = Number(interval[1]);
    return n % 3600 === 0 ? `every ${n / 3600} h` : `every ${Math.round(n / 60)} min`;
  }
  if (text.includes('com.apple.launchd.calendarinterval')) {
    const hour = /"Hour" => (\d+)/.exec(text)?.[1];
    const minute = /"Minute" => (\d+)/.exec(text)?.[1];
    const at = `${(hour ?? '0').padStart(2, '0')}:${(minute ?? '0').padStart(2, '0')}`;
    return /"Weekday" =>/.test(text) ? `weekly, ${at}` : `daily, ${at}`;
  }
  if (text.includes('"WatchPaths"')) return 'when its folders change';
  return null;
}

// Disks

export interface DiskInfo {
  name: string;
  mount: string;
  sizeBytes: number;
  freeBytes: number;
  /** diskutil's SMARTStatus ("Verified", "Failing", "Not Supported"), or null if it gives none. */
  smart: string | null;
  writable: boolean;
}

/**
 * `diskutil info -plist <mount>`. Space is the APFS container's: the root volume is a sealed
 * snapshot whose own numbers are tiny, and every volume in a container shares its free space.
 */
export function parseDiskutil(xml: string): DiskInfo {
  const p = parsePlist(xml);
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error('diskutil: not a dict');
  const num = (v: PlistValue | undefined) => (typeof v === 'number' ? v : null);
  const str = (v: PlistValue | undefined) => (typeof v === 'string' ? v : null);
  const sizeBytes = num(p.APFSContainerSize) ?? num(p.TotalSize) ?? 0;
  const freeBytes = num(p.APFSContainerFree) ?? num(p.FreeSpace) ?? 0;
  return {
    name: str(p.VolumeName) ?? '',
    mount: str(p.MountPoint) ?? '',
    sizeBytes,
    freeBytes,
    smart: str(p.SMARTStatus),
    writable: p.WritableVolume === true,
  };
}

/** The mount points in `mount`'s output. */
export function parseMount(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^.+? on (.+) \([^)]*\)$/gm)) if (m[1]) out.add(m[1]);
  return out;
}

// Software updates

export interface SoftwareUpdate {
  label: string;
  title: string;
  restart: boolean;
}

/**
 * `softwareupdate --list` (stdout and stderr together). Null when it couldn't check. With
 * nothing pending it exits non-zero and says "No new software available" (as mini-status.py
 * reads it), so that's an empty list, not a failure.
 */
export function parseSoftwareUpdate(text: string, code: number | null): SoftwareUpdate[] | null {
  if (code === null || (code !== 0 && !/No new software/.test(text))) return null;
  const out: SoftwareUpdate[] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const label = /^\s*\*\s*Label:\s*(.+?)\s*$/.exec(line)?.[1];
    if (!label) continue;
    const details = lines[i + 1] ?? '';
    out.push({
      label,
      title: /Title:\s*([^,]+)/.exec(details)?.[1]?.trim() ?? label,
      restart: /Action:\s*restart/i.test(details),
    });
  }
  return out;
}

// Docker

export interface DockerVersion {
  engine: string;
  desktop: string | null;
}

/** `docker version --format json`. Null when the engine didn't answer. */
export function parseDockerVersion(json: string): DockerVersion | null {
  const v = z
    .object({
      Server: z
        .object({ Version: z.string(), Platform: z.object({ Name: z.string() }).optional() })
        .nullish(),
    })
    .safeParse(safeJson(json));
  const server = v.success ? v.data.Server : null;
  if (!server) return null;
  return { engine: server.Version, desktop: server.Platform?.Name ?? null };
}

export interface Container {
  name: string;
  image: string;
  state: string;
  status: string;
  healthy: boolean;
}

const DockerPsLine = z.object({
  Names: z.string(),
  Image: z.string(),
  State: z.string(),
  Status: z.string(),
  HealthStatus: z.string().optional(),
});

/** `docker ps --all --format json`, one object a line. A running container can still be unwell. */
export function parseDockerPs(text: string): Container[] {
  const out: Container[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const c = DockerPsLine.safeParse(safeJson(line));
    if (!c.success) continue;
    const { Names, Image, State, Status, HealthStatus } = c.data;
    out.push({
      name: Names,
      image: Image,
      state: State,
      status: Status,
      healthy:
        State === 'running' &&
        HealthStatus !== 'unhealthy' &&
        HealthStatus !== 'starting' &&
        !/\((unhealthy|health: starting)\)/.test(Status),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Tailscale

export interface TailscaleStatus {
  state: string;
  online: boolean;
  /** Tailscale's own health warnings; empty when all is well. */
  health: string[];
  version: string;
}

/** `Tailscale status --json`. Peers aren't kept: only this node's own state. */
export function parseTailscale(json: string): TailscaleStatus | null {
  const v = z
    .object({
      Version: z.string(),
      BackendState: z.string(),
      Self: z.object({ Online: z.boolean() }).nullish(),
      Health: z.array(z.string()).nullish(),
    })
    .safeParse(safeJson(json));
  if (!v.success) return null;
  return {
    state: v.data.BackendState,
    online: v.data.Self?.Online ?? false,
    health: v.data.Health ?? [],
    version: v.data.Version.split('-')[0] ?? v.data.Version,
  };
}

// Boot time

/** `sysctl -n kern.boottime`, as epoch ms. */
export function parseBoottime(text: string): number | null {
  const m = /sec = (\d+), usec = (\d+)/.exec(text);
  return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
}

// repo-pull's log

export interface RepoPull {
  /** The newest line's time. */
  lastAt: number;
  /** When the current run of failures began, or null if the newest line isn't a failure. */
  failingSince: number | null;
}

/**
 * calcifer's repo-pull.sh logs only what happened (a pull, a rebase) or why it couldn't, with
 * a local timestamp; a run with nothing to pull writes nothing. Git's own error lines, untimed,
 * come before its "can't reach the remote" line and are skipped. Every line that isn't a pull or
 * a rebase is a run that didn't bring the repo up to date.
 */
export function parseRepoPull(text: string): RepoPull | null {
  const lines: { at: number; ok: boolean }[] = [];
  for (const m of text.matchAll(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) (.*)$/gm)) {
    const [, y, mo, d, h, mi, s, rest] = m;
    lines.push({
      at: fromLocal(+y!, +mo!, +d!, +h!, +mi!, +s!),
      ok: /^(pulled|rebased) /.test(rest ?? ''),
    });
  }
  const last = lines.at(-1);
  if (!last) return null;
  let failingSince: number | null = null;
  for (let i = lines.length - 1; i >= 0 && !lines[i]!.ok; i--) failingSince = lines[i]!.at;
  return { lastAt: last.at, failingSince };
}

const TIME_ZONE = 'Pacific/Auckland';

/** A wall-clock time in Christchurch, as epoch ms. */
export function fromLocal(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (at: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(at))
        .map((p) => [p.type, Number(p.value)]),
    ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
    return (
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at
    );
  };
  const guess = wall - offset(wall);
  return wall - offset(guess);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
