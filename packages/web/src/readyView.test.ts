import type { ReadySite, ReadyToUpdate } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { readyHeader } from './readyView';

const at = '2026-11-17T14:15:00.000Z';
const failed = {
  state: 'failed',
  step: 'backup',
  problem: 'craftish: not on the allowlist',
  at,
} as const;
const update = { name: 'akismet', from: '5.3', to: '5.3.1', major: false, security: false };

function site(id: string, over: Partial<ReadySite>): ReadySite {
  return {
    siteId: id,
    siteName: id,
    backup: { state: 'export' },
    updates: [update],
    note: null,
    updatedAt: null,
    ...over,
  };
}

const ready = (sites: ReadySite[]): ReadyToUpdate => ({ for: at, sentAt: at, sites });

describe('Ready to update’s header', () => {
  it('a site still waiting with a failed backup counts', () => {
    expect(readyHeader(ready([site('a', { backup: failed }), site('b', {})]))).toEqual({
      failed: 1,
      what: 'A whole-site backup',
      waiting: 2,
    });
  });

  it('a site updated since, with an old failure and nothing left, doesn’t', () => {
    const header = readyHeader(
      ready([
        site('b', {}),
        site('a', { backup: failed, updates: [], updatedAt: '2026-11-17T21:50:00.000Z' }),
      ]),
    );
    expect(header).toMatchObject({ failed: 0, waiting: 1 });
  });

  it('a site updated partway, still waiting, still counts its failure', () => {
    const header = readyHeader(
      ready([site('a', { backup: failed, updatedAt: '2026-11-17T21:50:00.000Z' })]),
    );
    expect(header.failed).toBe(1);
  });
});
