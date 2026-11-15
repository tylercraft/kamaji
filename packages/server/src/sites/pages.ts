// Pages to check: up to five of a site's own pages, each checked after every update as the home
// page is, with its own expected text. Stored in sites.important_pages as JSON,
// [{ "url": "https://…", "expectedText": "…" | null }]. The first shape was a list of path
// strings; those still read, as pages without expected text.
//
// A page must be on the site's own host (www or not) and https: the updater asks only the site
// it updated, never anywhere a typo or a pasted link points.
import type { CheckPage } from '@kamaji/shared';

export const MAX_PAGES = 5;

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** A page as typed (a path, or a full URL), as the absolute URL to check; null when it isn't allowed. */
export function pageUrl(input: string, siteUrl: string): string | null {
  const typed = input.trim();
  if (!typed) return null;
  let url: URL;
  try {
    url = new URL(typed, siteUrl);
  } catch {
    return null;
  }
  const site = new URL(siteUrl);
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (bare(url.hostname) !== bare(site.hostname) || url.port !== site.port) return null;
  url.hash = '';
  return url.href;
}

/** The stored list, either shape; an entry that's no longer allowed is left out. */
export function readPages(json: string, siteUrl: string): CheckPage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CheckPage[] = [];
  for (const entry of parsed) {
    const raw =
      typeof entry === 'string'
        ? { url: entry, expectedText: null }
        : entry && typeof entry === 'object' && typeof (entry as CheckPage).url === 'string'
          ? (entry as CheckPage)
          : null;
    const url = raw ? pageUrl(raw.url, siteUrl) : null;
    if (raw && url)
      out.push({
        url,
        expectedText:
          typeof raw.expectedText === 'string' && raw.expectedText ? raw.expectedText : null,
      });
  }
  return out.slice(0, MAX_PAGES);
}

/** The pages as Configure sent them, checked; the first one refused, when one is. */
export function checkPages(
  pages: { page: string; expectedText: string | null }[],
  siteUrl: string,
): { ok: true; pages: CheckPage[] } | { ok: false; refused: string } {
  const out: CheckPage[] = [];
  for (const p of pages) {
    if (!p.page.trim()) continue;
    const url = pageUrl(p.page, siteUrl);
    if (!url) return { ok: false, refused: p.page.trim() };
    if (out.some((o) => o.url === url)) continue;
    out.push({ url, expectedText: p.expectedText?.trim() || null });
  }
  if (out.length > MAX_PAGES) return { ok: false, refused: `more than ${MAX_PAGES} pages` };
  return { ok: true, pages: out };
}
