// Proposed batches (TY-151): Calcifer's prepare_batch saves a selection from the current queue,
// with a note per item and optionally the site to run first. A proposal approves, starts and
// changes nothing else: Updates shows the latest one ticked, and Tyler reviews and approves it
// like any other selection (batches.ts). Proposing writes only the proposals table and one event.
import { createHash } from 'node:crypto';
import type { ProposalView, ProposeRequest, ProposeResponse, QueueItem } from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { recordEvent } from '../events.js';
import { queue } from './queue.js';

const itemKey = (i: { siteId: string; type: string; item: string; from: string; to: string }) =>
  [i.siteId, i.type, i.item, i.from, i.to].join('\u0000');

/** The queue as one value: any update added, gone, or with a new version changes it. */
export function queueFingerprint(items: QueueItem[]): string {
  return createHash('sha256').update(items.map(itemKey).sort().join('\n')).digest('hex');
}

/** Stores a proposal if every item is in the queue as it stands now, else says what isn't. */
export function proposeBatch(db: Db, request: ProposeRequest, at: number): ProposeResponse {
  const current = queue(db).items;
  const inQueue = new Set(current.map(itemKey));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const i of request.items) {
    const k = itemKey(i);
    const what = `${i.siteId} ${i.item} ${i.from} → ${i.to}`;
    if (seen.has(k)) problems.push(`${what} is listed twice`);
    else if (!inQueue.has(k)) problems.push(`${what} isn’t in the current queue`);
    seen.add(k);
  }
  const siteIds = new Set(request.items.map((i) => i.siteId));
  if (request.firstSite !== null && !siteIds.has(request.firstSite)) {
    problems.push(`the first site, ${request.firstSite}, has none of the proposed updates`);
  }
  if (problems.length > 0) return { ok: false, problems };

  let id = 0;
  transaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO proposals (created_at, proposed_by, queue, first_site, items)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        at,
        request.by,
        queueFingerprint(current),
        request.firstSite,
        JSON.stringify(
          request.items.map(({ siteId, type, item, from, to, note }) => ({
            siteId,
            type,
            item,
            from,
            to,
            note,
          })),
        ),
      );
    id = Number(row?.id);
    const n = request.items.length;
    recordEvent(db, at, {
      kind: 'batch.proposed',
      summary: `${request.by} proposed ${n} ${n === 1 ? 'update' : 'updates'} on ${siteIds.size} ${siteIds.size === 1 ? 'site' : 'sites'}, waiting for review`,
      resourceType: 'kamaji',
      resourceId: 'updates',
      detail: { proposal: id },
    });
  });
  return { ok: true, id };
}

/**
 * The latest proposal, unless a batch has been approved since (it was used, or set aside). Stale
 * when the queue it was made from isn't the queue now.
 */
export function latestProposal(db: Db, items: QueueItem[]): ProposalView | null {
  const row = db.prepare('SELECT * FROM proposals ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  const createdAt = Number(row.created_at);
  const approvedSince = db
    .prepare('SELECT 1 FROM batches WHERE approved_at > ? LIMIT 1')
    .get(createdAt);
  if (approvedSince) return null;
  return {
    id: Number(row.id),
    createdAt: new Date(createdAt).toISOString(),
    by: String(row.proposed_by),
    firstSite: row.first_site === null ? null : String(row.first_site),
    stale: String(row.queue) !== queueFingerprint(items),
    items: JSON.parse(String(row.items)) as ProposalView['items'],
  };
}
