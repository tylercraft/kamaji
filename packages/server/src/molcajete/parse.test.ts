import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeCalendar,
  fromLocal,
  parseCalendar,
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
} from './parse.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('launchctl', () => {
  it('lists only Kamaji’s and Calcifer’s jobs', () => {
    const jobs = parseLaunchctlList(fixture('launchctl-list.txt'));
    expect(jobs).toHaveLength(31);
    expect(jobs.every((j) => j.label.startsWith('dev.craftish.'))).toBe(true);
    expect(jobs.find((j) => j.label === 'dev.craftish.calcifer.dashboard')).toEqual({
      label: 'dev.craftish.calcifer.dashboard',
      pid: 1225,
      status: 0,
    });
    expect(jobs.find((j) => j.label === 'dev.craftish.calcifer.today')?.pid).toBeNull();
  });

  it('reads an always-running job', () => {
    expect(parseLaunchctlPrint(fixture('launchctl-print-dashboard.txt'))).toEqual({
      running: true,
      pid: 1225,
      lastExitCode: null,
      runs: 1,
      keepAlive: true,
      schedule: 'always running',
      stdoutPath: '/Users/tylercraft/Library/Logs/calcifer-dashboard.log',
    });
  });

  it('reads an interval job and a daily one', () => {
    const outbox = parseLaunchctlPrint(fixture('launchctl-print-outbox.txt'));
    expect(outbox).toMatchObject({
      running: false,
      lastExitCode: 0,
      runs: 1729,
      keepAlive: false,
      schedule: 'every 5 min',
    });
    const today = parseLaunchctlPrint(fixture('launchctl-print-today.txt'));
    expect(today).toMatchObject({
      running: false,
      lastExitCode: 0,
      runs: 6,
      schedule: 'on a calendar',
    });
  });

  it('reads a failed exit, in the place the README gives', () => {
    const failed = fixture('launchctl-print-today.txt').replace(
      'last exit code = 0',
      'last exit code = 1',
    );
    expect(parseLaunchctlPrint(failed)?.lastExitCode).toBe(1);
  });

  it('says when a job isn’t loaded', () => {
    expect(parseLaunchctlPrint(fixture('launchctl-print-not-loaded.txt'))).toBeNull();
  });
});

describe('calendar schedules', () => {
  const say = (json: string) => describeCalendar(parseCalendar(json)!);

  it('reads a missing hour as every hour', () => {
    expect(say('{"Minute":0}')).toBe('hourly at :00');
  });

  it('lists every entry of an array', () => {
    expect(say('[{"Hour":4,"Minute":30},{"Hour":16,"Minute":30}]')).toBe('daily, 04:30 and 16:30');
  });

  it('names the weekday', () => {
    expect(say('{"Weekday":0,"Hour":4,"Minute":0}')).toBe('Sundays, 04:00');
    expect(say('{"Weekday":7,"Hour":4,"Minute":0}')).toBe('Sundays, 04:00');
  });

  it('handles any mix of keys', () => {
    expect(say('{"Hour":7,"Minute":15}')).toBe('daily, 07:15');
    expect(say('{"Day":1,"Hour":9,"Minute":0}')).toBe('the 1st of each month, 09:00');
    expect(say('{"Month":3,"Day":22,"Hour":9,"Minute":5}')).toBe('22 March, 09:05');
    expect(say('{"Month":12}')).toBe('every day in December, every minute');
    expect(say('{"Hour":3}')).toBe('every minute from 03:00 to 03:59');
    expect(say('{}')).toBe('every minute');
    expect(
      say('[{"Weekday":1,"Hour":8,"Minute":0},{"Weekday":5,"Hour":8,"Minute":0},{"Minute":30}]'),
    ).toBe('Mondays, 08:00; Fridays, 08:00; hourly at :30');
  });

  it('gives up on anything else', () => {
    expect(parseCalendar('')).toBeNull();
    expect(parseCalendar('{"Hour":"4"}')).toBeNull();
  });
});

describe('disks', () => {
  it('reads the internal drive by its container', () => {
    const root = parseDiskutil(fixture('diskutil-root.plist'));
    expect(root).toEqual({
      name: 'Macintosh HD',
      mount: '/',
      sizeBytes: 494384795648,
      freeBytes: 195841146880,
      smart: 'Verified',
      writable: false,
    });
  });

  it('reads both externals', () => {
    const respaldo = parseDiskutil(fixture('diskutil-respaldo.plist'));
    const palomitas = parseDiskutil(fixture('diskutil-palomitas.plist'));
    expect(respaldo).toMatchObject({
      name: 'Respaldo',
      mount: '/Volumes/Respaldo',
      smart: 'Verified',
      writable: true,
    });
    expect(palomitas).toMatchObject({ name: 'Palomitas', freeBytes: 4771103043584 });
  });

  it('knows what’s mounted', () => {
    const mounts = parseMount(fixture('mount.txt'));
    expect(mounts.has('/Volumes/Respaldo')).toBe(true);
    expect(mounts.has('/Volumes/Palomitas')).toBe(true);
    expect(mounts.has('/System/Volumes/Data/home')).toBe(true);
    expect(mounts.has('/Volumes/Elsewhere')).toBe(false);
  });
});

describe('software updates', () => {
  it('reads what’s pending, and which need a restart', () => {
    expect(parseSoftwareUpdate(fixture('softwareupdate-list.txt'), 0)).toEqual([
      {
        label: 'Command Line Tools for Xcode 27.2-27.2',
        title: 'Command Line Tools for Xcode 27.2',
        restart: false,
      },
      { label: 'macOS 27.2-26B123', title: 'macOS 27.2', restart: true },
    ]);
  });

  it('treats “No new software” as none and anything else failing as unknown', () => {
    expect(parseSoftwareUpdate('No new software available.\n', 1)).toEqual([]);
    expect(parseSoftwareUpdate('', 1)).toBeNull();
    expect(parseSoftwareUpdate('', null)).toBeNull();
  });
});

describe('docker', () => {
  it('reads the engine and Desktop versions', () => {
    expect(parseDockerVersion(fixture('docker-version.json'))).toEqual({
      engine: '29.9.2',
      desktop: 'Docker Desktop 4.97.0 (244584)',
    });
    expect(parseDockerVersion('{"Client":{"Version":"29.9.2"},"Server":null}')).toBeNull();
    expect(parseDockerVersion('')).toBeNull();
  });

  it('reads every container', () => {
    const containers = parseDockerPs(fixture('docker-ps.jsonl'));
    expect(containers).toHaveLength(12);
    expect(containers.every((c) => c.healthy)).toBe(true);
    expect(containers.find((c) => c.name === 'tdarr')).toEqual({
      name: 'tdarr',
      image: 'ghcr.io/haveagitgat/tdarr:latest',
      state: 'running',
      status: 'Up 32 hours',
      healthy: true,
    });
  });

  it('counts a stopped or unhealthy container as not running well', () => {
    const lines = fixture('docker-ps.jsonl').split('\n');
    const stopped = lines[0]!.replace('"State": "running"', '"State": "exited"');
    const sick = lines[1]!.replace('"HealthStatus": "none"', '"HealthStatus": "unhealthy"');
    expect(parseDockerPs([stopped, sick].join('\n')).map((c) => c.healthy)).toEqual([false, false]);
  });
});

describe('tailscale', () => {
  it('reads this node only', () => {
    expect(parseTailscale(fixture('tailscale-status.json'))).toEqual({
      state: 'Running',
      online: true,
      health: [],
      version: '1.104.4',
    });
  });
});

describe('boot time', () => {
  it('reads kern.boottime', () => {
    expect(new Date(parseBoottime(fixture('boottime.txt'))!).toISOString()).toBe(
      '2026-11-02T23:29:38.314Z',
    );
  });
});

describe('repo-pull', () => {
  it('finds the newest line, and that it isn’t failing', () => {
    expect(parseRepoPull(fixture('repo-pull.log'))).toEqual({
      lastAt: fromLocal(2026, 11, 8, 8, 17, 21),
      failingSince: null,
    });
  });

  it('finds when a run of failures began, skipping git’s own lines', () => {
    const log = [
      '2026-11-08 08:17:21 pulled 1 commit(s)',
      'git@github.com: Permission denied (publickey).',
      '2026-11-08 08:22:21 can’t reach the remote; next run retries'.replace('’', "'"),
      "2026-11-08 08:27:21 can't reach the remote; next run retries",
    ].join('\n');
    expect(parseRepoPull(log)?.failingSince).toBe(fromLocal(2026, 11, 8, 8, 22, 21));
  });

  it('works in Christchurch time, either side of daylight saving', () => {
    expect(new Date(fromLocal(2026, 11, 8, 8, 17, 21)).toISOString()).toBe(
      '2026-11-07T19:17:21.000Z',
    );
    expect(new Date(fromLocal(2026, 6, 1, 12, 0, 0)).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});
