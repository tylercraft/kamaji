import type { QueueItem, QueueSite } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { bySite, byUpdate, needsBackup } from './updatesView';

const item = (siteId: string, name: string, from = '1.0', to = '1.1'): QueueItem => ({
  siteId,
  siteName: siteId,
  type: 'plugin',
  item: `${name}/${name}.php`,
  name,
  from,
  to,
  security: false,
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
