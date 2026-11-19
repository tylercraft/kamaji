// Asking for a rollback or an undo (the app, signed with Tyler's passkey each time), and how they
// stand, for the site's page. The row keeps the passkey's proof and the request as signed, which
// the backups process checks again before it takes what's asked (push.ts).
import type { RollbackView, SiteRollbackResponse } from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { recordEvent } from '../events.js';
import { newId, rollbackItems, rollbackOffer, undoOffer } from './offer.js';

const iso = (ms: number) => new Date(ms).toISOString();
type Row = Record<string, unknown>;

const siteName = (db: Db, siteId: string) =>
  String(db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId)?.name ?? siteId);

export type Asked =
  { ok: true; id: string } | { ok: false; error: 'not_offered' | 'stale'; why: string };

export function requestRollback(
  db: Db,
  siteId: string,
  ask: { batchId: string; withDatabase: boolean },
  by: string,
  now: number,
  /**
   * The proof and the body as signed (passkeys/guard.ts, Approval), as JSON. Without one the row
   * is written, but the backups process won't push it.
   */
  approval: string | null = null,
): Asked {
  const offer = rollbackOffer(db, siteId, now);
  if (!offer.ok) return { ok: false, error: 'not_offered', why: offer.why };
  if (offer.batchId !== ask.batchId)
    return { ok: false, error: 'stale', why: 'The run to roll back has changed; look again' };
  const id = newId();
  const p = offer.restorePoint;
  transaction(db, () => {
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by,
         with_database, snapshot_id, snapshot_at, export_time, database_at, state, approval)
       VALUES (?, 'rollback', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
    ).run(
      id,
      siteId,
      offer.batchId,
      offer.host,
      now,
      by,
      ask.withDatabase ? 1 : 0,
      p.snapshotId,
      p.snapshotAt,
      ask.withDatabase ? p.exportTime : null,
      ask.withDatabase ? p.databaseAt : null,
      approval,
    );
    const item = db.prepare(
      `INSERT INTO rollback_items (rollback_id, position, type, item, name, now_version, back_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    offer.items.forEach((i, n) => item.run(id, n, i.type, i.item, i.name, i.now, i.back));
    recordEvent(db, now, {
      kind: 'site.rollback-requested',
      summary: `${by} asked to roll back ${siteName(db, siteId)} (${offer.items.length} ${offer.items.length === 1 ? 'update' : 'updates'}${ask.withDatabase ? ', with the database' : ''})`,
      resourceType: 'site',
      resourceId: siteId,
      detail: { rollback: id, batch: offer.batchId },
    });
  });
  return { ok: true, id };
}

export function requestUndo(
  db: Db,
  siteId: string,
  ask: { rollbackId: string; withDatabase: boolean },
  by: string,
  now: number,
  /**
   * The proof and the body as signed (passkeys/guard.ts, Approval), as JSON. Without one the row
   * is written, but the backups process won't push it.
   */
  approval: string | null = null,
): Asked {
  const offer = undoOffer(db, siteId, now);
  if (!offer) return { ok: false, error: 'not_offered', why: 'There’s no rollback to undo' };
  if (!offer.ok) return { ok: false, error: 'not_offered', why: offer.why };
  if (offer.rollbackId !== ask.rollbackId)
    return { ok: false, error: 'stale', why: 'The rollback to undo has changed; look again' };
  if (ask.withDatabase && !offer.canDatabase)
    return { ok: false, error: 'not_offered', why: 'That rollback didn’t put the database back' };
  const r = db.prepare('SELECT * FROM rollbacks WHERE id = ?').get(offer.rollbackId)!;
  const id = newId();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO rollbacks (id, kind, undoes, site_id, batch_id, host, requested_at, requested_by,
         with_database, database_at, state, approval)
       VALUES (?, 'undo', ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
    ).run(
      id,
      offer.rollbackId,
      siteId,
      String(r.batch_id),
      String(r.host),
      now,
      by,
      ask.withDatabase ? 1 : 0,
      ask.withDatabase ? Number(r.finished_at) : null,
      approval,
    );
    const item = db.prepare(
      `INSERT INTO rollback_items (rollback_id, position, type, item, name, now_version, back_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // An undo puts back what the rollback replaced: its items the other way round.
    offer.items.forEach((i, n) => item.run(id, n, i.type, i.item, i.name, i.back, i.now));
    recordEvent(db, now, {
      kind: 'site.rollback-undo-requested',
      summary: `${by} asked to undo the rollback of ${siteName(db, siteId)}${ask.withDatabase ? ', with the database' : ''}`,
      resourceType: 'site',
      resourceId: siteId,
      detail: { rollback: offer.rollbackId, undo: id },
    });
  });
  return { ok: true, id };
}

/** Rollbacks and undos waiting for the backups process. */
export function rollbacksWaiting(db: Db): string[] {
  return db
    .prepare("SELECT id FROM rollbacks WHERE state = 'waiting' ORDER BY requested_at")
    .all()
    .map((r) => String(r.id));
}

function strings(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

export function rollbackView(db: Db, r: Row): RollbackView {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    kind: String(r.kind) as RollbackView['kind'],
    state: String(r.state) as RollbackView['state'],
    requestedAt: iso(Number(r.requested_at)),
    requestedBy: String(r.requested_by),
    finishedAt: r.finished_at === null ? null : iso(Number(r.finished_at)),
    withDatabase: Number(r.with_database) === 1,
    databaseAt: r.database_at === null ? null : iso(Number(r.database_at)),
    step: str(r.step),
    problem: str(r.problem),
    changed: str(r.changed),
    warnings: strings(r.warnings),
    checksOk: r.checks_ok === null ? null : Number(r.checks_ok) === 1,
    checksProblem: str(r.checks_problem),
    items: rollbackItems(db, String(r.id)).map(({ type, name, now, back }) => ({
      type,
      name,
      now,
      back,
    })),
  };
}

export function siteRollback(db: Db, siteId: string, now: number): SiteRollbackResponse {
  const offer = rollbackOffer(db, siteId, now);
  const undo = undoOffer(db, siteId, now);
  const latest = db
    .prepare(
      'SELECT * FROM rollbacks WHERE site_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1',
    )
    .get(siteId);
  return {
    offer: offer.ok
      ? {
          batchId: offer.batchId,
          runApprovedAt: iso(offer.approvedAt),
          snapshotAt: iso(offer.restorePoint.snapshotAt),
          databaseAt: iso(offer.restorePoint.databaseAt),
          databaseFrom: offer.restorePoint.exportTime ? 'export' : 'snapshot',
          items: offer.items.map(({ type, name, now: n, back }) => ({ type, name, now: n, back })),
          majorCore: offer.majorCore,
          prominent: offer.prominent,
        }
      : null,
    why: offer.ok ? null : offer.why,
    latest: latest ? rollbackView(db, latest) : null,
    undo: undo?.ok
      ? { rollbackId: undo.rollbackId, canDatabase: undo.canDatabase, until: iso(undo.until) }
      : null,
    undoWhy: undo && !undo.ok ? undo.why : null,
  };
}
