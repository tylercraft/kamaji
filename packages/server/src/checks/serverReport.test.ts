import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { findOpenIssue } from '../issues.js';
import { serverSummaries } from '../queries.js';
import { testDb } from '../testing.js';
import {
  checkServers,
  parseReport,
  readReport,
  type ReportReading,
  type ServerReport,
} from './serverReport.js';

// Captured from server-report/kamaji-report in an ubuntu:24.04 container (no systemd running).
const fixture = readFileSync(
  new URL('./fixtures/kamaji-report.ubuntu-container.json', import.meta.url),
  'utf8',
);
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 9);

const base = (): ServerReport => {
  const reading = parseReport(fixture);
  if (!reading.ok) throw new Error(reading.problem);
  return {
    ...reading.report,
    packages: { security: [], other: [], esm: [] },
    services: { nginx: 'active', mariadb: 'active' },
    disks: [{ mount: '/', sizeBytes: 100, usedBytes: 40, availableBytes: 60 }],
  };
};

const ok = (change: Partial<ServerReport> = {}): ReportReading => ({
  ok: true,
  report: { ...base(), ...change },
});

let clock = T0;
async function run(db: Db, readings: ReportReading[]) {
  for (const reading of readings) {
    await checkServers(db, {
      now: () => (clock += HOUR),
      signal: new AbortController().signal,
      keyPath: '/nonexistent',
      knownHostsPath: '/nonexistent',
      read: async () => reading,
    });
  }
}

const issue = (db: Db, kind: string) =>
  findOpenIssue(db, { resourceType: 'server', resourceId: 'craftish', kind });

describe('kamaji-report', () => {
  it('parses the script’s output', () => {
    const reading = parseReport(fixture);
    expect(reading.ok).toBe(true);
    if (reading.ok) {
      expect(reading.report.os.codename).toBe('noble');
      expect(reading.report.packages.security).toContain('apt');
    }
  });

  it('refuses output it doesn’t understand', () => {
    expect(parseReport('Welcome to Ubuntu')).toEqual({
      ok: false,
      problem: 'The report wasn’t JSON',
    });
    expect(parseReport('{"format":2}')).toEqual({
      ok: false,
      problem: 'The report’s format wasn’t understood',
    });
  });

  it('says so when the mini has no key yet', async () => {
    const reading = await readReport(
      { address: 'x@y', keyPath: '/nonexistent', knownHostsPath: '/nonexistent' },
      new AbortController().signal,
    );
    expect(reading).toEqual({ ok: false, problem: 'No SSH key on the mini yet' });
  });
});

describe('checkServers', () => {
  it('waits a day before calling security updates a problem', async () => {
    const db = testDb({ seed: true });
    const waiting = ok({ packages: { security: ['openssl'], other: [], esm: [] } });
    await run(db, Array(24).fill(waiting));
    expect(issue(db, 'security-updates')).toBe(null);
    await run(db, [ok(), ...Array(25).fill(waiting)]);
    expect(issue(db, 'security-updates')).toMatchObject({
      severity: 'normal',
      summary: 'craftish: 1 security update waiting for over a day',
    });
    await run(db, [ok()]);
    expect(issue(db, 'security-updates')).toBe(null);
  });

  it('flags a restart, stopped services and a filling disk', async () => {
    const db = testDb({ seed: true });
    await run(db, [
      ok({
        rebootRequired: true,
        failedUnits: ['certbot.service'],
        services: { nginx: 'active', mariadb: 'inactive' },
        disks: [{ mount: '/', sizeBytes: 100, usedBytes: 96, availableBytes: 4 }],
      }),
    ]);
    expect(issue(db, 'reboot')?.summary).toBe('craftish needs a restart to finish updates');
    expect(issue(db, 'services')?.summary).toBe(
      'craftish: 2 services have stopped (certbot, mariadb)',
    );
    expect(issue(db, 'disk')).toMatchObject({
      severity: 'urgent',
      summary: 'craftish: / is 96% full',
    });
    await run(db, [ok()]);
    expect(['reboot', 'services', 'disk'].map((k) => issue(db, k))).toEqual([null, null, null]);
  });

  it('notices an OS near the end of support', async () => {
    const db = testDb({ seed: true });
    await run(db, [ok({ os: { ...base().os, codename: 'jammy', name: 'Ubuntu 22.04 LTS' } })]);
    expect(issue(db, 'os-eol')).toBe(null); // 2027-06: more than 180 days from 2026-11
    const later = T0 + 400 * 24 * HOUR;
    await checkServers(db, {
      now: () => later,
      signal: new AbortController().signal,
      keyPath: '',
      knownHostsPath: '',
      read: async () => ok({ os: { ...base().os, codename: 'jammy', name: 'Ubuntu 22.04 LTS' } }),
    });
    expect(issue(db, 'os-eol')?.summary).toBe(
      'craftish: Ubuntu 22.04 LTS leaves standard support on 2027-06-01',
    );
  });

  it('raises unreadable on the third failure, and keeps the last good report on show', async () => {
    const db = testDb({ seed: true });
    const failed: ReportReading = { ok: false, problem: 'Couldn’t reach the server' };
    await run(db, [ok(), failed, failed]);
    expect(issue(db, 'unreadable')).toBe(null);
    await run(db, [failed]);
    expect(issue(db, 'unreadable')?.summary).toBe(
      'Kamaji can’t read craftish’s report: Couldn’t reach the server',
    );
    const [craftish, molcajete] = serverSummaries(db);
    expect(craftish?.health.known).toBe(true);
    expect(craftish?.lastAttempt).toMatchObject({ value: { ok: false } });
    expect(molcajete?.health).toMatchObject({ known: false });
  });
});
