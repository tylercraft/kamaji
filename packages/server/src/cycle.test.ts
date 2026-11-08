import { describe, expect, it } from 'vitest';
import { cycleHandler } from './cycle.js';
import type { Heartbeat } from './heartbeat.js';
import type { Job } from './jobs/store.js';

function recorder() {
  const pings: boolean[] = [];
  const heartbeat: Heartbeat = { configured: true, ping: async (ok) => void pings.push(ok) };
  return { pings, heartbeat };
}
const job = {} as Job;
const ctx = () => ({ signal: new AbortController().signal, now: Date.now });

describe('cycle', () => {
  it('pings after the checks pass', async () => {
    const { pings, heartbeat } = recorder();
    expect(await cycleHandler(heartbeat, async () => 3)(job, ctx())).toEqual({ checks: 3 });
    expect(pings).toEqual([true]);
  });

  it('pings /fail and rethrows when the checks throw', async () => {
    const { pings, heartbeat } = recorder();
    const run = cycleHandler(heartbeat, async () => {
      throw new Error('checks broke');
    });
    await expect(run(job, ctx())).rejects.toThrow('checks broke');
    expect(pings).toEqual([false]);
  });
});
