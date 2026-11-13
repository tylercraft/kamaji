import type {
  BackupEntry,
  Inventory,
  SiteBackupsResponse,
  SiteDetailResponse,
  SiteSummary,
  VulnerabilityMatch,
  WholeSiteBackups,
} from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { backups, certificate, fromOutside, homePage, security } from './siteStatus';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const DAY = 24 * 60;

const site: SiteSummary = {
  id: 'a',
  name: 'A',
  url: 'https://a.test/',
  hostKind: 'craftish',
  clientSlug: null,
  mode: 'connected',
  setup: 'done',
  tailnetOnly: false,
  expectedText: null,
  pausedAt: null,
  createdAt: ago(10 * DAY),
  availability: {
    known: true,
    value: { state: 'up', checkedAt: ago(2), responseMs: 240, problem: null },
  },
  outside: { known: true, value: { ok: true, checkedAt: ago(3), problem: null } },
  certificate: {
    known: true,
    value: { validTo: ago(-60 * DAY), daysLeft: 60, checkedAt: ago(5), problem: null },
  },
  updates: { known: true, value: 0 },
  findings: [],
};

describe('the home page line', () => {
  it('says reachable, and says when the content isn’t checked', () => {
    const l = homePage(site, NOW);
    expect(l).toMatchObject({ state: 'Reachable', tone: 'green', outOfDate: false });
    expect(l.detail).toContain('content isn’t checked');
    const withText = homePage({ ...site, expectedText: 'Hello' }, NOW);
    expect(withText.detail).toContain('“Hello”');
  });

  it('doesn’t pass an old success off as current', () => {
    const old = {
      ...site,
      availability: {
        known: true,
        value: { state: 'up', checkedAt: ago(90), responseMs: 240, problem: null },
      },
    } as SiteSummary;
    expect(homePage(old, NOW)).toMatchObject({
      state: 'Last reachable',
      tone: 'neutral',
      outOfDate: true,
    });
    const outside = {
      ...site,
      outside: { known: true, value: { ok: true, checkedAt: ago(60), problem: null } },
    } as SiteSummary;
    expect(fromOutside(outside, NOW)).toMatchObject({ tone: 'neutral', outOfDate: true });
  });

  it('says not checked yet when there’s no check, and paused when paused', () => {
    expect(
      homePage({ ...site, availability: { known: false, reason: 'Not checked yet' } }, NOW),
    ).toMatchObject({ state: 'Not checked yet', tone: 'neutral' });
    expect(homePage({ ...site, pausedAt: ago(5) }, NOW).state).toBe('Paused');
  });
});

const vuln = (over: Partial<VulnerabilityMatch> = {}): VulnerabilityMatch => ({
  id: 'v1',
  title: 'XSS',
  informational: false,
  cvssScore: 6.1,
  cvssRating: 'Medium',
  cve: null,
  fixedIn: '2.0',
  remediation: null,
  reference: null,
  published: null,
  ...over,
});

const inventory = (over: Partial<Inventory> = {}): Inventory =>
  ({
    reportedAt: ago(20),
    wordpressCheckedAt: { core: ago(20), plugins: ago(20), themes: ago(20) },
    core: { version: '6.8', offer: null, vulnerabilities: [] },
    vulnerabilityData: { known: true, value: { fetchedAt: ago(60), stale: false, problem: null } },
    php: '8.3',
    database: '10.11',
    endOfLife: {} as Inventory['endOfLife'],
    plugins: [],
    muPlugins: { known: true, value: [] },
    themes: [],
    siteHealth: [],
    lastFailure: null,
    ...over,
  }) as Inventory;

const detail = (
  inv: SiteDetailResponse['inventory'],
  mode: 'connected' | 'monitoring' = 'connected',
) => ({ site: { ...site, mode }, inventory: inv }) as SiteDetailResponse;

describe('the security line', () => {
  it('says none known only with data and a current report', () => {
    expect(security(detail({ known: true, value: inventory() }), NOW)).toMatchObject({
      state: 'None known',
      tone: 'green',
    });
    expect(
      security(detail({ known: true, value: inventory({ reportedAt: ago(5 * 60) }) }), NOW),
    ).toMatchObject({ state: 'None known at last report', tone: 'neutral', outOfDate: true });
  });

  it('says not checked, not none, when it can’t know', () => {
    expect(security(detail({ known: true, value: inventory() }, 'monitoring'), NOW).state).toBe(
      'Not checked',
    );
    expect(security(detail({ known: false, reason: 'No report yet' }), NOW)).toMatchObject({
      state: 'Not checked',
      detail: 'No report yet',
    });
    const noData = inventory({
      vulnerabilityData: { known: false, reason: 'Wordfence not downloaded yet' },
    });
    expect(security(detail({ known: true, value: noData }), NOW).state).toBe('Not checked');
    const stale = inventory({
      vulnerabilityData: {
        known: true,
        value: { fetchedAt: ago(4 * DAY), stale: true, problem: null },
      },
    });
    expect(security(detail({ known: true, value: stale }), NOW).tone).toBe('amber');
  });

  it('counts findings, leaving out informational ones', () => {
    const inv = inventory({
      plugins: [
        { name: 'Forms', vulnerabilities: [vuln(), vuln({ id: 'v2', informational: true })] },
      ] as Inventory['plugins'],
    });
    expect(security(detail({ known: true, value: inv }), NOW)).toMatchObject({
      state: '1 known vulnerability',
      tone: 'red',
    });
  });
});

const entry = (over: Partial<BackupEntry>): BackupEntry => ({
  recordedAt: ago(60),
  state: 'exported',
  batchId: null,
  runApprovedAt: null,
  exportedAt: ago(60),
  bytes: 1000,
  sha256: 'abc',
  words: 'Exported',
  ...over,
});

const whole = (over: Partial<WholeSiteBackups> = {}): WholeSiteBackups => ({
  schedule: 'weekly',
  own: true,
  consentAt: null,
  consentBy: null,
  active: true,
  lastGoodAt: ago(DAY),
  nextDueAt: ago(-5 * DAY),
  snapshots: [
    {
      startedAt: ago(DAY),
      finishedAt: ago(DAY - 1),
      ok: true,
      bytes: 1,
      addedBytes: 1,
      databaseBytes: 1,
      wordpress: '6.8',
      problem: null,
      forgotten: false,
    },
  ],
  restoreChecks: [
    { startedAt: ago(3 * DAY), seconds: 90, ok: true, failedStep: null, problem: null },
  ],
  pending: { backup: null, restore: null },
  repository: null,
  ...over,
});

const response = (over: Partial<SiteBackupsResponse>): SiteBackupsResponse => ({
  backupExpectation: 'kamaji',
  download: null,
  wholeSite: null,
  canExport: true,
  exporting: null,
  latest: null,
  history: [],
  ...over,
});

const states = (r: SiteBackupsResponse) =>
  Object.fromEntries(backups(r, NOW).map((l) => [l.label, l.state]));

describe('the backup lines', () => {
  it('keeps a database export apart from a whole-site backup', () => {
    expect(states(response({ history: [entry({})], wholeSite: whole() }))).toEqual({
      'Database export': 'Exported by Kamaji',
      'Whole-site backup': 'Backed up by Kamaji',
      'Restore check': 'Passed',
    });
  });

  it('says a vouched-for backup isn’t made or checked by Kamaji', () => {
    const lines = backups(
      response({
        backupExpectation: 'tyler',
        canExport: false,
        history: [entry({ state: 'recorded', words: 'Tyler confirmed' })],
      }),
      NOW,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      label: 'Backups',
      state: 'Not made by Kamaji',
      tone: 'neutral',
    });
  });

  it('shows a failed attempt over an older good export', () => {
    expect(
      states(
        response({
          history: [entry({ state: 'failed', recordedAt: ago(5), words: 'ssh failed' }), entry({})],
        }),
      )['Database export'],
    ).toBe('Last attempt failed');
  });

  it('marks an overdue backup and an old restore check', () => {
    const r = response({
      wholeSite: whole({
        lastGoodAt: ago(10 * DAY),
        snapshots: [],
        restoreChecks: [
          { startedAt: ago(60 * DAY), seconds: 90, ok: true, failedStep: null, problem: null },
        ],
      }),
    });
    expect(states(r)).toMatchObject({
      'Whole-site backup': 'Overdue',
      'Restore check': 'Passed, out of date',
    });
  });

  it('says off, and not set, plainly', () => {
    expect(
      states(
        response({
          backupExpectation: null,
          canExport: false,
          wholeSite: whole({ schedule: 'off', active: false }),
        }),
      ),
    ).toEqual({ Backups: 'Not set', 'Whole-site backup': 'Off' });
  });
});

describe('the certificate line', () => {
  it('says a timed-out check timed out, not that it wasn’t checked or is bad', () => {
    const l = certificate({
      ...site,
      certificate: { known: false, reason: 'No answer within 20 seconds' },
    });
    expect(l).toMatchObject({ state: 'Check timed out', tone: 'amber' });
    expect(
      certificate({ ...site, certificate: { known: false, reason: 'Not read yet' } }).state,
    ).toBe('Not checked yet');
  });

  it('never says valid for a certificate that isn’t trusted', () => {
    const c = site.certificate as Extract<SiteSummary['certificate'], { known: true }>;
    const l = certificate({
      ...site,
      certificate: { known: true, value: { ...c.value, problem: 'Certificate not trusted' } },
    });
    expect(l).toMatchObject({ state: 'Certificate not trusted', tone: 'red' });
  });
});

describe('informational notes', () => {
  it('qualify “none known” instead of sitting beside it', () => {
    const inv = inventory({
      core: { version: '6.8', offer: null, vulnerabilities: [vuln({ informational: true })] },
    } as Partial<Inventory>);
    const l = security(detail({ known: true, value: inv }), NOW);
    expect(l.state).toBe('No actionable findings');
    expect(l.detail).toContain('1 informational note');
  });
});
