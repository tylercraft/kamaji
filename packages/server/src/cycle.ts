// The check cycle: every few minutes, one `cycle` job. In M1 it checks nothing yet; it proves the
// runner works and pings healthchecks.io. M2 adds the site and server checks in `runChecks`.
import type { Heartbeat } from './heartbeat.js';
import type { Handler } from './jobs/runner.js';

export const CYCLE = 'cycle';

export function cycleHandler(
  heartbeat: Heartbeat,
  runChecks: (signal: AbortSignal) => Promise<number> = async () => 0,
): Handler {
  return async (_job, { signal }) => {
    let checks: number;
    try {
      checks = await runChecks(signal);
    } catch (error) {
      if (!signal.aborted) await heartbeat.ping(false);
      throw error;
    }
    await heartbeat.ping(true, signal);
    return { checks };
  };
}
