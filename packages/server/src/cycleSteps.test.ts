import { describe, expect, it } from 'vitest';
import { cycleSteps } from './cycleSteps.js';

const block = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

describe('cycle step timing', () => {
  it('names a step that holds the event loop, and stays quiet for one that waits', async () => {
    const lines: string[] = [];
    const steps = cycleSteps((m) => lines.push(m), { slowMs: 10_000, heldMs: 200 });
    await steps.step('waits', () => new Promise((r) => setTimeout(r, 300)));
    await steps.step('blocks', () => block(400));
    steps.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^cycle: blocks took \d+ ms, held the event loop \d+ ms$/);
    const [waits, blocks] = steps.reports;
    expect(waits!.heldMs).toBeLessThan(200);
    expect(blocks!.heldMs).toBeGreaterThanOrEqual(300);
  });

  it('logs a slow step even when it never blocks', async () => {
    const lines: string[] = [];
    const steps = cycleSteps((m) => lines.push(m), { slowMs: 100, heldMs: 10_000 });
    await steps.step('slow', () => new Promise((r) => setTimeout(r, 150)));
    steps.stop();
    expect(lines[0]).toMatch(/^cycle: slow took \d+ ms/);
  });
});
