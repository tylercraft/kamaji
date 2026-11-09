// Abandoned plugins, from the wordpress.org plugins API (calcifer explore/kamaji.md,
// "Vulnerabilities"): a plugin closed on wordpress.org never shows an update, so the site's own
// update check can't say it's dead. Each installed slug is looked up at most once a day, a few
// per cycle. Only slugs are sent, never which site has them; the sites send WordPress the same
// list themselves when they check for updates.
import type { DirectoryStatus } from '@kamaji/shared';
import type { Db } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';

export const LOOKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const LOOKUPS_PER_CYCLE = 20;
export const ABANDONED_KIND = 'abandoned:';

const API = 'https://api.wordpress.org/plugins/info/1.2/';
// Leave out the heavy fields: only the version, dates and closure matter here.
const SKIP = [
  'sections',
  'description',
  'reviews',
  'banners',
  'icons',
  'screenshots',
  'versions',
  'contributors',
  'tags',
  'donate_link',
  'ratings',
];

export function lookupUrl(slug: string): URL {
  const url = new URL(API);
  url.searchParams.set('action', 'plugin_information');
  url.searchParams.set('request[slug]', slug);
  for (const field of SKIP) url.searchParams.set(`request[fields][${field}]`, '0');
  return url;
}

export interface DirectoryRow {
  status: 'listed' | 'closed' | 'not-listed';
  latestVersion: string | null;
  lastUpdated: number | null;
  tested: string | null;
  closedDate: string | null;
  closedReason: string | null;
}

/** wordpress.org's "2026-08-18 11:42pm GMT", as milliseconds. */
export function parseLastUpdated(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d{1,2}):(\d\d)(am|pm) GMT$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, ap] = m;
  const hour = (Number(h) % 12) + (ap === 'pm' ? 12 : 0);
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi));
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

/** One answer, or null when it isn't one of the three known shapes (keep what was known). */
export function parseDirectory(status: number, body: unknown): DirectoryRow | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (status === 200 && typeof b.slug === 'string' && typeof b.version === 'string') {
    return {
      status: 'listed',
      latestVersion: b.version,
      lastUpdated: parseLastUpdated(b.last_updated),
      tested: str(b.tested),
      closedDate: null,
      closedReason: null,
    };
  }
  if (b.error === 'closed' || b.closed === true) {
    return {
      status: 'closed',
      latestVersion: null,
      lastUpdated: null,
      tested: null,
      closedDate: str(b.closed_date),
      closedReason: str(b.reason_text) ?? str(b.reason),
    };
  }
  if (status === 404 && b.error === 'Plugin not found.') {
    return {
      status: 'not-listed',
      latestVersion: null,
      lastUpdated: null,
      tested: null,
      closedDate: null,
      closedReason: null,
    };
  }
  return null;
}

function storeDirectory(db: Db, slug: string, row: DirectoryRow, now: number): void {
  db.prepare(
    `INSERT INTO plugin_directory (slug, status, latest_version, last_updated, tested, closed_date,
       closed_reason, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET status = excluded.status,
       latest_version = excluded.latest_version, last_updated = excluded.last_updated,
       tested = excluded.tested, closed_date = excluded.closed_date,
       closed_reason = excluded.closed_reason, checked_at = excluded.checked_at`,
  ).run(
    slug,
    row.status,
    row.latestVersion,
    row.lastUpdated,
    row.tested,
    row.closedDate,
    row.closedReason,
    now,
  );
}

export function directoryStatus(db: Db, slug: string): DirectoryStatus | null {
  const r = db.prepare('SELECT * FROM plugin_directory WHERE slug = ?').get(slug);
  if (!r) return null;
  const checkedAt = new Date(Number(r.checked_at)).toISOString();
  if (r.status === 'listed') {
    return {
      status: 'listed',
      latestVersion: r.latest_version === null ? null : String(r.latest_version),
      lastUpdated: r.last_updated === null ? null : new Date(Number(r.last_updated)).toISOString(),
      tested: r.tested === null ? null : String(r.tested),
      checkedAt,
    };
  }
  if (r.status === 'closed') {
    return {
      status: 'closed',
      closedDate: r.closed_date === null ? null : String(r.closed_date),
      reason: r.closed_reason === null ? null : String(r.closed_reason),
      checkedAt,
    };
  }
  return { status: 'not-listed', checkedAt };
}

/** Installed plugin slugs that wordpress.org hasn't been asked about in a day, oldest first. */
function dueSlugs(db: Db, now: number, limit: number): string[] {
  return db
    .prepare(
      `SELECT DISTINCT c.slug FROM components c
       JOIN sites s ON s.id = c.site_id AND s.removed_at IS NULL
       LEFT JOIN plugin_directory d ON d.slug = c.slug
       WHERE c.type = 'plugin' AND c.gone_at IS NULL AND c.slug IS NOT NULL
       AND (d.checked_at IS NULL OR d.checked_at <= ?)
       ORDER BY COALESCE(d.checked_at, 0), c.slug LIMIT ?`,
    )
    .all(now - LOOKUP_EVERY_MS, limit)
    .map((r) => String(r.slug));
}

/** Looks up what's due, then judges every installed plugin. Returns how many were looked up. */
export async function checkDirectory(
  db: Db,
  options: { now: () => number; signal: AbortSignal; fetch?: typeof fetch },
): Promise<number> {
  const doFetch = options.fetch ?? fetch;
  let looked = 0;
  for (const slug of dueSlugs(db, options.now(), LOOKUPS_PER_CYCLE)) {
    if (options.signal.aborted) break;
    try {
      const response = await doFetch(lookupUrl(slug), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
      });
      const row = parseDirectory(response.status, await response.json().catch(() => null));
      if (row) {
        storeDirectory(db, slug, row, options.now());
        looked += 1;
      }
    } catch (error) {
      if (options.signal.aborted) throw error;
      // wordpress.org unreachable: what was known stays, and the next cycle tries again.
    }
  }
  judgeAbandoned(db, options.now());
  return looked;
}

/**
 * One issue per site and closed plugin. Closed for a security issue is urgent; any other
 * closure waits for the digest. Resolved when the plugin is gone from the site or listed again.
 */
export function judgeAbandoned(db: Db, now: number): void {
  const closed = db
    .prepare(
      `SELECT c.site_id, c.slug, c.name, s.name AS site_name, d.closed_date, d.closed_reason
       FROM components c JOIN sites s ON s.id = c.site_id AND s.removed_at IS NULL
       JOIN plugin_directory d ON d.slug = c.slug AND d.status = 'closed'
       WHERE c.type = 'plugin' AND c.gone_at IS NULL`,
    )
    .all();
  const still = new Set<string>();
  for (const r of closed) {
    const kind = `${ABANDONED_KIND}${String(r.slug)}`;
    still.add(`${String(r.site_id)}\u0000${kind}`);
    const reason = r.closed_reason === null ? '' : ` (${String(r.closed_reason)})`;
    raiseIssue(db, now, {
      resourceType: 'site',
      resourceId: String(r.site_id),
      kind,
      severity: /security/i.test(String(r.closed_reason ?? '')) ? 'urgent' : 'normal',
      // Discord sees summaries: the site and the reason, never which plugin (a target list).
      summary: `${String(r.site_name)}: an installed plugin was closed on wordpress.org${reason}`,
    });
  }
  const open = db
    .prepare(
      `SELECT resource_id, kind FROM issues WHERE resource_type = 'site' AND kind LIKE ?
       AND resolved_at IS NULL`,
    )
    .all(`${ABANDONED_KIND}%`);
  for (const r of open) {
    const key = `${String(r.resource_id)}\u0000${String(r.kind)}`;
    if (still.has(key)) continue;
    clearIssue(
      db,
      now,
      { resourceType: 'site', resourceId: String(r.resource_id), kind: String(r.kind) },
      `${String(r.kind).slice(ABANDONED_KIND.length)} is no longer a closed plugin on that site`,
    );
  }
}
