import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { findOpenIssue } from '../issues.js';
import { latestObservations } from '../observations.js';
import { testDb } from '../testing.js';
import { fixture as aptList, run as parseApt } from './aptFixture.js';
import {
  checkServers,
  parseReport,
  type ReportReading,
  type ServerReport,
} from './serverReport.js';
import { classify, updateRows } from './serverUpdates.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 13);

/** A format 2 report with craftish's real upgradable list (parsed by the script's own code). */
function report(change: Partial<ServerReport> = {}, apt = aptList): ReportReading {
  const base = parseReport(
    readFileSync(
      new URL('./fixtures/kamaji-report.ubuntu-container.json', import.meta.url),
      'utf8',
    ),
  );
  if (!base.ok) throw new Error(base.problem);
  return {
    ok: true,
    report: {
      ...base.report,
      format: 2,
      ...parseApt(apt),
      services: { nginx: 'inactive', apache2: 'active', mariadb: 'active' },
      disks: [{ mount: '/', sizeBytes: 100, usedBytes: 40, availableBytes: 60 }],
      ...change,
    },
  };
}

async function at(db: Db, when: number, reading: ReportReading) {
  await checkServers(db, {
    now: () => when,
    signal: new AbortController().signal,
    keyPath: '/nonexistent',
    knownHostsPath: '/nonexistent',
    read: async () => reading,
  });
}

const issue = (db: Db, kind: string) =>
  findOpenIssue(db, { resourceType: 'server', resourceId: 'craftish', kind });

describe('classing packages', () => {
  it('knows the internet-facing ones by name, and Apache only while it runs', () => {
    const running = { apache2: 'active' };
    expect(classify('libssl3t64', running).internetFacing).toBe('OpenSSL');
    expect(classify('php8.3-fpm', running)).toEqual({
      internetFacing: 'PHP',
      care: 'restarts PHP-FPM: check the sites after',
    });
    expect(classify('linux-image-6.8.0-90-generic', running).internetFacing).toBe('the kernel');
    expect(classify('linux-firmware-amd-graphics', running).internetFacing).toBeNull();
    expect(classify('apache2-bin', running).internetFacing).toBe('Apache');
    expect(classify('apache2-bin', { apache2: 'inactive' })).toEqual({
      internetFacing: null,
      care: 'restarts the web server',
    });
    expect(classify('libc6', running)).toEqual({ internetFacing: null, care: null });
  });
});

describe('craftish’s updates, rated', () => {
  it('makes Apache’s security update urgent after a day, and keeps only counts in observations', async () => {
    const db = testDb({ seed: true });
    await at(db, T0, report());
    expect(issue(db, 'security-updates')).toBeNull();
    await at(db, T0 + DAY, report());
    expect(issue(db, 'security-updates')).toMatchObject({
      severity: 'urgent',
      summary:
        'craftish: security updates for Apache waiting over a day (8 security updates in all)',
    });
    expect(updateRows(db, 'craftish')).toHaveLength(34);
    const [kept] = latestObservations<ReportReading>(db, 'server', 'craftish', 'report', 'ssh', 1);
    expect(kept?.value.ok && 'upgradable' in kept.value.report).toBe(false);
  });

  it('puts the rest of the security updates in the digest when Apache isn’t running', async () => {
    const db = testDb({ seed: true });
    const quiet = { services: { apache2: 'inactive', mariadb: 'active' } };
    await at(db, T0, report(quiet));
    await at(db, T0 + DAY, report(quiet));
    // Watched only for the rating: Apache installed and stopped isn't a stopped service.
    expect(issue(db, 'services')).toBeNull();
    expect(issue(db, 'security-updates')).toMatchObject({
      severity: 'normal',
      summary: 'craftish: 8 security updates waiting for over a day',
    });
  });

  it('starts a package’s clock again at a new version, and keeps a capped list’s missing rows', async () => {
    const db = testDb({ seed: true });
    await at(db, T0, report());
    const newer = aptList.replace(
      'apache2-bin/noble-security 2.4.58-1ubuntu8.19',
      'apache2-bin/noble-security 2.4.58-1ubuntu8.20',
    );
    await at(db, T0 + DAY, report({}, newer));
    expect(issue(db, 'security-updates')?.severity).toBe('normal');
    const apache = updateRows(db, 'craftish').find((r) => r.name === 'apache2-bin');
    expect(apache).toMatchObject({ to: '2.4.58-1ubuntu8.20', firstSeenAt: T0 + DAY });
    // Cut short by the cap: what's missing may still be waiting.
    const capped = report();
    if (capped.ok) {
      capped.report.upgradable = capped.report.upgradable!.slice(0, 3);
      capped.report.truncated = true;
    }
    await at(db, T0 + 2 * DAY, capped);
    expect(updateRows(db, 'craftish')).toHaveLength(34);
    await at(db, T0 + 3 * DAY, report({}, 'Listing...\n'));
    expect(updateRows(db, 'craftish')).toHaveLength(0);
    expect(issue(db, 'security-updates')).toBeNull();
  });

  it('makes a restart urgent once it has been pending over 7 days', async () => {
    const db = testDb({ seed: true });
    const pending = (since: number) =>
      report({
        rebootRequired: true,
        rebootPackages: ['linux-image-6.8.0-90-generic'],
        rebootRequiredSince: new Date(since).toISOString(),
      });
    await at(db, T0, pending(T0 - 3 * DAY));
    expect(issue(db, 'reboot')).toMatchObject({
      severity: 'normal',
      summary: 'craftish needs a restart to finish updates',
    });
    await at(db, T0 + 5 * DAY, pending(T0 - 3 * DAY));
    expect(issue(db, 'reboot')).toMatchObject({
      severity: 'urgent',
      summary: 'craftish has needed a restart for 8 days to finish updates',
    });
  });

  it('nudges about 20 or more ordinary updates once the oldest has waited over 30 days', async () => {
    const db = testDb({ seed: true });
    await at(db, T0, report());
    await at(db, T0 + 30 * DAY, report());
    expect(issue(db, 'stale-updates')).toBeNull();
    await at(db, T0 + 31 * DAY, report());
    expect(issue(db, 'stale-updates')).toMatchObject({
      severity: 'normal',
      summary: 'craftish: 26 ordinary updates waiting, the oldest for 31 days',
    });
    // Fewer than 20 left: in hand.
    const fewer = aptList.split('\n').slice(0, 15).join('\n');
    await at(db, T0 + 32 * DAY, report({}, fewer));
    expect(issue(db, 'stale-updates')).toBeNull();
  });

  it('never counts Ubuntu Pro’s ESM updates', async () => {
    const db = testDb({ seed: true });
    const esm =
      'Listing...\nlibxml2/noble-apps-security 2.9.14-1 amd64 [upgradable from: 2.9.14-0]\n';
    await at(db, T0, report({}, esm));
    await at(db, T0 + 2 * DAY, report({}, esm));
    expect(issue(db, 'security-updates')).toBeNull();
  });
});
