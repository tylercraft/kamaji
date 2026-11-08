// The Worker's outside checks (worker/): Kamaji sends it the list of public sites and pulls its
// results each cycle, recorded as observations with source 'worker'. Kamaji only calls out:
// the Worker never calls in.
//
// While the Worker is fresh, it announces public sites going down, so Kamaji doesn't (notify.ts).
// If it goes quiet (no pass for 20 minutes, or Kamaji can't reach it), Kamaji raises an urgent
// issue and takes the alerts back until it's fresh again.
import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { recordObservation } from '../observations.js';
import { readState, writeState } from '../state.js';

export const STALE_MS = 20 * 60 * 1000;

export interface OutsideResult {
  t: number;
  ok: boolean;
  status: number | null;
  ms: number | null;
  problem: string | null;
}

interface WorkerState {
  checkedAt: number | null;
  results: Record<string, { history: OutsideResult[] }>;
}

export interface OutsideState {
  /** Hash of the site list the Worker last accepted. */
  sitesHash: string | null;
  /** Newest result recorded per site, so each is recorded once. */
  seen: Record<string, number>;
  lastPullOkAt: number | null;
  /** When the Worker last ran a pass, by its own clock. */
  workerCheckedAt: number | null;
  /** When Kamaji first tried the Worker, so a first deploy gets the same grace. */
  firstTriedAt: number | null;
}

const KEY = 'outside';
const ISSUE = { resourceType: 'kamaji', resourceId: 'worker', kind: 'stale' } as const;

export function readOutside(db: Db): OutsideState {
  return (
    readState<OutsideState>(db, KEY) ?? {
      sitesHash: null,
      seen: {},
      lastPullOkAt: null,
      workerCheckedAt: null,
      firstTriedAt: null,
    }
  );
}

/** Fresh means the Worker ran a pass recently and Kamaji could read it. */
export function workerFresh(state: OutsideState, now: number): boolean {
  return (
    state.workerCheckedAt !== null &&
    state.lastPullOkAt !== null &&
    now - state.workerCheckedAt < STALE_MS &&
    now - state.lastPullOkAt < STALE_MS
  );
}

export interface OutsideClient {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

function publicSites(db: Db) {
  return db
    .prepare(
      `SELECT id, name, url, expected_text FROM sites
       WHERE removed_at IS NULL AND paused_at IS NULL AND setup = 'done' AND tailnet_only = 0
       ORDER BY id`,
    )
    .all()
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      url: String(r.url),
      expectedText: r.expected_text === null ? null : String(r.expected_text),
    }));
}

/** Sends the site list if it changed, pulls new results, and judges the Worker's freshness. */
export async function syncOutside(
  db: Db,
  client: OutsideClient,
  options: { now: () => number; signal: AbortSignal; log?: (m: string) => void },
): Promise<void> {
  const { now, signal } = options;
  const log = options.log ?? (() => {});
  const doFetch = client.fetch ?? fetch;
  const base = client.url.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' };
  const request = (path: string, init: RequestInit = {}) =>
    doFetch(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });

  const state = readOutside(db);
  const sites = publicSites(db);
  const body = JSON.stringify(sites);
  const hash = createHash('sha256').update(body).digest('hex');

  let pulled: WorkerState | null = null;
  try {
    if (hash !== state.sitesHash) {
      const response = await request('/v1/sites', { method: 'PUT', body });
      if (!response.ok) throw new Error(`sites: HTTP ${response.status}`);
      state.sitesHash = hash;
      log(`worker: sent ${sites.length} sites`);
    }
    const response = await request('/v1/results');
    if (!response.ok) throw new Error(`results: HTTP ${response.status}`);
    pulled = (await response.json()) as WorkerState;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    // The message is ours or fetch's name only: never the URL or the token.
    log(
      `worker: ${error instanceof Error && error.message.includes('HTTP') ? error.message : 'unreachable'}`,
    );
  }

  const at = now();
  state.firstTriedAt ??= at;
  transaction(db, () => {
    if (pulled) {
      state.lastPullOkAt = at;
      state.workerCheckedAt = typeof pulled.checkedAt === 'number' ? pulled.checkedAt : null;
      const known = new Set(sites.map((s) => s.id));
      for (const [id, result] of Object.entries(pulled.results ?? {})) {
        if (!known.has(id)) continue;
        const since = state.seen[id] ?? 0;
        for (const entry of result.history ?? []) {
          if (typeof entry.t !== 'number' || entry.t <= since) continue;
          recordObservation(db, {
            resourceType: 'site',
            resourceId: id,
            check: 'http',
            source: 'worker',
            at: entry.t,
            ok: entry.ok === true,
            value: entry,
          });
          state.seen[id] = Math.max(state.seen[id] ?? 0, entry.t);
        }
      }
    }
    writeState(db, KEY, state, at);

    if (workerFresh(state, at)) {
      clearIssue(db, at, ISSUE, 'The outside checks are running again');
    } else if (at - quietSince(state, at) >= STALE_MS) {
      raiseIssue(db, at, {
        ...ISSUE,
        severity: 'urgent',
        summary: pulled
          ? 'The outside checks have stopped running: Kamaji is alerting for sites instead'
          : 'Kamaji can’t reach the outside checks: it’s alerting for sites instead',
      });
    }
  });
}

/** Since when the outside checks have been out of sight: the older of the last pass and pull. */
function quietSince(state: OutsideState, at: number): number {
  if (state.lastPullOkAt === null || state.workerCheckedAt === null) {
    return state.firstTriedAt ?? at;
  }
  return Math.min(state.lastPullOkAt, state.workerCheckedAt);
}
