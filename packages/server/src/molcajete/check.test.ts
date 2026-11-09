import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacHealth } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { readState } from '../state.js';
import { testDb } from '../testing.js';
import { checkMolcajete, HEALTH_STATE, SERVER_ID, UPDATES_EVERY } from './check.js';
import { parseLaunchctlList } from './parse.js';
import { TOOLS, type Files, type Run } from './read.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 9, 0, 0); // 13:00 on the 9th in Christchurch
const LABELS = parseLaunchctlList(fixture('launchctl-list.txt')).map((j) => j.label);

interface Mini {
  prints: Record<string, string>;
  mount: string;
  boottime: string;
  repoPull: string;
  softwareupdate: { code: number | null; text: string };
  tailscale: string;
  dockerVersion: string;
  /** Labels with a plist in ~/Library/LaunchAgents. */
  plists: string[];
  tails: string[];
  /** StartCalendarInterval as plutil prints it, by label. */
  calendars: Record<string, string>;
  /** Tools that fail, by path. */
  fail: Record<string, { code: number | null; stderr: string }>;
  /** The extra environment each call asked for, by tool path. */
  envs: [string, Record<string, string> | undefined][];
}

function mini(): Mini {
  return {
    prints: {
      'dev.craftish.calcifer.dashboard': fixture('launchctl-print-dashboard.txt'),
      'dev.craftish.calcifer.outbox': fixture('launchctl-print-outbox.txt'),
    },
    mount: fixture('mount.txt'),
    boottime: fixture('boottime.txt'),
    repoPull: fixture('repo-pull.log'),
    softwareupdate: { code: 0, text: fixture('softwareupdate-list.txt') },
    tailscale: fixture('tailscale-status.json'),
    dockerVersion: fixture('docker-version.json'),
    plists: LABELS,
    tails: [],
    calendars: {},
    fail: {},
    envs: [],
  };
}

function fake(m: Mini): { exec: Run; fs: Files } {
  const out = (stdout: string, code: number | null = 0) =>
    Promise.resolve({ code, stdout, stderr: '' });
  const exec: Run = (file, args, options) => {
    m.envs.push([file, options.env]);
    const failing = m.fail[file];
    if (failing) return Promise.resolve({ code: failing.code, stdout: '', stderr: failing.stderr });
    if (file === TOOLS.launchctl && args[0] === 'list') return out(fixture('launchctl-list.txt'));
    if (file === TOOLS.launchctl && args[0] === 'print') {
      const label = String(args[1]).split('/').pop() ?? '';
      if (!LABELS.includes(label)) return out(fixture('launchctl-print-not-loaded.txt'), 113);
      return out(m.prints[label] ?? fixture('launchctl-print-today.txt'));
    }
    if (file === TOOLS.plutil) {
      const label = String(args.at(-1))
        .split('/')
        .pop()!
        .replace(/\.plist$/, '');
      const json = m.calendars[label];
      return json ? out(json) : out('', 1);
    }
    if (file === TOOLS.mount) return out(m.mount);
    if (file === TOOLS.diskutil) {
      const name =
        String(args[2]) === '/' ? 'root' : String(args[2]).split('/').pop()!.toLowerCase();
      return out(fixture(`diskutil-${name}.plist`));
    }
    if (file === TOOLS.softwareupdate) return out(m.softwareupdate.text, m.softwareupdate.code);
    if (file === TOOLS.docker && args[0] === 'version') return out(m.dockerVersion);
    if (file === TOOLS.docker && args[0] === 'ps') return out(fixture('docker-ps.jsonl'));
    if (file === TOOLS.tailscale) return out(m.tailscale);
    if (file === TOOLS.sysctl) return out(m.boottime);
    return out('', 1);
  };
  const fs: Files = {
    exists: () => true,
    agentLabels: () => m.plists,
    tail: (path) => {
      m.tails.push(path);
      return path.endsWith('calcifer-repo-pull.log') ? m.repoPull : null;
    },
  };
  return { exec, fs };
}

const crashFiles = () => ({ path: join(mkdtempSync(join(tmpdir(), 'kamaji-')), 'crashes.jsonl') });

async function cycle(db: Db, m: Mini, at: number, files = crashFiles()) {
  const { exec, fs } = fake(m);
  await checkMolcajete(db, {
    now: () => at,
    signal: new AbortController().signal,
    crashFiles: files,
    exec,
    fs,
    repoPullLog: '/logs/calcifer-repo-pull.log',
  });
}

const openIssues = (db: Db) =>
  db
    .prepare(
      `SELECT kind, severity, summary FROM issues WHERE resolved_at IS NULL AND resource_id = ?
       ORDER BY kind`,
    )
    .all(SERVER_ID)
    .map((r) => ({
      kind: String(r.kind),
      severity: String(r.severity),
      summary: String(r.summary),
    }));

const health = (db: Db) => readState<Omit<MacHealth, 'crashes'>>(db, HEALTH_STATE)!;

describe('molcajete', () => {
  it('reads the captured mini as healthy', async () => {
    const db = testDb();
    await cycle(db, mini(), T0);
    expect(openIssues(db)).toEqual([]);
    const h = health(db);
    expect(h.disks.map((d) => [d.name, d.mounted, d.usedPercent, d.smart])).toEqual([
      ['Internal', true, 60, 'Verified'],
      ['Respaldo', true, 15, 'Verified'],
      ['Palomitas', true, 52, 'Verified'],
    ]);
    expect(h.jobs).toHaveLength(31);
    expect(h.jobs.find((j) => j.name === 'dashboard')).toMatchObject({
      state: 'running',
      keepAlive: true,
      fullText: true,
      attention: null,
    });
    expect(h.jobs.find((j) => j.name === 'outbox')).toMatchObject({
      state: 'idle',
      fullText: false,
      schedule: 'every 5 min',
    });
    expect(h.jobs.find((j) => j.name === 'kamaji')?.fullText).toBe(true);
    expect(h.updates.known && h.updates.value.items.map((i) => i.title)).toEqual([
      'Command Line Tools for Xcode 27.2',
      'macOS 27.2',
    ]);
    expect(h.tailscale).toEqual({
      known: true,
      value: { state: 'Running', online: true, health: [], version: '1.104.4' },
    });
    expect(h.docker.known && h.docker.value.containers).toHaveLength(12);
    expect(h.bootedAt).toEqual({ known: true, value: '2026-11-02T23:29:38.314Z' });
  });

  it('opens only allowlisted jobs’ logs: here, none but repo-pull’s', async () => {
    const db = testDb();
    const m = mini();
    await cycle(db, m, T0);
    expect(m.tails).toEqual(['/logs/calcifer-repo-pull.log']);
  });

  it('raises an external disk going missing on the second cycle, and clears it', async () => {
    const db = testDb();
    const m = mini();
    m.mount = m.mount
      .split('\n')
      .filter((l) => !l.includes('Respaldo'))
      .join('\n');
    await cycle(db, m, T0);
    expect(openIssues(db)).toEqual([]);
    expect(health(db).disks[1]).toMatchObject({
      name: 'Respaldo',
      mounted: false,
      usedPercent: null,
    });
    await cycle(db, m, T0 + 5 * MIN);
    expect(openIssues(db)).toEqual([
      {
        kind: 'unmounted:Respaldo',
        severity: 'urgent',
        summary: 'Respaldo isn’t mounted on molcajete',
      },
    ]);
    await cycle(db, mini(), T0 + 10 * MIN);
    expect(openIssues(db)).toEqual([]);
  });

  it('raises an always-running job that stopped, and a runner whose last run failed', async () => {
    const db = testDb();
    const m = mini();
    m.prints['dev.craftish.calcifer.dashboard'] = fixture('launchctl-print-dashboard.txt')
      .replace('state = running', 'state = not running')
      .replace('last exit code = (never exited)', 'last exit code = -9');
    m.prints['dev.craftish.calcifer.hunt-ebay'] = fixture('launchctl-print-today.txt').replace(
      'last exit code = 0',
      'last exit code = 1',
    );
    // A phone thread ending isn't a failure.
    m.prints['dev.craftish.calcifer.triage-rc'] = m.prints['dev.craftish.calcifer.hunt-ebay'];
    await cycle(db, m, T0);
    expect(openIssues(db)).toEqual([
      {
        kind: 'job-failed:hunt-ebay',
        severity: 'normal',
        summary: 'molcajete: hunt-ebay’s last run failed (exit code 1)',
      },
    ]);
    expect(health(db).jobs.find((j) => j.name === 'dashboard')?.attention).toBe('Stopped');
    await cycle(db, m, T0 + 5 * MIN);
    expect(openIssues(db).map((i) => [i.kind, i.severity])).toEqual([
      ['job-failed:hunt-ebay', 'normal'],
      ['job-stopped:dashboard', 'urgent'],
    ]);
  });

  it('raises a job that’s installed but not loaded', async () => {
    const db = testDb();
    const m = mini();
    m.plists = [...LABELS, 'dev.craftish.calcifer.inbox-mover-downloads'];
    await cycle(db, m, T0);
    expect(openIssues(db)).toEqual([
      {
        kind: 'job-missing:inbox-mover-downloads',
        severity: 'normal',
        summary: 'molcajete: inbox-mover-downloads is installed but not loaded',
      },
    ]);
    expect(health(db).jobs.find((j) => j.name === 'inbox-mover-downloads')?.state).toBe(
      'not-loaded',
    );
    await cycle(db, mini(), T0 + 5 * MIN);
    expect(openIssues(db)).toEqual([]);
  });

  it('labels calendar jobs from their plist’s StartCalendarInterval', async () => {
    const db = testDb();
    const m = mini();
    m.calendars = {
      'dev.craftish.calcifer.hunt-discogs': '{"Minute":0}',
      'dev.craftish.calcifer.hunt-ebay': '[{"Hour":4,"Minute":30},{"Hour":16,"Minute":30}]',
      'dev.craftish.calcifer.update-stack': '{"Weekday":0,"Hour":4,"Minute":0}',
    };
    await cycle(db, m, T0);
    const schedule = (name: string) => health(db).jobs.find((j) => j.name === name)?.schedule;
    expect(schedule('hunt-discogs')).toBe('hourly at :00');
    expect(schedule('hunt-ebay')).toBe('daily, 04:30 and 16:30');
    expect(schedule('update-stack')).toBe('Sundays, 04:00');
    // plutil failing leaves the plain label rather than a guess.
    expect(schedule('today')).toBe('on a calendar');
  });

  it('notes when a job ran, from launchd’s run count', async () => {
    const db = testDb();
    const m = mini();
    await cycle(db, m, T0);
    expect(health(db).jobs.find((j) => j.name === 'outbox')?.lastRunAt).toBeNull();
    m.prints['dev.craftish.calcifer.outbox'] = fixture('launchctl-print-outbox.txt').replace(
      'runs = 1729',
      'runs = 1730',
    );
    await cycle(db, m, T0 + 5 * MIN);
    expect(health(db).jobs.find((j) => j.name === 'outbox')?.lastRunAt).toBe(
      new Date(T0 + 5 * MIN).toISOString(),
    );
  });

  it('notices a restart, and lets it go after a day', async () => {
    const db = testDb();
    const m = mini();
    await cycle(db, m, T0);
    const bootSec = Math.floor((T0 + 2 * MIN) / 1000);
    m.boottime = `{ sec = ${bootSec}, usec = 0 } Mon Nov  9 13:02:00 2026`;
    await cycle(db, m, T0 + 10 * MIN);
    expect(openIssues(db)).toEqual([
      {
        kind: 'restarted',
        severity: 'normal',
        summary: 'molcajete restarted at 13:02 (cause unknown)',
      },
    ]);
    await cycle(db, m, T0 + 24 * 60 * MIN + 5 * MIN);
    expect(openIssues(db)).toEqual([]);
  });

  it('raises repo-pull after half an hour of failures, not one', async () => {
    const db = testDb();
    const m = mini();
    const line = (min: number) =>
      `2026-11-09 12:${String(min).padStart(2, '0')}:00 can't reach the remote; next run retries`;
    m.repoPull = `${fixture('repo-pull.log')}\n${line(0)}\n`;
    await cycle(db, m, T0 - 55 * MIN);
    expect(openIssues(db)).toEqual([]);
    m.repoPull = `${fixture('repo-pull.log')}\n${[0, 5, 10, 15, 20, 25, 30, 35].map(line).join('\n')}\n`;
    await cycle(db, m, T0 - 22 * MIN);
    expect(openIssues(db)).toEqual([
      {
        kind: 'repo-pull',
        severity: 'normal',
        summary: 'Calcifer’s repo on molcajete hasn’t pulled since 12:00',
      },
    ]);
    // No new failures for a quarter of an hour: the silent runs since have pulled.
    await cycle(db, m, T0);
    expect(openIssues(db)).toEqual([]);
  });

  it('checks software updates a few times a day, and raises them after a week', async () => {
    const db = testDb();
    const m = mini();
    let calls = 0;
    const { exec, fs } = fake(m);
    const counting: Run = (file, args, o) => {
      if (file === TOOLS.softwareupdate) calls++;
      return exec(file, args, o);
    };
    const files = crashFiles();
    const at = async (t: number) =>
      checkMolcajete(db, {
        now: () => t,
        signal: new AbortController().signal,
        crashFiles: files,
        exec: counting,
        fs,
      });
    await at(T0);
    await at(T0 + 5 * MIN);
    expect(calls).toBe(1);
    await at(T0 + UPDATES_EVERY);
    expect(calls).toBe(2);
    await at(T0 + 7 * 24 * 60 * MIN);
    expect(openIssues(db).find((i) => i.kind === 'macos-updates')?.summary).toBe(
      'molcajete: 2 updates have waited over a week (Command Line Tools for Xcode 27.2, macOS 27.2)',
    );
  });

  it('raises Tailscale being down on the second cycle', async () => {
    const db = testDb();
    const m = mini();
    m.tailscale = fixture('tailscale-status.json').replace('"Running"', '"Stopped"');
    await cycle(db, m, T0);
    await cycle(db, m, T0 + 5 * MIN);
    expect(openIssues(db)).toEqual([
      {
        kind: 'tailscale',
        severity: 'urgent',
        summary: 'Tailscale isn’t connected on molcajete (Stopped)',
      },
    ]);
  });

  it('says Docker isn’t answering, without a guess at the containers', async () => {
    const db = testDb();
    const m = mini();
    m.fail[TOOLS.docker] = {
      code: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///Users/x/.docker/run/docker.sock.\n',
    };
    await cycle(db, m, T0);
    await cycle(db, m, T0 + 5 * MIN);
    expect(openIssues(db).map((i) => i.summary)).toEqual(['Docker isn’t answering on molcajete']);
    expect(health(db).docker).toEqual({
      known: false,
      reason:
        'Docker isn’t answering (exit 1: Cannot connect to the Docker daemon at unix:///Users/x/.docker/run/docker.sock.)',
    });
  });

  it('asks the Tailscale app to act as its CLI, and no other tool', async () => {
    const db = testDb();
    const m = mini();
    await cycle(db, m, T0);
    const extra = m.envs.filter(([, env]) => env !== undefined);
    expect(extra).toEqual([[TOOLS.tailscale, { TAILSCALE_BE_CLI: '1' }]]);
  });

  it('says why a reader failed: its exit code and stderr’s first line, cut to 200', async () => {
    const db = testDb();
    const m = mini();
    m.fail[TOOLS.tailscale] = {
      code: 1,
      stderr:
        '\nThe Tailscale GUI failed to start: Tailscale.CLIError error 3\nsecond line, not shown\n',
    };
    m.fail[TOOLS.sysctl] = { code: null, stderr: '' };
    m.fail[TOOLS.launchctl] = { code: 5, stderr: `${'x'.repeat(250)}\n` };
    await cycle(db, m, T0);
    const h = health(db);
    expect(h.tailscale).toEqual({
      known: false,
      reason:
        'Tailscale’s status couldn’t be read (exit 1: The Tailscale GUI failed to start: Tailscale.CLIError error 3)',
    });
    expect(h.bootedAt).toEqual({
      known: false,
      reason: 'sysctl kern.boottime failed (didn’t finish)',
    });
    for (const n of [1, 2]) await cycle(db, m, T0 + n * 5 * MIN);
    const jobs = openIssues(db).find((i) => i.kind === 'unreadable:LaunchAgents');
    expect(jobs?.summary).toBe(
      `Kamaji can’t read molcajete’s LaunchAgents: launchctl list failed (exit 5: ${'x'.repeat(200)})`,
    );
  });

  it('raises a reader that keeps failing on the third cycle', async () => {
    const db = testDb();
    const m = mini();
    m.boottime = '';
    for (const n of [0, 1, 2]) await cycle(db, m, T0 + n * 5 * MIN);
    expect(openIssues(db).map((i) => i.kind)).toEqual(['unreadable:boot time']);
  });
});
