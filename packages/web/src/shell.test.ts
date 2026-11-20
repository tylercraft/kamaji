import type { StatusResponse } from '@kamaji/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anyPillRed, tabs } from './components/Shell';

describe('tabs', () => {
  it('has Passkeys as a tab, after Activity', () => {
    const paths = tabs.map((t) => t.path);
    expect(paths).toContain('/passkeys');
    expect(paths.indexOf('/passkeys')).toBe(paths.indexOf('/activity') + 1);
  });

  it('has Rules as a tab, after Updates', () => {
    const paths = tabs.map((t) => t.path);
    expect(paths.indexOf('/rules')).toBe(paths.indexOf('/updates') + 1);
  });
});

describe('the menu button’s red dot', () => {
  afterEach(() => vi.useRealTimers());
  const now = '2026-11-09T00:01:00.000Z';
  const fine: StatusResponse = {
    version: '0.1.0',
    commit: null,
    startedAt: '2026-11-09T00:00:00.000Z',
    now,
    cycle: {
      intervalSeconds: 300,
      last: { startedAt: now, finishedAt: now, state: 'succeeded' },
    },
    alerts: { configured: false },
    heartbeat: { configured: false },
  };
  const ready = (data: StatusResponse, refreshError: string | null = null) => ({
    state: 'ready' as const,
    data,
    loadedAt: 0,
    refreshError,
    reload: () => {},
  });

  it('shows only when a pill is red, not amber', () => {
    vi.useFakeTimers({ now: Date.parse(now) });
    // Heartbeat off is amber: no dot.
    expect(anyPillRed(ready(fine))).toBe(false);
    const failed = {
      ...fine,
      cycle: { ...fine.cycle, last: { ...fine.cycle.last!, state: 'failed' as const } },
    };
    expect(anyPillRed(ready(failed))).toBe(true);
  });

  it('shows when Kamaji can’t be reached, and not while it’s still loading', () => {
    expect(anyPillRed({ state: 'error', message: 'down', retry: () => {} })).toBe(true);
    expect(anyPillRed(ready(fine, 'Lost contact'))).toBe(true);
    expect(anyPillRed({ state: 'loading' })).toBe(false);
  });
});
