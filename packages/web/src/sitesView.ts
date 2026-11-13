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
