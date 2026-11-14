// Times the cycle's steps and notices when one holds the event loop (TY-169): Kamaji has one
// thread and synchronous SQLite, so a step that blocks makes every page wait. A 50 ms timer
// measures the gaps between its own ticks; a long gap is time the loop was held, charged to the
// step running then. A step that takes long or holds the loop gets one log line: its name and
// milliseconds, nothing else.

export interface StepReport {
  step: string;
  ms: number;
  /** The longest the loop went without the timer ticking during the step. */
  heldMs: number;
}

const TICK_MS = 50;

export function cycleSteps(
  log: (message: string) => void,
  limits: { slowMs: number; heldMs: number } = { slowMs: 2_000, heldMs: 250 },
) {
  let lastTick = performance.now();
  let held = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    held = Math.max(held, now - lastTick - TICK_MS);
    lastTick = now;
  }, TICK_MS);
  timer.unref();
  const reports: StepReport[] = [];
  return {
    reports,
    async step<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      const start = performance.now();
      held = 0;
      lastTick = start;
      try {
        return await run();
      } finally {
        const end = performance.now();
        // The step's own last stretch, if it ended before the timer could tick.
        const report = {
          step: name,
          ms: Math.round(end - start),
          heldMs: Math.round(Math.max(held, end - lastTick - TICK_MS, 0)),
        };
        reports.push(report);
        if (report.ms >= limits.slowMs || report.heldMs >= limits.heldMs)
          log(`cycle: ${name} took ${report.ms} ms, held the event loop ${report.heldMs} ms`);
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}
