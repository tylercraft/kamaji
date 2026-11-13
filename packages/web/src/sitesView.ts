// The Sites page's filter: a site matches when its name, domain or client contains what's typed,
// ignoring case and the spaces around it. Nothing typed matches every site.
import type { Site } from '@kamaji/shared';

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
