// The Sites page's filter: a site matches when its name, domain or client contains what's typed,
// ignoring case and the spaces around it. Nothing typed matches every site.
import type { IconRefetchResponse, RecheckAllResponse, Site } from '@kamaji/shared';

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

/** Refetch icons' toast: how many sites gave one, and each that didn't, with why. */
export function refetchSummary(results: IconRefetchResponse['sites']): {
  ok: boolean;
  message: string;
} {
  const missing = results.filter((r) => !r.ok);
  if (missing.length === 0)
    return { ok: true, message: `Fetched icons for ${plural(results.length)}` };
  const named = missing.map((r) => `${r.name} (${r.problem ?? 'no icon'})`).join(', ');
  return {
    ok: false,
    message: `Fetched icons for ${results.length - missing.length} of ${plural(results.length)}. None from: ${named}`,
  };
}
