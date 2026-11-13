import type { BatchView, Issue } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { groupIssues, recentOutcomes, siteNote, withoutName } from './overviewView';

const site = (id: string) => ({
  siteId: id,
  siteName: id,
  state: 'done' as const,
  startedAt: null,
  finishedAt: '2026-11-13T02:00:00Z',
  heldReason: null,
  backupKind: 'host' as const,
  backup: null,
  items: [
    {
      id: id,
      type: 'plugin' as const,
      item: 'cc/cc.php',
      name: 'Craftish Care',
      from: '0.2.1',
      to: '0.2.2',
      state: 'done' as const,
      outcome: 'passed' as const,
      detail: null,
    },
  ],
});

const run: BatchView = {
  id: 'b1',
  approvedAt: '2026-11-13T01:00:00Z',
  approvedBy: 'tyler',
  finishedAt: '2026-11-13T02:00:00Z',
  state: 'finished',
  oneSiteFirst: true,
  sites: [site('minton'), site('aleya')],
};

describe('recent outcomes', () => {
  it('says a run in a line, timed by when it finished, and links to it', () => {
    const [o] = recentOutcomes([run], []);
    expect(o).toMatchObject({
      title: 'Craftish Care updated on 2 sites',
      detail: 'minton, aleya · 0.2.1 → 0.2.2',
      label: 'Checks passed',
      atWords: 'Finished',
      at: '2026-11-13T02:00:00Z',
      href: '/updates#run-b1-minton',
    });
  });

  it('adds backup and restore events, newest first, and leaves others out', () => {
    const events = [
      {
        id: 1,
        at: '2026-11-13T03:00:00Z',
        kind: 'site.restore-check',
        summary: 'Restore passed',
        resourceType: 'site',
        resourceId: 'fl',
      },
      {
        id: 2,
        at: '2026-11-13T04:00:00Z',
        kind: 'site.renamed',
        summary: 'x',
        resourceType: 'site',
        resourceId: 'fl',
      },
    ];
    expect(recentOutcomes([run], events).map((o) => o.title)).toEqual([
      'Restore passed',
      'Craftish Care updated on 2 sites',
    ]);
  });
});

describe('findings by resource', () => {
  it('groups issues by what they’re about, urgent groups first', () => {
    const issue = (id: string, resourceId: string, severity: 'urgent' | 'normal'): Issue => ({
      id,
      resourceType: 'site',
      resourceId,
      kind: id,
      severity,
      summary: id,
      firstSeenAt: '2026-11-10T00:00:00Z',
      lastSeenAt: '2026-11-13T00:00:00Z',
    });
    const g = groupIssues([
      issue('a', 'minton', 'normal'),
      issue('b', 'fl', 'urgent'),
      issue('c', 'minton', 'normal'),
    ]);
    expect(g.map((x) => [x.id, x.issues.length])).toEqual([
      ['fl', 1],
      ['minton', 2],
    ]);
  });
});

describe('Overview wording', () => {
  it('drops the site name its group is headed by', () => {
    expect(withoutName('Minton Homes runs MySQL 5.7, past end of support', 'Minton Homes')).toBe(
      'Runs MySQL 5.7, past end of support',
    );
    expect(
      withoutName('First & Last Records’ whole-site backup failed', 'First & Last Records'),
    ).toBe('Whole-site backup failed');
    expect(withoutName('craftish: security updates waiting', 'craftish')).toBe(
      'Security updates waiting',
    );
    expect(withoutName('Something else', 'Minton Homes')).toBe('Something else');
  });

  it('says which counts overlap', () => {
    expect(
      siteNote({
        total: 14,
        connected: 2,
        monitoring: 12,
        paused: 1,
        unfinished: 0,
        down: 0,
        unchecked: 0,
      }),
    ).toBe('2 connected · 12 monitoring only · including 1 paused');
    expect(
      siteNote({
        total: 3,
        connected: 1,
        monitoring: 2,
        paused: 0,
        unfinished: 1,
        down: 1,
        unchecked: 0,
      }),
    ).toBe('1 connected · 2 monitoring only · including 1 with setup unfinished · 1 down');
  });
});
