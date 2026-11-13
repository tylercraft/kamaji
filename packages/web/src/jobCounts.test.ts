import type { MacJob } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { jobCounts } from './pages/MolcajeteFacts';

const job = (name: string, over: Partial<MacJob> = {}): MacJob => ({
  name,
  label: `dev.craftish.calcifer.${name}`,
  state: 'idle',
  keepAlive: false,
  schedule: null,
  lastExitCode: 0,
  runs: null,
  lastRunAt: null,
  fullText: false,
  attention: null,
  ...over,
});

describe('the jobs summary', () => {
  it('counts states without calling idle or exit 0 a success, and keeps no-history apart', () => {
    const jobs = [
      job('a', { state: 'running', lastRunAt: '2026-11-13T00:00:00Z' }),
      job('b', { attention: 'Exited 1', lastExitCode: 1 }),
      job('c'),
      job('d', { state: 'not-loaded', lastExitCode: null }),
    ];
    expect(jobCounts(jobs, (j) => (j.name === 'c' ? 2 : 0))).toBe(
      '4 jobs · 2 to look at · 1 running · 2 idle · 1 not loaded · 3 not seen running yet',
    );
  });
});
