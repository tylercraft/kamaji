// Known vulnerabilities from Wordfence Intelligence's v3 production feed (calcifer
// explore/kamaji.md, "Vulnerabilities"): downloaded once a day with WORDFENCE_API_KEY, the whole
// feed, so nothing about the sites is sent; matched here against each site's components. A known
// vulnerability with a fix is urgent; one without is shown with Wordfence's advice. A feed that
// failed or went stale says so: it never reads as "no vulnerabilities".
//
// The record shape is as downloaded on the mini (2026-11-09: 43,741 records, none skipped):
// fixtures/feed.json holds four real records from it. Ranges are matched on from_version,
// from_inclusive, to_version and to_inclusive, never on their labels.
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type { Db } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { readState, writeState } from '../state.js';
import { inRange, compareVersions, type VersionRange } from './version.js';

export const FEED_URL = 'https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production';
export const DOWNLOAD_EVERY_MS = 24 * 60 * 60 * 1000;
/** After a failed download, wait this long before trying again: the feed is rate-limited. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** Older than this, the data is stale and says so. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const FEED_STATE = 'wordfence';
export const VULNERABLE_KIND = 'vulnerable:';

const Range = z.object({
  from_version: z.string(),
  from_inclusive: z.boolean(),
  to_version: z.string(),
  to_inclusive: z.boolean(),
});

const Software = z.object({
  type: z.enum(['core', 'plugin', 'theme']),
  slug: z.string().min(1),
  name: z.string().optional(),
  // An object keyed by a label like "* - 1.2.3", or a list: the values are what count.
  affected_versions: z.union([z.record(z.string(), Range), z.array(Range)]),
  patched: z.boolean().optional(),
  patched_versions: z.array(z.string()).optional(),
  remediation: z.string().nullable().optional(),
});

const FeedRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  software: z.array(z.unknown()),
  cve: z.string().nullable().optional(),
  cvss: z
    .object({ score: z.number().nullable().optional(), rating: z.string().nullable().optional() })
    .nullable()
    .optional(),
  references: z.array(z.unknown()).optional(),
  informational: z.boolean().optional(),
  published: z.string().nullable().optional(),
});

export interface VulnerabilityRow {
  id: string;
  softwareType: 'core' | 'plugin' | 'theme';
  slug: string;
  softwareName: string | null;
  title: string;
  /** A general note rather than a defect an update fixes: shown, never raised as an issue. */
  informational: boolean;
  affected: VersionRange[];
  patched: boolean;
  patchedVersions: string[];
  remediation: string | null;
  cve: string | null;
  cvssScore: number | null;
  cvssRating: string | null;
  reference: string | null;
  published: string | null;
}

export interface FeedState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  problem: string | null;
  records: number;
  /** Records or software entries in a shape Kamaji doesn't know, left out rather than guessed. */
  skipped: number;
}

/** The feed as rows. A malformed record is skipped and counted, never half-read. */
export function parseFeed(feed: unknown): {
  rows: VulnerabilityRow[];
  records: number;
  skipped: number;
} {
  const values = Array.isArray(feed)
    ? feed
    : feed && typeof feed === 'object'
      ? Object.values(feed)
      : null;
  if (!values) throw new Error('not a feed');
  const rows: VulnerabilityRow[] = [];
  let skipped = 0;
  let records = 0;
  for (const value of values) {
    const record = FeedRecord.safeParse(value);
    if (!record.success) {
      skipped += 1;
      continue;
    }
    records += 1;
    const r = record.data;
    const reference =
      r.references?.find(
        (x): x is string => typeof x === 'string' && x.includes('wordfence.com/threat-intel'),
      ) ?? null;
    for (const raw of r.software) {
      const software = Software.safeParse(raw);
      if (!software.success) {
        skipped += 1;
        continue;
      }
      const s = software.data;
      rows.push({
        id: r.id,
        softwareType: s.type,
        slug: s.slug,
        softwareName: s.name ?? null,
        title: r.title,
        informational: r.informational === true,
        affected: Object.values(s.affected_versions),
        patched: s.patched === true,
        patchedVersions: s.patched_versions ?? [],
        remediation: s.remediation ?? null,
        cve: r.cve ?? null,
        cvssScore: r.cvss?.score ?? null,
        cvssRating: r.cvss?.rating ?? null,
        reference,
        published: r.published ?? null,
      });
    }
  }
  return { rows: mergeDuplicates(rows), records, skipped };
}

/**
 * A record can list one product several times, one entry per release line, each with its own
 * range and fix (20 in the 2026-11-09 feed). They become one row with every range and fix.
 */
function mergeDuplicates(rows: VulnerabilityRow[]): VulnerabilityRow[] {
  const merged = new Map<string, VulnerabilityRow>();
  for (const row of rows) {
    const key = `${row.id}\u0000${row.softwareType}\u0000${row.slug}`;
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, {
        ...row,
        affected: [...row.affected],
        patchedVersions: [...row.patchedVersions],
      });
      continue;
    }
    seen.affected.push(...row.affected);
    seen.patchedVersions.push(
      ...row.patchedVersions.filter((v) => !seen.patchedVersions.includes(v)),
    );
    seen.patched = seen.patched || row.patched;
  }
  return [...merged.values()];
}

function storeFeed(db: Db, rows: VulnerabilityRow[]): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM vulnerabilities');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO vulnerabilities (id, software_type, slug, software_name, title,
         informational, affected, patched, patched_versions, remediation, cve, cvss_score, cvss_rating,
         reference, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.softwareType,
        r.slug,
        r.softwareName,
        r.title,
        r.informational ? 1 : 0,
        JSON.stringify(r.affected),
        r.patched ? 1 : 0,
        JSON.stringify(r.patchedVersions),
        r.remediation,
        r.cve,
        r.cvssScore,
        r.cvssRating,
        r.reference,
        r.published,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readFeedState(db: Db): FeedState {
  return (
    readState<FeedState>(db, FEED_STATE) ?? {
      lastAttemptAt: null,
      lastSuccessAt: null,
      problem: null,
      records: 0,
      skipped: 0,
    }
  );
}

export function feedDue(state: FeedState, now: number): boolean {
  if (state.lastSuccessAt !== null && now - state.lastSuccessAt < DOWNLOAD_EVERY_MS) return false;
  if (state.problem && state.lastAttemptAt !== null && now - state.lastAttemptAt < RETRY_AFTER_MS) {
    return false;
  }
  return true;
}

function problemFor(status: number): string {
  if (status === 401 || status === 403) return `Wordfence refused the API key (HTTP ${status})`;
  if (status === 429) return 'Wordfence is rate-limiting the feed (HTTP 429)';
  return `Wordfence answered HTTP ${status}`;
}

/** Downloads the feed to `path` (streamed, then renamed into place), or says why not. */
async function download(
  apiKey: string,
  path: string,
  options: { fetch: typeof fetch; signal: AbortSignal },
): Promise<string | null> {
  let response: Response;
  try {
    response = await options.fetch(FEED_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(5 * 60_000)]),
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    return 'Couldn’t reach Wordfence';
  }
  if (!response.ok || !response.body) return problemFor(response.status);
  const partial = `${path}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      createWriteStream(partial, { mode: 0o600 }),
    );
    await rename(partial, path);
    return null;
  } catch (error) {
    await rm(partial, { force: true });
    if (options.signal.aborted) throw error;
    return 'The download from Wordfence broke off';
  }
}

/**
 * The cycle's part: download when due (or load `localFile` instead, for testing on the laptop),
 * then match. Without a key or file, matching still runs on whatever was stored before.
 */
export async function checkWordfence(
  db: Db,
  options: {
    apiKey: string | undefined;
    feedPath: string;
    localFile?: string | undefined;
    now: () => number;
    signal: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<void> {
  const state = readFeedState(db);
  if ((options.apiKey || options.localFile) && feedDue(state, options.now())) {
    const at = options.now();
    let problem: string | null = null;
    let parsed: ReturnType<typeof parseFeed> | null = null;
    if (!options.localFile) {
      problem = await download(options.apiKey!, options.feedPath, {
        fetch: options.fetch ?? fetch,
        signal: options.signal,
      });
    }
    if (!problem) {
      try {
        parsed = parseFeed(
          JSON.parse(await readFile(options.localFile ?? options.feedPath, 'utf8')),
        );
        if (parsed.records === 0) problem = 'The feed had no records Kamaji could read';
      } catch {
        problem = 'The feed wasn’t readable JSON';
      }
    }
    if (!problem && parsed) {
      storeFeed(db, parsed.rows);
      writeState(
        db,
        FEED_STATE,
        {
          lastAttemptAt: at,
          lastSuccessAt: at,
          problem: null,
          records: parsed.records,
          skipped: parsed.skipped,
        },
        at,
      );
    } else {
      writeState(db, FEED_STATE, { ...state, lastAttemptAt: at, problem }, at);
    }
  }
  judgeFeed(db, options.now(), Boolean(options.apiKey || options.localFile));
  judgeVulnerabilities(db, options.now());
}

/** A feed that failed or went stale is an issue, for the digest. */
function judgeFeed(db: Db, now: number, configured: boolean): void {
  const key = { resourceType: 'kamaji', resourceId: 'wordfence', kind: 'feed-stale' } as const;
  const state = readFeedState(db);
  const fresh = state.lastSuccessAt !== null && now - state.lastSuccessAt < STALE_AFTER_MS;
  if (!configured || fresh) {
    if (fresh) clearIssue(db, now, key, 'The Wordfence vulnerability data is current again');
    return;
  }
  if (state.lastAttemptAt === null) return;
  const days =
    state.lastSuccessAt === null ? null : Math.floor((now - state.lastSuccessAt) / 86_400_000);
  raiseIssue(db, now, {
    ...key,
    severity: 'normal',
    summary:
      days === null
        ? `No Wordfence vulnerability data yet: ${state.problem ?? 'the download failed'}`
        : `The Wordfence vulnerability data is ${days} days old: ${state.problem ?? 'the download failed'}`,
  });
}

export interface Match {
  siteId: string;
  siteName: string;
  type: 'core' | 'plugin' | 'theme';
  item: string;
  slug: string;
  version: string;
  vulnerability: VulnerabilityRow;
  /** The lowest patched version above what's installed, if Wordfence knows one. */
  fixedIn: string | null;
}

function toRow(r: Record<string, unknown>): VulnerabilityRow {
  return {
    id: String(r.id),
    softwareType: String(r.software_type) as VulnerabilityRow['softwareType'],
    slug: String(r.slug),
    softwareName: r.software_name === null ? null : String(r.software_name),
    title: String(r.title),
    informational: Number(r.informational) === 1,
    affected: JSON.parse(String(r.affected)) as VersionRange[],
    patched: Number(r.patched) === 1,
    patchedVersions: JSON.parse(String(r.patched_versions)) as string[],
    remediation: r.remediation === null ? null : String(r.remediation),
    cve: r.cve === null ? null : String(r.cve),
    cvssScore: r.cvss_score === null ? null : Number(r.cvss_score),
    cvssRating: r.cvss_rating === null ? null : String(r.cvss_rating),
    reference: r.reference === null ? null : String(r.reference),
    published: r.published === null ? null : String(r.published),
  };
}

/** Every installed component a stored vulnerability affects, on sites still in Kamaji. */
export function matches(db: Db, siteId?: string): Match[] {
  const rows = db
    .prepare(
      `SELECT c.site_id, s.name AS site_name, c.type, c.item, c.slug, c.version, v.*
       FROM components c JOIN sites s ON s.id = c.site_id AND s.removed_at IS NULL
       JOIN vulnerabilities v ON v.software_type = c.type
         AND (c.type = 'core' OR v.slug = c.slug)
       WHERE c.gone_at IS NULL ${siteId ? 'AND c.site_id = ?' : ''}`,
    )
    .all(...(siteId ? [siteId] : []));
  const found: Match[] = [];
  for (const r of rows) {
    const vulnerability = toRow(r);
    const version = String(r.version);
    if (!vulnerability.affected.some((range) => inRange(version, range))) continue;
    const fixes = vulnerability.patchedVersions
      .filter((v) => compareVersions(v, version) > 0)
      .sort(compareVersions);
    found.push({
      siteId: String(r.site_id),
      siteName: String(r.site_name),
      type: String(r.type) as Match['type'],
      item: String(r.item),
      slug: String(r.slug ?? 'wordpress'),
      version,
      vulnerability,
      fixedIn: vulnerability.patched ? (fixes[0] ?? null) : null,
    });
  }
  return found;
}

const WHAT = { core: 'WordPress itself', plugin: 'a plugin', theme: 'a theme' } as const;

/**
 * One issue per site and component, however many vulnerabilities it has: urgent when a fix
 * exists, else for the digest. Summaries reach Discord, so they never name the component.
 */
export function judgeVulnerabilities(db: Db, now: number): void {
  const groups = new Map<string, Match[]>();
  for (const m of matches(db)) {
    if (m.vulnerability.informational) continue;
    const key = `${m.siteId}\u0000${VULNERABLE_KIND}${m.type}:${m.item}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const [key, group] of groups) {
    const [siteId, kind] = key.split('\u0000') as [string, string];
    const first = group[0]!;
    const fix = group.some((m) => m.fixedIn !== null);
    const count =
      group.length === 1 ? 'a known vulnerability' : `${group.length} known vulnerabilities`;
    raiseIssue(db, now, {
      resourceType: 'site',
      resourceId: siteId,
      kind,
      severity: fix ? 'urgent' : 'normal',
      summary: `${first.siteName}: ${WHAT[first.type]} has ${count}, ${fix ? 'with a fix to update to' : 'with no fix yet'}`,
    });
  }
  const open = db
    .prepare(
      `SELECT resource_id, kind FROM issues WHERE resource_type = 'site' AND kind LIKE ?
       AND resolved_at IS NULL`,
    )
    .all(`${VULNERABLE_KIND}%`);
  for (const r of open) {
    if (groups.has(`${String(r.resource_id)}\u0000${String(r.kind)}`)) continue;
    clearIssue(
      db,
      now,
      { resourceType: 'site', resourceId: String(r.resource_id), kind: String(r.kind) },
      'A known vulnerability no longer applies: the component was updated or removed',
    );
  }
}
