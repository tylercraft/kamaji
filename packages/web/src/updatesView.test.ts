import type { QueueItem, QueueSite } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import {
  bySite,
  byUpdate,
  itemKey,
  needsBackup,
  proposalTicks,
  rolledBackWords,
  routineItems,
} from './updatesView';

const item = (siteId: string, name: string, from = '1.0', to = '1.1'): QueueItem => ({
  siteId,
  siteName: siteId,
  type: 'plugin',
  item: `${name}/${name}.php`,
  name,
  from,
  to,
  security: false,
  fixes: 0,
  findings: 0,
  major: false,
});
const site = (siteId: string, backupKind: QueueSite['backupKind']): QueueSite => ({
  siteId,
  siteName: siteId,
  backupKind,
  blocked: null,
});

const items = [
  item('a', 'akismet'),
  item('b', 'akismet'),
  item('a', 'yoast'),
  item('b', 'yoast', '2.0'),
];

describe('the queue, grouped', () => {
  it('by update: one row per component and version', () => {
    expect(byUpdate(items).map((g) => g.map((i) => `${i.siteId} ${i.name} ${i.from}`))).toEqual([
      ['a akismet 1.0', 'b akismet 1.0'],
      ['a yoast 1.0'],
      ['b yoast 2.0'],
    ]);
  });

  it('by site: one row per site, with all its updates', () => {
    expect(bySite(items).map((g) => g.map((i) => `${i.siteId} ${i.name}`))).toEqual([
      ['a akismet', 'a yoast'],
      ['b akismet', 'b yoast'],
    ]);
  });
});

describe('the backups the approval waits for', () => {
  const sites = [site('a', 'tyler'), site('b', 'kamaji'), site('c', 'tyler')];

  it('is the chosen sites on your word, not yet confirmed', () => {
    expect(needsBackup(['a', 'b'], sites, new Set()).map((s) => s.siteId)).toEqual(['a']);
    expect(needsBackup(['a', 'b'], sites, new Set(['a']))).toEqual([]);
  });

  it('ignores sites that aren’t chosen', () => {
    expect(needsBackup(['b'], sites, new Set())).toEqual([]);
  });
});

describe('what a rollback put back', () => {
  const putBack = {
    ...item('a.test', 'menu', '1.15.2', '1.15.3'),
    rolledBackAt: '2026-11-19T02:00:00.000Z',
  };
  const major = { ...item('a.test', 'big', '1.0', '2.0'), major: true };
  const plain = item('b.test', 'akismet');

  it('is never routine', () => {
    expect(routineItems([putBack, major, plain])).toEqual([plain]);
  });

  it('isn’t ticked from a proposal; the rest of it is', () => {
    const ticks = proposalTicks([putBack, plain], [putBack, major, plain]);
    expect([...ticks]).toEqual([itemKey(plain)]);
  });

  it('says the day', () => {
    expect(rolledBackWords('2026-11-19T02:00:00.000Z')).toBe('Rolled back on 19 Nov');
  });
});
