// The dead-man switch: after each check cycle Kamaji pings healthchecks.io, which emails and
// posts to Discord when the pings stop. The ping URL is a secret (anyone with it can fake a
// heartbeat), so it lives only in this closure: never logged, never in an error, never in the DB.
import type { Db } from './db.js';
import { recordEvent } from './events.js';
import { readState, writeState } from './state.js';

export interface HeartbeatState {
  lastAttemptAt: number;
  lastOk: boolean;
  lastSuccessAt: number | null;
}

export interface Heartbeat {
  configured: boolean;
  /** Reports a cycle's result: ok pings the check, not ok pings its /fail endpoint. */
  ping(ok: boolean, signal?: AbortSignal): Promise<void>;
}

const KEY = 'heartbeat';

export function readHeartbeat(db: Db): HeartbeatState | null {
  return readState<HeartbeatState>(db, KEY);
}

/** Returns the URL if it's a usable https URL, otherwise undefined. */
export function parsePingUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export function createHeartbeat(
  db: Db,
  url: URL | undefined,
  options: {
    now?: () => number;
    fetch?: typeof fetch;
    log?: (message: string) => void;
    timeoutMs?: number;
  } = {},
): Heartbeat {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (!url) return { configured: false, ping: async () => {} };

  const okUrl = url.href;
  const failUrl = `${url.href.replace(/\/$/, '')}/fail`;

  return {
    configured: true,
    async ping(ok, signal) {
      const at = now();
      let delivered = false;
      let problem = '';
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await doFetch(ok ? okUrl : failUrl, {
          method: 'POST',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        delivered = response.ok;
        if (!delivered) problem = `HTTP ${response.status}`;
      } catch (error) {
        // Name only: some fetch errors carry the URL in their message or cause.
        problem = error instanceof Error ? error.name : 'error';
      }

      const before = readHeartbeat(db);
      writeState(
        db,
        KEY,
        {
          lastAttemptAt: at,
          lastOk: delivered,
          lastSuccessAt: delivered ? at : (before?.lastSuccessAt ?? null),
        } satisfies HeartbeatState,
        at,
      );
      if (!delivered) log(`heartbeat ping failed: ${problem}`);
      if (before && before.lastOk !== delivered) {
        recordEvent(db, at, {
          kind: delivered ? 'heartbeat.recovered' : 'heartbeat.failed',
          summary: delivered
            ? 'healthchecks.io is hearing from Kamaji again'
            : `Kamaji couldn't reach healthchecks.io (${problem})`,
        });
      }
    },
  };
}
