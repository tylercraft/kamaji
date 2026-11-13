import type { CareHello, SiteBackupsResponse, SiteDetailResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { siteLooks } from './siteAttention';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const DAY = 24 * 60;

const hello: CareHello = {
  plugin: '0.2.0',
  protocol: 1,
  wordpress: '7.1',
  php: '8.3',
  multisite: false,
  capabilities: {
    can_report: true,
    can_update: true,
    update_blockers: [],
    auto_updates: { all_disabled: true, plugins: false, themes: false },
    maintenance: { present: false, age_seconds: null },
    wp_cron_disabled: false,
    loopback: { ok: true },
  },
};

const vuln = (informational = false) => ({
  id: Math.random().toString(),
  title: 'XSS',
  informational,
  cvssScore: null,
  cvssRating: null,
  cve: null,
  fixedIn: '2.0',
  remediation: null,
  reference: null,
  published: null,
});

function detail(over: { siteHealth?: string[]; loopback?: boolean; vulns?: number } = {}) {
  return {
    site: {
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
        value: { state: 'up', checkedAt: ago(2), responseMs: 200, problem: null },
      },
      outside: { known: true, value: { ok: true, checkedAt: ago(2), problem: null } },
      certificate: { known: false, reason: 'No answer within 20 seconds' },
      updates: { known: true, value: 0 },
      updateWork: { toApprove: 0, held: 0, running: 0, noDownload: 0 },
    },
    handshake: {
      at: ago(60),
      result: {
        ok: true,
        hello: {
          ...hello,
          capabilities: { ...hello.capabilities, loopback: { ok: over.loopback ?? true } },
        },
      },
    },
    inventory: {
      known: true,
      value: {
        reportedAt: ago(20),
        wordpressCheckedAt: { core: null, plugins: null, themes: null },
        core: { version: '7.1', offer: null, vulnerabilities: [vuln(true)] },
        vulnerabilityData: {
          known: true,
          value: { fetchedAt: ago(30), stale: false, problem: null },
        },
        php: '8.3',
        database: '10.11',
        endOfLife: {},
        plugins: [
          {
            name: 'Elementor',
            vulnerabilities: Array.from({ length: over.vulns ?? 0 }, () => vuln()),
          },
        ],
        muPlugins: { known: true, value: [] },
        themes: [],
        siteHealth: (over.siteHealth ?? []).map((label) => ({ test: label, label })),
        lastFailure: null,
      },
    },
  } as unknown as SiteDetailResponse;
}

const backupsWith = (over: Partial<SiteBackupsResponse>): SiteBackupsResponse => ({
  backupExpectation: 'kamaji',
  download: null,
  wholeSite: null,
  canExport: true,
  exporting: null,
  latest: null,
  history: [],
  ...over,
});

const texts = (d: SiteDetailResponse, b: SiteBackupsResponse | null = null) =>
  siteLooks(d, b, NOW).map((l) => `${l.text} → ${l.action}`);

describe('Needs a look', () => {
  it('lists each problem on the page in a few words, with where to go', () => {
    expect(
      texts(
        detail({
          vulns: 44,
          siteHealth: ['Your site logs errors to a public file'],
          loopback: false,
        }),
      ),
    ).toEqual([
      'Certificate: check timed out → Inspect check',
      'Elementor: 44 known vulnerabilities → Review software',
      'Site Health: your site logs errors to a public file → Review software',
      'Connection: loopback blocked → Inspect connection',
    ]);
  });

  it('leaves out informational notes and healthy checks', () => {
    expect(texts(detail())).toEqual(['Certificate: check timed out → Inspect check']);
  });

  it('groups backup problems into one line that counts failures', () => {
    const entry = {
      batchId: null,
      runApprovedAt: null,
      exportedAt: null,
      bytes: null,
      sha256: null,
    };
    const b = backupsWith({
      history: [
        { ...entry, recordedAt: ago(5), state: 'failed', words: 'exit 1' },
        { ...entry, recordedAt: ago(DAY), state: 'exported', words: 'ok', exportedAt: ago(DAY) },
      ],
      wholeSite: {
        schedule: 'weekly',
        own: true,
        consentAt: null,
        consentBy: null,
        active: true,
        lastGoodAt: ago(3 * DAY),
        nextDueAt: ago(-3 * DAY),
        snapshots: [
          {
            startedAt: ago(DAY),
            finishedAt: ago(DAY),
            ok: false,
            bytes: null,
            addedBytes: null,
            databaseBytes: null,
            wordpress: null,
            problem: 'tar exited 2',
            forgotten: false,
          },
        ],
        restoreChecks: [
          { startedAt: ago(DAY), seconds: 80, ok: false, failedStep: 'wordpress', problem: 'x' },
        ],
        pending: { backup: null, restore: null },
        repository: null,
      },
    });
    expect(texts(detail(), b)).toContain('Backups: 3 failed checks → Review backups');
  });

  it('points an unset backup choice at Configure', () => {
    expect(texts(detail(), backupsWith({ backupExpectation: null, canExport: false }))).toContain(
      'Backups: not set for updates → Configure',
    );
  });
});
