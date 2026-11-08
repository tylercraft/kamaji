// The jobs table. Every write that changes a running job is conditional on the caller still
// holding its lease, so a process that lost its lease (stalled, or presumed dead) can't
// overwrite what happened after.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  state: JobState;
  runAfter: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toJob(row: Row): Job {
  return {
    id: String(row.id),
    kind: String(row.kind),
    payload: JSON.parse(String(row.payload)),
    state: String(row.state) as JobState,
    runAfter: Number(row.run_after),
    createdAt: Number(row.created_at),
    startedAt: num(row.started_at),
    finishedAt: num(row.finished_at),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseUntil: num(row.lease_until),
  };
}

export interface EnqueueOptions {
  /** At most one queued or running job per key; a second enqueue returns null. */
  dedupeKey?: string;
  runAfter?: number;
  /** Supply an id when the caller must store it before the job runs (update jobs). */
  id?: string;
}

/** Adds a job. Returns its id, or null when a job with the same dedupe key is already pending. */
export function enqueue(
  db: Db,
  now: number,
  kind: string,
  payload: unknown = {},
  options: EnqueueOptions = {},
): string | null {
  const id = options.id ?? randomUUID();
  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (id, kind, dedupe_key, payload, run_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      options.dedupeKey ?? null,
      JSON.stringify(payload),
      options.runAfter ?? now,
      now,
    );
  return Number(changes) === 1 ? id : null;
}

/** Atomically takes the oldest due job of the given kinds and leases it to owner. */
export function claim(
  db: Db,
  now: number,
  owner: string,
  leaseMs: number,
  kinds: string[],
): Job | null {
  if (kinds.length === 0) return null;
  const placeholders = kinds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `UPDATE jobs SET state = 'running', started_at = ?, lease_owner = ?, lease_until = ?
       WHERE id = (
         SELECT id FROM jobs WHERE state = 'queued' AND run_after <= ? AND kind IN (${placeholders})
         ORDER BY run_after, created_at LIMIT 1
       ) AND state = 'queued'
       RETURNING *`,
    )
    .get(now, owner, now + leaseMs, now, ...kinds);
  return row ? toJob(row) : null;
}

/** Extends a lease. False means the lease was lost: stop working on the job. */
export function renew(db: Db, id: string, owner: string, until: number): boolean {
  const { changes } = db
    .prepare(
      `UPDATE jobs SET lease_until = ? WHERE id = ? AND lease_owner = ? AND state = 'running'`,
    )
    .run(until, id, owner);
  return Number(changes) === 1;
}

/** Records the end of a job. False means the lease was lost and nothing was written. */
export function finish(
  db: Db,
  now: number,
  id: string,
  owner: string,
  outcome:
    { state: 'succeeded'; result: unknown } | { state: 'failed' | 'interrupted'; error: string },
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE jobs SET state = ?, finished_at = ?, lease_until = NULL, result = ?, error = ?
       WHERE id = ? AND lease_owner = ? AND state = 'running'`,
    )
    .run(
      outcome.state,
      now,
      outcome.state === 'succeeded' ? JSON.stringify(outcome.result ?? null) : null,
      outcome.state === 'succeeded' ? null : outcome.error,
      id,
      owner,
    );
  return Number(changes) === 1;
}

/**
 * Marks running jobs whose lease has run out as interrupted: their process died or stalled.
 * Never re-queues them. Returns what it marked so the caller can log and recover each one.
 */
export function interruptExpired(db: Db, now: number): Job[] {
  return db
    .prepare(
      `UPDATE jobs SET state = 'interrupted', finished_at = ?, error = 'lease expired'
       WHERE state = 'running' AND lease_until < ?
       RETURNING *`,
    )
    .all(now, now)
    .map(toJob);
}

export function getJob(db: Db, id: string): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? toJob(row) : null;
}

/** The most recently started job of a kind (queued ones haven't happened yet). */
export function latestStartedJob(db: Db, kind: string): Job | null {
  const row = db
    .prepare(
      `SELECT * FROM jobs WHERE kind = ? AND started_at IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(kind);
  return row ? toJob(row) : null;
}
