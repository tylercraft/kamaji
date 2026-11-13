// The Updates page's run history, two ways round: by site, each run whole (every component it
// changed, its backup, its outcome), or by component, each change linking to the run it was part
// of. Search matches a site, a component or a version; a run that matches stays whole.
import type { BatchSiteView, BatchView } from '@kamaji/shared';
import type { Tone } from './components/ui';

/** One site's part of one run. */
export interface SiteRun {
  batch: BatchView;
  site: BatchSiteView;
}

/** A stable anchor for a site's part of a run, for links from the component view. */
export const runAnchor = (r: { batchId: string; siteId: string }) =>
  `run-${r.batchId}-${r.siteId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

const text = (r: SiteRun) =>
  [r.site.siteName, ...r.site.items.flatMap((i) => [i.name, i.from, i.to])].join(' ').toLowerCase();

const matches = (r: SiteRun, typed: string) => {
  const q = typed.trim().toLowerCase();
  return q === '' || text(r).includes(q);
};

export function siteRuns(batches: BatchView[]): SiteRun[] {
  return batches.flatMap((batch) => batch.sites.map((site) => ({ batch, site })));
}

/** By site: each site's runs, newest first, whole. */
export function bySite(batches: BatchView[], typed: string) {
  const groups = new Map<string, { siteId: string; siteName: string; runs: SiteRun[] }>();
  for (const r of siteRuns(batches).filter((r) => matches(r, typed))) {
    const g = groups.get(r.site.siteId) ?? {
      siteId: r.site.siteId,
      siteName: r.site.siteName,
      runs: [],
    };
    g.runs.push(r);
    groups.set(r.site.siteId, g);
  }
  return [...groups.values()];
}

/** By component: every change to it, on any site, each with the run it belongs to. */
export function byComponent(batches: BatchView[], typed: string) {
  const q = typed.trim().toLowerCase();
  const groups = new Map<
    string,
    { name: string; changes: (SiteRun & { item: BatchSiteView['items'][number] })[] }
  >();
  for (const r of siteRuns(batches))
    for (const item of r.site.items) {
      const hay = `${r.site.siteName} ${item.name} ${item.from} ${item.to}`.toLowerCase();
      if (q !== '' && !hay.includes(q)) continue;
      const key = `${item.type}:${item.item}`;
      const g = groups.get(key) ?? { name: item.name, changes: [] };
      g.changes.push({ ...r, item });
      groups.set(key, g);
    }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A site's part of a run in a flag: held, failed or unverified items say so, never "done". */
export function runOutcome(site: BatchSiteView): { label: string; tone: Tone; problem: boolean } {
  if (site.state === 'held') return { label: 'Held', tone: 'red', problem: true };
  if (site.state === 'running') return { label: 'Running', tone: 'amber', problem: false };
  if (site.state === 'waiting') return { label: 'Waiting', tone: 'neutral', problem: false };
  const failed = site.items.filter(
    (i) => i.outcome === 'checks_failed' || i.outcome === 'update_failed',
  ).length;
  if (failed === site.items.length && failed > 0)
    return { label: 'Failed', tone: 'red', problem: true };
  if (failed > 0)
    return {
      label: `Partly failed: ${failed} of ${site.items.length}`,
      tone: 'red',
      problem: true,
    };
  if (site.items.some((i) => i.outcome !== 'passed'))
    return { label: 'Couldn’t verify', tone: 'amber', problem: true };
  return { label: 'Updated, checks passed', tone: 'green', problem: false };
}
