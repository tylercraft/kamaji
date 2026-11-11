// Approving a batch, and what the app shows of batches (calcifer explore/kamaji.md, "Updating,
// end to end" and "Selecting and approving a batch"). The approval is stored with its exact
// scope; the updater (updater/) runs it. The app never holds the update key.
import { randomUUID } from 'node:crypto';
import type {
  ApproveRequest,
  ApproveResponse,
  BackupKind,
  BatchView,
  ComponentType,
} from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { recordEvent } from '../events.js';
import { updatableSites } from './queue.js';

const iso = (ms: number) => new Date(ms).toISOString();

const ORDER: Record<ComponentType, number> = { core: 0, plugin: 1, theme: 2 };

/**
 * Stores an approval, if every item is still exactly what WordPress offers and every site whose
 * backup is Tyler's word has it confirmed. `refresh` has each site's WordPress check for updates
 * first, so an offer that changed since the page was drawn goes back to review.
 */
export async function approveBatch(
  db: Db,
  request: ApproveRequest,
  login: string,
  now: () => number,
  refresh: (siteId: string) => Promise<boolean>,
): Promise<ApproveResponse> {
  const sites = new Map(updatableSites(db).map((s) => [s.id, s]));
  const siteIds = [...new Set(request.items.map((i) => i.siteId))];
  for (const id of siteIds) {
    const site = sites.get(id);
    if (!site || site.blocked) return { ok: false, changed: [id], needsBackup: [] };
    await refresh(id);
  }

  const changed: string[] = [];
  const names = new Map<string, string>();
  for (const i of request.items) {
    const row = db
      .prepare(
        `SELECT name, version, offer_version, offer_package FROM components
         WHERE site_id = ? AND type = ? AND item = ? AND gone_at IS NULL`,
      )
      .get(i.siteId, i.type, i.item);
    const busy = db
      .prepare(
        "SELECT 1 FROM batch_items WHERE site_id = ? AND type = ? AND item = ? AND state != 'done'",
      )
      .get(i.siteId, i.type, i.item);
    if (
      !row ||
      busy ||
      String(row.version) !== i.from ||
      row.offer_version !== i.to ||
      Number(row.offer_package) !== 1
    ) {
      changed.push(`${i.siteId} ${i.item}`);
    } else {
      names.set(`${i.siteId}\u0000${i.item}`, String(row.name));
    }
  }
  const needsBackup = siteIds.filter(
    (id) => sites.get(id)?.backupKind === 'tyler' && !request.confirmedBackups.includes(id),
  );
  if (changed.length > 0 || needsBackup.length > 0) return { ok: false, changed, needsBackup };

  const id = randomUUID();
  const at = now();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state)
       VALUES (?, ?, ?, ?, 'approved')`,
    ).run(id, at, login, request.oneSiteFirst ? 1 : 0);
    siteIds.forEach((siteId, position) => {
      const kind: BackupKind = sites.get(siteId)!.backupKind;
      db.prepare(
        `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state)
         VALUES (?, ?, ?, ?, ?, 'waiting')`,
      ).run(
        id,
        siteId,
        position,
        kind,
        kind === 'tyler' ? `Tyler confirmed a backup when approving, ${iso(at)}` : null,
      );
      const items = request.items
        .filter((i) => i.siteId === siteId)
        .sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.item.localeCompare(b.item));
      items.forEach((i, n) => {
        db.prepare(
          `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name,
             from_version, to_version, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`,
        ).run(
          randomUUID(),
          id,
          siteId,
          n,
          i.type,
          i.item,
          names.get(`${siteId}\u0000${i.item}`) ?? i.item,
          i.from,
          i.to,
        );
      });
    });
    recordEvent(db, at, {
      kind: 'batch.approved',
      summary: `Approved ${request.items.length} ${request.items.length === 1 ? 'update' : 'updates'} on ${siteIds.length} ${siteIds.length === 1 ? 'site' : 'sites'}`,
      resourceType: 'kamaji',
      resourceId: 'updates',
      detail: { batch: id, by: login },
    });
  });
  return { ok: true, batchId: id };
}

/** "I've looked, carry on": a held site's remaining items go back to the updater. */
export function carryOn(
  db: Db,
  batchId: string,
  siteId: string,
  login: string,
  at: number,
): boolean {
  const site = db
    .prepare('SELECT state FROM batch_sites WHERE batch_id = ? AND site_id = ?')
    .get(batchId, siteId);
  if (!site || site.state !== 'held') return false;
  transaction(db, () => {
    // The look is the decision: a failing baseline counts as accepted, and missing backup
    // evidence is recorded as carried on without it, rather than held again.
    db.prepare(
      `UPDATE batch_sites SET state = 'waiting', held_reason = NULL,
         baseline = CASE WHEN baseline IS NULL THEN NULL ELSE json_set(baseline, '$.accepted', json('true')) END,
         backup = COALESCE(backup, ?)
       WHERE batch_id = ? AND site_id = ?`,
    ).run(`Tyler carried on without fresh backup evidence, ${iso(at)}`, batchId, siteId);
    db.prepare(
      "UPDATE batch_items SET state = 'waiting' WHERE batch_id = ? AND site_id = ? AND state = 'held'",
    ).run(batchId, siteId);
    db.prepare("UPDATE batches SET state = 'approved', finished_at = NULL WHERE id = ?").run(
      batchId,
    );
    recordEvent(db, at, {
      kind: 'batch.carry-on',
      summary: `Carrying on with the held updates on ${siteName(db, siteId)}, after a look`,
      resourceType: 'site',
      resourceId: siteId,
      detail: { batch: batchId, by: login },
    });
  });
  return true;
}

function siteName(db: Db, id: string): string {
  return String(db.prepare('SELECT name FROM sites WHERE id = ?').get(id)?.name ?? id);
}

/** The most recent batches, newest first. */
export function batchViews(db: Db, limit = 10): BatchView[] {
  const batches = db.prepare('SELECT * FROM batches ORDER BY approved_at DESC LIMIT ?').all(limit);
  return batches.map((b) => {
    const id = String(b.id);
    const sites = db
      .prepare(
        `SELECT bs.*, s.name FROM batch_sites bs JOIN sites s ON s.id = bs.site_id
         WHERE bs.batch_id = ? ORDER BY bs.position`,
      )
      .all(id);
    return {
      id,
      approvedAt: iso(Number(b.approved_at)),
      state: String(b.state) as BatchView['state'],
      oneSiteFirst: Number(b.one_site_first) === 1,
      sites: sites.map((s) => ({
        siteId: String(s.site_id),
        siteName: String(s.name),
        state: String(s.state) as BatchView['sites'][number]['state'],
        heldReason: s.held_reason === null ? null : String(s.held_reason),
        backupKind: String(s.backup_kind) as BackupKind,
        backup: s.backup === null ? null : String(s.backup),
        items: db
          .prepare('SELECT * FROM batch_items WHERE batch_id = ? AND site_id = ? ORDER BY position')
          .all(id, String(s.site_id))
          .map((i) => ({
            id: String(i.id),
            type: String(i.type) as ComponentType,
            item: String(i.item),
            name: String(i.name),
            from: String(i.from_version),
            to: String(i.to_version),
            state: String(i.state) as BatchView['sites'][number]['items'][number]['state'],
            outcome:
              i.outcome === null
                ? null
                : (String(i.outcome) as BatchView['sites'][number]['items'][number]['outcome']),
            detail: i.detail === null ? null : String(i.detail),
          })),
      })),
    };
  });
}

/** Whether an approved batch still has work, for starting the updater after a restart. */
export function pendingWork(db: Db): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM batch_sites s JOIN batches b ON b.id = s.batch_id
         WHERE b.state IN ('approved', 'running') AND s.state IN ('waiting', 'running') LIMIT 1`,
      )
      .get() !== undefined
  );
}
