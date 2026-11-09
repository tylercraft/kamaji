import { appendFileSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';
import { notifyNow } from '../notify.js';
import { writeState } from '../state.js';
import { testDb } from '../testing.js';
import { HEALTH_STATE } from './check.js';
import { checkCrashes, parseCrashLines, recentCrashGroups } from './crashes.js';
import { jobDetail } from './detail.js';

const T0 = Date.UTC(2026, 10, 9, 0, 0); // 13:00 in Christchurch
const MIN = 60_000;
const DAY = 1440 * MIN;
const SECRET = 'Re: your invoice from someone@example.com';

function crash(job: string, at: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    at: new Date(at).toISOString(),
    job: `dev.craftish.calcifer.${job}`,
    script: `/Users/tylercraft/calcifer/agent/${job}.py`,
    pid: 4242,
    type: 'KeyError',
    where: `agent/${job}.py:main`,
    line: 12,
    frames: [
      { file: `agent/${job}.py`, function: '<module>', line: 40 },
      { file: `agent/${job}.py`, function: 'main', line: 12 },
    ],
    ...extra,
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kamaji-crashes-'));
  const files = { path: join(dir, 'calcifer-crashes.jsonl') };
  const write = (...lines: string[]) =>
    appendFileSync(files.path, lines.map((l) => `${l}\n`).join(''));
  return { files, write };
}

function outbox() {
  const sent: string[] = [];
  const discord: Discord = {
    configured: true,
    send: async (content) => {
      sent.push(content);
      return true;
    },
  };
  return { sent, discord };
}

const notify = { kamajiUrl: 'https://kamaji.test', workerAlerts: false, digestAt: '07:30' };

/** Every text Kamaji keeps, as one string. */
function everything(db: Db): string {
  const tables = ['crash_groups', 'crashes', 'issues', 'events', 'state', 'observations'];
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
}

describe('the crash log', () => {
  it('keeps message and traceback only for allowlisted jobs, and never in the database', () => {
    const { records } = parseCrashLines(
      [
        crash('hunt-ebay', T0, { message: 'HTTP 503', traceback: 'Traceback…' }),
        crash('triage', T0, { message: SECRET, traceback: SECRET }),
        'not json',
        '{"v": 2}',
      ].join('\n'),
    );
    expect(records.map((r) => [r.job, r.message, r.traceback])).toEqual([
      ['dev.craftish.calcifer.hunt-ebay', 'HTTP 503', 'Traceback…'],
      ['dev.craftish.calcifer.triage', undefined, undefined],
    ]);
    expect(records[1]?.frames).toHaveLength(2);

    const db = testDb();
    const { files, write } = setup();
    write(
      crash('hunt-ebay', T0, { message: SECRET, traceback: SECRET }),
      crash('triage', T0, { message: SECRET, traceback: SECRET }),
    );
    expect(checkCrashes(db, T0, files)).toBe(2);
    expect(everything(db)).not.toContain('someone@example.com');
  });

  it('alerts once per new group, then stays quiet until it’s gone a week without one', async () => {
    const db = testDb();
    const { files, write } = setup();
    const { sent, discord } = outbox();

    write(crash('triage', T0 - 7 * 60 * MIN)); // 06:00 local
    checkCrashes(db, T0, files);
    await notifyNow(db, T0, discord, notify);
    expect(sent).toEqual(['**Kamaji**\n- triage crashed at 06:00\n<https://kamaji.test>']);

    write(crash('triage', T0 + MIN), crash('triage', T0 + 2 * MIN));
    checkCrashes(db, T0 + 5 * MIN, files);
    await notifyNow(db, T0 + 5 * MIN, discord, notify);
    await notifyNow(db, T0 + 2 * DAY, discord, notify);
    expect(sent).toHaveLength(1);
    expect(recentCrashGroups(db, T0 + 5 * MIN)).toMatchObject([
      { job: 'dev.craftish.calcifer.triage', type: 'KeyError', recent: 3, line: 12 },
    ]);
    const summary = db.prepare('SELECT summary FROM issues WHERE resolved_at IS NULL').get();
    expect(summary?.summary).toBe('triage crashed 3 times since 06:00');

    // A week without a crash closes it, silently.
    checkCrashes(db, T0 + 2 * MIN + 7 * DAY + MIN, files);
    await notifyNow(db, T0 + 2 * MIN + 7 * DAY + MIN, discord, notify);
    expect(sent).toHaveLength(1);
    expect(db.prepare('SELECT 1 FROM issues WHERE resolved_at IS NULL').get()).toBeUndefined();

    // The next crash is news again.
    const later = T0 + 9 * DAY;
    write(crash('triage', later));
    checkCrashes(db, later, files);
    await notifyNow(db, later, discord, notify);
    expect(sent[1]).toBe('**Kamaji**\n- triage crashed at 13:00\n<https://kamaji.test>');
  });

  it('follows the hook’s rename to .1 without losing or repeating a line', () => {
    const db = testDb();
    const { files, write } = setup();
    write(crash('hunt-ebay', T0));
    expect(checkCrashes(db, T0, files)).toBe(1);
    write(crash('hunt-ebay', T0 + MIN));
    renameSync(files.path, `${files.path}.1`);
    write(crash('hunt-ebay', T0 + 2 * MIN));
    expect(checkCrashes(db, T0 + 5 * MIN, files)).toBe(2);
    expect(checkCrashes(db, T0 + 10 * MIN, files)).toBe(0);
    // A half-written line waits for the next cycle.
    appendFileSync(files.path, crash('hunt-ebay', T0 + 11 * MIN).slice(0, 30));
    expect(checkCrashes(db, T0 + 15 * MIN, files)).toBe(0);
  });
});

describe('job details', () => {
  const jobs = [
    { name: 'hunt-ebay', label: 'dev.craftish.calcifer.hunt-ebay' },
    { name: 'triage', label: 'dev.craftish.calcifer.triage' },
  ].map((j) => ({
    ...j,
    state: 'idle',
    keepAlive: false,
    schedule: null,
    lastExitCode: 1,
    runs: 3,
    lastRunAt: null,
    fullText: j.name === 'hunt-ebay',
    attention: null,
  }));

  it('shows an allowlisted job’s log and crash text, read from the mini', () => {
    const db = testDb();
    writeState(db, HEALTH_STATE, { jobs }, T0);
    const { files, write } = setup();
    write(crash('hunt-ebay', T0, { message: 'HTTP 503', traceback: 'Traceback (most recent…)' }));
    const opened: string[] = [];
    const detail = jobDetail(db, 'hunt-ebay', {
      crashFiles: files,
      logsDir: '/logs',
      tail: (path) => {
        opened.push(path);
        return 'line 1\nline 2\n';
      },
    });
    expect(opened).toEqual(['/logs/calcifer-hunt-ebay.log']);
    expect(detail).toEqual({
      name: 'hunt-ebay',
      log: { known: true, value: 'line 1\nline 2' },
      crash: {
        known: true,
        value: {
          at: new Date(T0).toISOString(),
          type: 'KeyError',
          where: 'agent/hunt-ebay.py:main',
          line: 12,
          message: 'HTTP 503',
          traceback: 'Traceback (most recent…)',
        },
      },
    });
  });

  it('never opens a mail job’s log, and shows where it crashed without what it said', () => {
    const db = testDb();
    writeState(db, HEALTH_STATE, { jobs }, T0);
    const { files, write } = setup();
    write(crash('triage', T0, { message: SECRET, traceback: SECRET }));
    const opened: string[] = [];
    const detail = jobDetail(db, 'triage', {
      crashFiles: files,
      logsDir: '/logs',
      tail: (path) => {
        opened.push(path);
        return SECRET;
      },
    });
    expect(opened).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('someone@example.com');
    expect(detail?.log).toEqual({
      known: false,
      reason: 'Not shown: triage reads mail or untrusted text',
    });
    expect(detail?.crash).toMatchObject({
      value: { where: 'agent/triage.py:main', message: null },
    });
  });

  it('knows only molcajete’s own jobs', () => {
    const db = testDb();
    writeState(db, HEALTH_STATE, { jobs }, T0);
    const { files } = setup();
    expect(jobDetail(db, '../../etc/passwd', { crashFiles: files, logsDir: '/logs' })).toBeNull();
    expect(jobDetail(db, 'nope', { crashFiles: files, logsDir: '/logs' })).toBeNull();
  });
});
