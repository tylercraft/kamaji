import type { BatchView } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { byComponent, bySite, runOutcome, updatesPollMs } from './runHistory';

const item = (name: string, outcome: 'passed' | 'checks_failed' = 'passed') => ({
  id: name,
  type: 'plugin' as const,
  item: `${name}/${name}.php`,
  name,
  from: '1.0',
  to: '1.1',
  state: 'done' as const,
  outcome,
  detail: null,
});

const batch = (id: string, sites: [string, ReturnType<typeof item>[]][]): BatchView => ({
  id,
  approvedAt: '2026-11-13T01:00:00Z',
  approvedBy: 'tyler',
  finishedAt: '2026-11-13T01:10:00Z',
  state: 'finished',
  oneSiteFirst: false,
  sites: sites.map(([siteId, items]) => ({
    siteId,
    siteName: siteId,
    state: 'done',
    startedAt: null,
    finishedAt: null,
    heldReason: null,
    backupKind: 'host',
    backup: null,
    items,
  })),
});

const batches = [
  batch('b2', [['minton', [item('Craftish Care'), item('MainWP Child')]]]),
  batch('b1', [
    ['aleya', [item('Craftish Care')]],
    ['minton', [item('Forms')]],
  ]),
];

describe('run history', () => {
  it('keeps a multi-component run whole when one component matches', () => {
    const g = bySite(batches, 'mainwp');
    expect(g).toHaveLength(1);
    expect(g[0]!.runs[0]!.site.items.map((i) => i.name)).toEqual(['Craftish Care', 'MainWP Child']);
  });

  it('groups by component across sites, each change with its run', () => {
    const g = byComponent(batches, '');
    const care = g.find((x) => x.name === 'Craftish Care')!;
    expect(care.changes.map((c) => [c.site.siteId, c.batch.id])).toEqual([
      ['minton', 'b2'],
      ['aleya', 'b1'],
    ]);
  });

  it('says a partly failed run is partly failed', () => {
    const r = batch('b', [['x', [item('A'), item('B', 'checks_failed')]]]);
    expect(runOutcome(r.sites[0]!).label).toBe('Partly failed: 1 of 2');
  });
});

describe('how often Updates asks again', () => {
  it('is quick only while a run is moving, not while it waits on Tyler', () => {
    const running = batch('r', [['x', [item('A')]]]);
    running.state = 'running';
    running.sites[0]!.state = 'running';
    expect(updatesPollMs({ batches: [running] })).toBe(5_000);
    running.sites[0]!.state = 'held';
    expect(updatesPollMs({ batches: [running] })).toBe(30_000);
    expect(updatesPollMs({ batches: batches })).toBe(30_000);
    expect(updatesPollMs(null)).toBe(30_000);
  });
});
