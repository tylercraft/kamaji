// The Sites page's filter and grouping. The filter: a site matches when its name, domain or client contains what's typed,
// ignoring case and the spaces around it. Nothing typed matches every site.
import type { HostKind, Platform, RecheckAllResponse, Site } from '@kamaji/shared';

export function matchesSite(
  site: Pick<Site, 'name' | 'url' | 'clientSlug'>,
  typed: string,
): boolean {
  const q = typed.trim().toLowerCase();
  if (q === '') return true;
  return [site.name, new URL(site.url).host, site.clientSlug ?? ''].some((field) =>
    field.toLowerCase().includes(q),
  );
}

export interface SiteFilters {
  typed: string;
  /** A host kind, or '' for all. */
  host: string;
  /** 'connected', 'monitoring', or '' for all. */
  mode: string;
}

export const NO_FILTERS: SiteFilters = { typed: '', host: '', mode: '' };

/** The Sites page's filters together: the text, the host and the mode must all match. */
export function filterSites<
  S extends Pick<Site, 'name' | 'url' | 'clientSlug' | 'hostKind' | 'mode'>,
>(sites: S[], f: SiteFilters): S[] {
  return sites.filter(
    (s) =>
      matchesSite(s, f.typed) &&
      (f.host === '' || s.hostKind === f.host) &&
      (f.mode === '' || s.mode === f.mode),
  );
}

/** The hosts and modes the sites actually have, for the filters' choices. */
export function present<S extends Pick<Site, 'hostKind' | 'mode'>>(sites: S[]) {
  return {
    hosts: [...new Set(sites.map((s) => s.hostKind))],
    modes: [...new Set(sites.map((s) => s.mode))],
  };
}

/** Sites Recheck all asks, by the server's rule: connected, set up and not paused. */
export const recheckable = (sites: Pick<Site, 'mode' | 'setup' | 'pausedAt'>[]) =>
  sites.filter((s) => s.mode === 'connected' && s.setup === 'done' && s.pausedAt === null).length;

const plural = (n: number) => `${n} site${n === 1 ? '' : 's'}`;

/** Recheck all's toast: how many were asked, and each that didn't report, with why. */
export function recheckSummary(results: RecheckAllResponse['sites']): {
  ok: boolean;
  message: string;
} {
  const failed = results.filter((r) => !r.ok);
  const done = `Rechecked ${plural(results.length)}`;
  if (failed.length === 0) return { ok: true, message: done };
  const named = failed.map((r) => `${r.name} (${r.problem ?? 'no report'})`).join(', ');
  return { ok: false, message: `${done}. ${plural(failed.length)} didn’t report: ${named}` };
}

// Grouping: by platform (the default), by host, or none. Remembered in this browser only; an
// empty, broken or blocked store means the default.

export type GroupBy = 'platform' | 'host' | 'none';
export const GROUP_BYS: { value: GroupBy; label: string }[] = [
  { value: 'platform', label: 'Platform' },
  { value: 'host', label: 'Host' },
  { value: 'none', label: 'None' },
];
const GROUP_KEY = 'kamaji.sites.groupBy';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readGroupBy(store: Store | null = storage()): GroupBy {
  try {
    const saved = store?.getItem(GROUP_KEY);
    return GROUP_BYS.some((g) => g.value === saved) ? (saved as GroupBy) : 'platform';
  } catch {
    return 'platform';
  }
}

export function saveGroupBy(value: GroupBy, store: Store | null = storage()): void {
  try {
    store?.setItem(GROUP_KEY, value);
  } catch {
    // Storage full or blocked: it holds until the page reloads.
  }
}

export const PLATFORM_NAMES: Record<Platform, string> = {
  wordpress: 'WordPress',
  static: 'Static',
  app: 'App',
};
const PLATFORM_ORDER: Platform[] = ['wordpress', 'static', 'app'];
export const HOST_NAMES: Record<HostKind, string> = {
  craftish: 'craftish',
  kinsta: 'Kinsta',
  wpengine: 'WP Engine',
  other: 'Other host',
};
const HOST_ORDER: HostKind[] = ['craftish', 'kinsta', 'wpengine', 'other'];

export interface SiteGroup<S> {
  key: string;
  /** Null when there's one group of everything (Group by: None). */
  label: string | null;
  sites: S[];
}

/** The sites in their groups, in a fixed order, each keeping the order it came in. No empty ones. */
export function groupSites<S extends Pick<Site, 'platform' | 'hostKind'>>(
  sites: S[],
  by: GroupBy,
): SiteGroup<S>[] {
  if (by === 'none') return sites.length > 0 ? [{ key: 'all', label: null, sites }] : [];
  const groups =
    by === 'platform'
      ? PLATFORM_ORDER.map((p) => ({
          key: p,
          label: PLATFORM_NAMES[p],
          sites: sites.filter((s) => s.platform === p),
        }))
      : HOST_ORDER.map((h) => ({
          key: h,
          label: HOST_NAMES[h],
          sites: sites.filter((s) => s.hostKind === h),
        }));
  return groups.filter((g) => g.sites.length > 0);
}
