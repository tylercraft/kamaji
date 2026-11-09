// molcajete, read locally each cycle (calcifer explore/kamaji.md, "Servers"): its disks, SMART,
// macOS updates, Docker, Tailscale, uptime, Calcifer's LaunchAgents, repo-pull's log and the
// crash log. Kamaji recommends; nothing here changes the mini.
//
// Issues (normal ones wait for the digest):
// - urgent: an always-running job stopped, an external disk gone, a disk at 95%, SMART not
//   verified, Tailscale not running (each but SMART and the disk held two cycles first), and a new
//   crash group (./crashes.ts).
// - normal: a job's last run failed, a job installed but not loaded, a disk at 85%, an external
//   mounted read-only, Docker not answering or a container not running, Tailscale's own warnings,
//   a restart in the last day, repo-pull failing for half an hour, macOS updates waiting over a
//   week, and any reader that fails three cycles running.
import type { MacHealth, MacJob } from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { clearIssue, raiseIssue, type Severity } from '../issues.js';
import { localParts } from '../notify.js';
import { recordObservation } from '../observations.js';
import { readState, writeState } from '../state.js';
import { checkCrashes, type CrashFiles } from './crashes.js';
import { fullText, isSession, shortName } from './jobs.js';
import type { SoftwareUpdate } from './parse.js';
import {
  readMolcajete,
  readUpdates,
  run,
  files,
  type Files,
  type Reading,
  type Run,
} from './read.js';

export const SERVER_ID = 'molcajete';
export const HEALTH_STATE = 'molcajete-health';
const STATE = 'molcajete';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const UPDATES_EVERY = 6 * HOUR;
export const DISK_WARN = 85;
export const DISK_URGENT = 95;

export interface MacState {
  jobs: Record<string, { runs: number | null; lastRunAt: number | null }>;
  /** Cycles running that a condition has held, by issue kind. */
  streaks: Record<string, number>;
  bootedAt: number | null;
  restartedAt: number | null;
  updates: {
    checkedAt: number;
    items: SoftwareUpdate[];
    firstSeen: Record<string, number>;
  } | null;
  updatesTriedAt: number | null;
  /** softwareupdate tries that failed in a row. */
  updatesFailures: number;
}

const empty = (): MacState => ({
  jobs: {},
  streaks: {},
  bootedAt: null,
  restartedAt: null,
  updates: null,
  updatesTriedAt: null,
  updatesFailures: 0,
});

const iso = (ms: number) => new Date(ms).toISOString();
const key = (kind: string) => ({ resourceType: 'server', resourceId: SERVER_ID, kind }) as const;

function when(at: number, now: number): string {
  const a = localParts(at);
  return a.day === localParts(now).day ? a.time : `${a.day.slice(5).replace('-', '/')} ${a.time}`;
}

/** Works out the issues and the health to show, from one reading. Mutates `state`. */
export function judgeMolcajete(
  db: Db,
  at: number,
  reading: Reading,
  state: MacState,
): Omit<MacHealth, 'crashes'> {
  const seen = new Set<string>();
  const set = (kind: string, severity: Severity, summary: string, holdFor = 1) => {
    seen.add(kind);
    const streak = (state.streaks[kind] ?? 0) + 1;
    state.streaks[kind] = streak;
    if (streak >= holdFor) raiseIssue(db, at, { ...key(kind), severity, summary });
  };
  const ok = (kind: string, summary: string) => {
    delete state.streaks[kind];
    clearIssue(db, at, key(kind), summary);
  };
  /** Leaves a condition as it was: the reading said nothing about it. */
  const hold = (kind: string) => seen.add(kind);
  const unreadable = (part: string, problem: string | null) => {
    if (problem === null) ok(`unreadable:${part}`, `Kamaji can read molcajete’s ${part} again`);
    else
      set(`unreadable:${part}`, 'normal', `Kamaji can’t read molcajete’s ${part}: ${problem}`, 3);
  };

  // Jobs
  const jobs: MacJob[] = [];
  unreadable('LaunchAgents', reading.jobs ? null : 'launchctl didn’t answer');
  for (const j of reading.jobs ?? []) {
    const name = shortName(j.label);
    const p = j.printed;
    const prev = state.jobs[j.label];
    const runs = p?.runs ?? null;
    const lastRunAt =
      runs !== null && prev?.runs !== null && prev?.runs !== undefined && runs > prev.runs
        ? at
        : (prev?.lastRunAt ?? null);
    state.jobs[j.label] = { runs, lastRunAt };
    const lastExitCode = p ? p.lastExitCode : (j.listed?.status ?? null);
    const running = p?.running ?? false;

    let attention: string | null = null;
    const missing = `job-missing:${name}`;
    const stopped = `job-stopped:${name}`;
    const failed = `job-failed:${name}`;
    if (!p) {
      attention = 'Installed but not loaded';
      set(missing, 'normal', `molcajete: ${name} is installed but not loaded`);
    } else {
      ok(missing, `molcajete: ${name} is loaded again`);
    }
    if (p?.keepAlive && !running) {
      attention = 'Stopped';
      set(stopped, 'urgent', `molcajete: ${name} has stopped`, 2);
    } else if (p) {
      ok(stopped, `molcajete: ${name} is running again`);
    } else hold(stopped);
    const exitBad = lastExitCode !== null && lastExitCode !== 0;
    if (p && !p.keepAlive && !running && !isSession(j.label) && exitBad) {
      const how =
        lastExitCode < 0 ? `ended by signal ${-lastExitCode}` : `exit code ${lastExitCode}`;
      attention = `Last run failed (${how})`;
      set(failed, 'normal', `molcajete: ${name}’s last run failed (${how})`);
    } else if (p) {
      ok(failed, `molcajete: ${name} ran cleanly`);
    } else hold(failed);

    jobs.push({
      name,
      label: j.label,
      state: !p ? 'not-loaded' : running ? 'running' : 'idle',
      keepAlive: p?.keepAlive ?? false,
      schedule: p?.schedule ?? null,
      lastExitCode,
      runs,
      lastRunAt: lastRunAt === null ? null : iso(lastRunAt),
      fullText: fullText(j.label),
      attention,
    });
  }
  if (reading.jobs) {
    // A job whose plist was removed: its issues go with it.
    const names = new Set(jobs.map((j) => j.name));
    for (const label of Object.keys(state.jobs)) {
      if (!reading.jobs.some((j) => j.label === label)) delete state.jobs[label];
    }
    const open = db
      .prepare(
        `SELECT kind FROM issues WHERE resolved_at IS NULL AND resource_type = 'server'
         AND resource_id = ? AND kind LIKE 'job-%'`,
      )
      .all(SERVER_ID);
    for (const r of open) {
      const kind = String(r.kind);
      const name = kind.slice(kind.indexOf(':') + 1);
      if (!names.has(name)) ok(kind, `molcajete: ${name} was removed`);
    }
  }

  // Disks
  let diskProblem: string | null = null;
  const disks = reading.disks.map((d) => {
    const usedPercent = d.info
      ? Math.round(((d.info.sizeBytes - d.info.freeBytes) / Math.max(d.info.sizeBytes, 1)) * 100)
      : null;
    const unmounted = `unmounted:${d.name}`;
    const full = `disk:${d.name}`;
    const smart = `smart:${d.name}`;
    const readOnly = `read-only:${d.name}`;
    if (d.mounted === false) {
      set(unmounted, 'urgent', `${d.name} isn’t mounted on molcajete`, 2);
    } else if (d.mounted === true) {
      ok(unmounted, `${d.name} is mounted again`);
    } else {
      diskProblem = 'mount didn’t answer';
      hold(unmounted);
    }
    if (d.mounted && !d.info) diskProblem = `diskutil couldn’t read ${d.name}`;
    if (d.info && usedPercent !== null) {
      if (usedPercent >= DISK_WARN) {
        set(
          full,
          usedPercent >= DISK_URGENT ? 'urgent' : 'normal',
          `molcajete: ${d.name} is ${usedPercent}% full`,
        );
      } else ok(full, `${d.name} has space again`);
      const status = d.info.smart;
      if (status && status !== 'Verified' && status !== 'Not Supported') {
        set(smart, 'urgent', `${d.name}’s SMART status is “${status}”: back it up`);
      } else ok(smart, `${d.name}’s SMART status is verified`);
      if (d.external && !d.info.writable) {
        set(readOnly, 'normal', `${d.name} is mounted read-only on molcajete`);
      } else ok(readOnly, `${d.name} is writable again`);
    } else {
      hold(full);
      hold(smart);
      hold(readOnly);
    }
    return {
      name: d.name,
      mount: d.mount,
      mounted: d.mounted ?? false,
      usedPercent,
      availableBytes: d.info ? d.info.freeBytes : null,
      smart: d.info?.smart ?? null,
      writable: d.info ? d.info.writable : null,
    };
  });
  unreadable('disks', diskProblem);

  // Docker
  const docker = reading.docker;
  if ('problem' in docker && docker.problem === 'Docker’s command isn’t installed') {
    unreadable('Docker', docker.problem);
    hold('docker');
    hold('containers');
  } else {
    unreadable('Docker', null);
    if ('problem' in docker) {
      set('docker', 'normal', 'Docker isn’t answering on molcajete', 2);
      hold('containers');
    } else {
      ok('docker', 'Docker is answering again');
      const down = (docker.containers ?? []).filter((c) => !c.healthy).map((c) => c.name);
      if (docker.containers === null) hold('containers');
      else if (down.length > 0) {
        set(
          'containers',
          'normal',
          `molcajete: ${down.length === 1 ? 'a container isn’t' : `${down.length} containers aren’t`} running well (${down.join(', ')})`,
        );
      } else ok('containers', 'molcajete’s containers are running');
    }
  }

  // Tailscale
  const ts = reading.tailscale;
  if ('problem' in ts) {
    unreadable('Tailscale', ts.problem);
    hold('tailscale');
    hold('tailscale-health');
  } else {
    unreadable('Tailscale', null);
    if (ts.state !== 'Running') {
      set('tailscale', 'urgent', `Tailscale isn’t connected on molcajete (${ts.state})`, 2);
    } else ok('tailscale', 'Tailscale is connected on molcajete again');
    if (ts.health.length > 0) {
      set(
        'tailscale-health',
        'normal',
        `Tailscale reports ${ts.health.length === 1 ? 'a problem' : `${ts.health.length} problems`} on molcajete`,
      );
    } else ok('tailscale-health', 'Tailscale reports no problems on molcajete');
  }

  // Uptime. The shutdown cause isn't kept long enough to rely on, so a restart is "cause unknown".
  unreadable('boot time', reading.bootedAt === null ? 'sysctl didn’t answer' : null);
  if (reading.bootedAt !== null) {
    if (state.bootedAt !== null && reading.bootedAt > state.bootedAt + 60_000) {
      state.restartedAt = reading.bootedAt;
    }
    state.bootedAt = reading.bootedAt;
  }
  if (state.restartedAt !== null && at - state.restartedAt < DAY) {
    set(
      'restarted',
      'normal',
      `molcajete restarted at ${when(state.restartedAt, at)} (cause unknown)`,
    );
  } else ok('restarted', 'molcajete has been up a day');

  // repo-pull: a failure is logged every run, a run with nothing to pull logs nothing. So it's
  // failing now only while failures keep arriving, and it counts after half an hour of them.
  const rp = reading.repoPull;
  if ('problem' in rp) {
    unreadable('repo-pull log', rp.problem);
    hold('repo-pull');
  } else {
    unreadable('repo-pull log', null);
    const failing =
      rp.failingSince !== null &&
      at - rp.lastAt < 15 * 60_000 &&
      rp.lastAt - rp.failingSince >= 30 * 60_000;
    if (failing && rp.failingSince !== null) {
      set(
        'repo-pull',
        'normal',
        `Calcifer’s repo on molcajete hasn’t pulled since ${when(rp.failingSince, at)}`,
      );
    } else if (rp.failingSince === null || at - rp.lastAt >= 15 * 60_000) {
      ok('repo-pull', 'Calcifer’s repo on molcajete is pulling again');
    } else hold('repo-pull');
  }

  // macOS updates, checked a few times a day.
  // One failed try is often Apple's end; two in a row (12 hours) is worth a look.
  if (state.updatesFailures >= 2) {
    set(
      'unreadable:software updates',
      'normal',
      'Kamaji can’t read molcajete’s software updates: softwareupdate didn’t answer',
    );
  } else if (state.updatesFailures === 0) {
    ok('unreadable:software updates', 'Kamaji can read molcajete’s software updates again');
  } else hold('unreadable:software updates');
  const u = state.updates;
  if (u) {
    const old = u.items.filter((i) => at - (u.firstSeen[i.label] ?? at) >= 7 * DAY);
    if (old.length > 0) {
      set(
        'macos-updates',
        'normal',
        `molcajete: ${old.length === 1 ? 'an update has' : `${old.length} updates have`} waited over a week (${old.map((i) => i.title).join(', ')})`,
      );
    } else ok('macos-updates', 'molcajete’s updates are installed');
  } else hold('macos-updates');

  for (const kind of Object.keys(state.streaks)) if (!seen.has(kind)) delete state.streaks[kind];

  return {
    kind: 'local-mac',
    checkedAt: iso(at),
    bootedAt:
      reading.bootedAt === null
        ? { known: false, reason: 'Boot time couldn’t be read' }
        : { known: true, value: iso(reading.bootedAt) },
    disks,
    updates: u
      ? { known: true, value: { checkedAt: iso(u.checkedAt), items: u.items } }
      : {
          known: false,
          reason: state.updatesFailures > 0 ? 'softwareupdate didn’t answer' : 'Not checked yet',
        },
    docker:
      'problem' in docker
        ? { known: false, reason: docker.problem }
        : {
            known: true,
            value: {
              engine: docker.version.engine,
              desktop: docker.version.desktop,
              containers: docker.containers ?? [],
            },
          },
    tailscale: 'problem' in ts ? { known: false, reason: ts.problem } : { known: true, value: ts },
    repoPull:
      'problem' in rp
        ? { known: false, reason: rp.problem }
        : {
            known: true,
            value: {
              lastAt: iso(rp.lastAt),
              failingSince: rp.failingSince === null ? null : iso(rp.failingSince),
            },
          },
    jobs,
  };
}

export interface MolcajeteOptions {
  now: () => number;
  signal: AbortSignal;
  crashFiles: CrashFiles;
  exec?: Run;
  fs?: Files;
  repoPullLog?: string;
}

/** Reads molcajete once and records what it found. */
export async function checkMolcajete(db: Db, options: MolcajeteOptions): Promise<void> {
  const exec = options.exec ?? run;
  const fs = options.fs ?? files;
  const { signal } = options;
  const reading = await readMolcajete({ exec, fs, signal, repoPullLog: options.repoPullLog });
  const state = { ...empty(), ...readState<MacState>(db, STATE) };

  if (state.updatesTriedAt === null || options.now() - state.updatesTriedAt >= UPDATES_EVERY) {
    const items = await readUpdates(exec, signal);
    const at = options.now();
    state.updatesTriedAt = at;
    if (items) {
      const firstSeen: Record<string, number> = {};
      for (const i of items) firstSeen[i.label] = state.updates?.firstSeen[i.label] ?? at;
      state.updates = { checkedAt: at, items, firstSeen };
      state.updatesFailures = 0;
    } else state.updatesFailures++;
  }
  if (signal.aborted) throw signal.reason;

  const at = options.now();
  transaction(db, () => {
    const health = judgeMolcajete(db, at, reading, state);
    writeState(db, STATE, state, at);
    writeState(db, HEALTH_STATE, health, at);
    const needs = health.jobs.filter((j) => j.attention).map((j) => j.name);
    recordObservation(db, {
      resourceType: 'server',
      resourceId: SERVER_ID,
      check: 'local',
      source: 'mini',
      at,
      ok: needs.length === 0,
      // A compact record of each cycle; the full reading is in state.
      value: {
        disks: health.disks.map((d) => [d.name, d.usedPercent, d.mounted, d.smart]),
        tailscale: health.tailscale.known ? health.tailscale.value.state : null,
        docker: health.docker.known
          ? health.docker.value.containers.filter((c) => c.healthy).length
          : null,
        bootedAt: reading.bootedAt,
        needs,
      },
    });
    checkCrashes(db, at, options.crashFiles);
  });
}
