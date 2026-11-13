// The Updates page's queue, arranged for ticking: by update (one row per component and version,
// with its sites) or by site (one row per site, with its updates, so a site's can be ticked
// together).
import type { QueueItem, QueueSite } from '@kamaji/shared';

export type Grouping = 'update' | 'site';

export const itemKey = (i: { siteId: string; type: string; item: string }) =>
  `${i.siteId}\u0000${i.type}\u0000${i.item}`;

/** "Akismet 5.3 → 5.7.2, 2 sites", in the queue's order. */
export function byUpdate(items: QueueItem[]): QueueItem[][] {
  const by = new Map<string, QueueItem[]>();
  for (const i of items) {
    const g = `${i.type}\u0000${i.item}\u0000${i.from}\u0000${i.to}`;
    by.set(g, [...(by.get(g) ?? []), i]);
  }
  return [...by.values()];
}

/** Each site's updates, sites in the queue's order. */
export function bySite(items: QueueItem[]): QueueItem[][] {
  const by = new Map<string, QueueItem[]>();
  for (const i of items) by.set(i.siteId, [...(by.get(i.siteId) ?? []), i]);
  return [...by.values()];
}

/**
 * The chosen sites whose backup is Tyler's word, not yet confirmed: the server refuses the
 * approval while any is left, so the button waits for them.
 */
export function needsBackup(siteIds: string[], sites: QueueSite[], confirmed: Set<string>) {
  return sites.filter(
    (s) => siteIds.includes(s.siteId) && s.backupKind === 'tyler' && !confirmed.has(s.siteId),
  );
}
