import type { StatusResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { cycleHealth, heartbeatHealth } from './kamajiHealth';
import { relativeTime } from './time';

const base: StatusResponse = {
  version: '0.1.0',
  commit: null,
  startedAt: '2026-11-09T00:00:00.000Z',
  now: '2026-11-09T00:01:00.000Z',
  cycle: { intervalSeconds: 300, last: null },
  heartbeat: { configured: false },
};
const at = (iso: string) => Date.parse(iso);

describe('cycleHealth', () => {
  it('is pending just after start, and late if no cycle ever starts', () => {
    expect(cycleHealth(base).label).toBe('First cycle pending');
    expect(cycleHealth(base, at('2026-11-09T00:11:00.000Z'))).toMatchObject({
      tone: 'red',
      label: 'Cycle late',
    });
  });

  it('is late two intervals after the last cycle started, whatever its state', () => {
    const s: StatusResponse = {
      ...base,
      cycle: {
        intervalSeconds: 300,
        last: { startedAt: base.startedAt, finishedAt: base.startedAt, state: 'succeeded' },
      },
    };
    expect(cycleHealth(s, at('2026-11-09T00:04:00.000Z')).tone).toBe('green');
    expect(cycleHealth(s, at('2026-11-09T00:10:01.000Z')).label).toBe('Cycle late');
  });

  it('flags failed and interrupted cycles', () => {
    const last = { startedAt: base.startedAt, finishedAt: base.startedAt };
    expect(
      cycleHealth({ ...base, cycle: { intervalSeconds: 300, last: { ...last, state: 'failed' } } })
        .tone,
    ).toBe('red');
    expect(
      cycleHealth({
        ...base,
        cycle: { intervalSeconds: 300, last: { ...last, state: 'interrupted' } },
      }).tone,
    ).toBe('amber');
  });
});

describe('heartbeatHealth', () => {
  it('never reads as fine when off or failing', () => {
    expect(heartbeatHealth(base).tone).toBe('amber');
    const on = (lastOk: boolean | null): StatusResponse => ({
      ...base,
      heartbeat: { configured: true, lastAttemptAt: null, lastOk, lastSuccessAt: null },
    });
    expect(heartbeatHealth(on(null)).tone).toBe('neutral');
    expect(heartbeatHealth(on(false)).tone).toBe('red');
    expect(heartbeatHealth(on(true)).tone).toBe('green');
  });
});

describe('relativeTime', () => {
  const now = at('2026-11-09T12:00:00.000Z');
  it('reads naturally', () => {
    expect(relativeTime('2026-11-09T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-11-09T11:56:00.000Z', now)).toBe('4 min ago');
    expect(relativeTime('2026-11-09T09:00:00.000Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-08T12:00:00.000Z', now)).toBe('1 day ago');
  });
});
