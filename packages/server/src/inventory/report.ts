// Inventory from craftish-care's reports (docs/protocol.md, "The report"). Each connected site is
// asked once an hour, and once a day it also has WordPress rerun its own update checks first.
// The components table holds the current state; every report is an observation and every change
// an event, so the history is kept. A failed report never empties the inventory: the last good
// one stays, saying how old it is.
import { CareReport, type Inventory, type Known, type VulnerabilityMatch } from '@kamaji/shared';
import type { CareKeys } from '../care/keys.js';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { latestObservations, recordObservation } from '../observations.js';
import type { CareSend } from '../sites/setup.js';
import {
  matches,
  readFeedState,
  STALE_AFTER_MS as FEED_STALE_AFTER_MS,
  type Match,
} from '../wordfence/feed.js';
import { databaseEndOfLife, phpEndOfLife } from '../endOfLife/check.js';
import { directoryStatus } from './directory.js';

export const REPORT_EVERY_MS = 60 * 60 * 1000;
export const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
/** No good report for this long opens an issue: the site may be fine, but Kamaji can't see it. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const REPORT_CHECK = 'report';
export const MU_PLUGINS_UNREAD = 'Must-use; Kamaji reads these from Craftish Care 0.2.0';

export type ReportValue =
  | {
      ok: true;
      refreshed: boolean;
      locale: string;
      php: string;
      database: string;
      checkedAt: CareReport['checked_at'];
      siteHealth: CareReport['site_health'];
      /** Whether the report listed must-use plugins (Craftish Care 0.2.0 and later). */
      muPlugins?: boolean;
      counts: { plugins: number; themes: number; offers: number };
    }
  | { ok: false; problem: string };

type Row = Record<string, unknown>;
type Kind = 'core' | 'plugin' | 'mu-plugin' | 'theme';

interface Component {
  type: Kind;
  item: string;
  slug: string | null;
  name: string;
  version: string;
  active: boolean;
  autoUpdate: boolean | null;
  parent: string | null;
  offerVersion: string | null;
  offerPackage: boolean | null;
}

/** The report as rows. Core's offer is the newest one with a package, if WordPress has one. */
function components(report: CareReport): Component[] {
  const core = report.core.offers.find((o) => o.response === 'upgrade') ?? null;
  return [
    {
      type: 'core',
      item: 'core',
      slug: null,
      name: 'WordPress',
      version: report.core.version,
      active: true,
      autoUpdate: null,
      parent: null,
      offerVersion: core?.version ?? null,
      offerPackage: core ? core.package : null,
    },
    ...report.plugins.map((p) => ({
      type: 'plugin' as const,
      item: p.file,
      slug: p.slug,
      name: p.name,
      version: p.version,
      active: p.active,
      autoUpdate: p.auto_update,
      parent: null,
      offerVersion: p.offer?.version ?? null,
      offerPackage: p.offer ? p.offer.package : null,
    })),
    ...(report.mu_plugins ?? []).map((m) => ({
      type: 'mu-plugin' as const,
      item: m.file,
      slug: null,
      name: m.name,
      version: m.version,
      active: true,
      autoUpdate: null,
      parent: null,
      offerVersion: null,
      offerPackage: null,
    })),
    ...report.themes.map((t) => ({
      type: 'theme' as const,
      item: t.stylesheet,
      slug: t.stylesheet,
      name: t.name,
      version: t.version,
      active: t.active,
      autoUpdate: t.auto_update,
      parent: t.parent,
      offerVersion: t.offer?.version ?? null,
      offerPackage: t.offer ? t.offer.package : null,
    })),
  ];
}

const bool = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

/** Writes one good report: current state, gone components, and an event per change. */
export function storeReport(
  db: Db,
  site: { id: string; name: string },
  report: CareReport,
  now: number,
): void {
  const current = new Map(
    db
      .prepare('SELECT * FROM components WHERE site_id = ? AND gone_at IS NULL')
      .all(site.id)
      .map((r) => [`${String(r.type)}\u0000${String(r.item)}`, r]),
  );
  const first =
    db.prepare('SELECT 1 FROM components WHERE site_id = ? LIMIT 1').get(site.id) === undefined;
  const upsert = db.prepare(
    `INSERT INTO components (site_id, type, item, slug, name, version, active, auto_update, parent,
       offer_version, offer_package, first_seen_at, last_seen_at, gone_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (site_id, type, item) DO UPDATE SET slug = excluded.slug, name = excluded.name,
       version = excluded.version, active = excluded.active, auto_update = excluded.auto_update,
       parent = excluded.parent, offer_version = excluded.offer_version,
       offer_package = excluded.offer_package, last_seen_at = excluded.last_seen_at, gone_at = NULL`,
  );
  const event = (summary: string, detail: Record<string, unknown>) =>
    recordEvent(db, now, {
      kind: 'site.component-changed',
      summary,
      resourceType: 'site',
      resourceId: site.id,
      detail,
    });

  const seen = new Set<string>();
  for (const c of components(report)) {
    const key = `${c.type}\u0000${c.item}`;
    seen.add(key);
    const before = current.get(key);
    upsert.run(
      site.id,
      c.type,
      c.item,
      c.slug,
      c.name,
      c.version,
      c.active ? 1 : 0,
      bool(c.autoUpdate),
      c.parent,
      c.offerVersion,
      bool(c.offerPackage),
      now,
      now,
    );
    if (first) continue;
    const detail = { type: c.type, item: c.item };
    if (!before) {
      event(`${c.name} ${c.version} appeared on ${site.name}`, { ...detail, version: c.version });
      continue;
    }
    if (String(before.version) !== c.version) {
      event(`${c.name} went from ${String(before.version)} to ${c.version} on ${site.name}`, {
        ...detail,
        from: String(before.version),
        to: c.version,
      });
    }
    if (c.offerVersion !== null && before.offer_version !== c.offerVersion) {
      event(`${site.name}: WordPress offers ${c.name} ${c.offerVersion}`, {
        ...detail,
        offer: c.offerVersion,
      });
    }
  }
  const gone = db.prepare(
    'UPDATE components SET gone_at = ? WHERE site_id = ? AND type = ? AND item = ?',
  );
  for (const [key, row] of current) {
    if (seen.has(key)) continue;
    // A report from before 0.2.0 says nothing about must-use plugins; that isn't "gone".
    if (row.type === 'mu-plugin' && !report.mu_plugins) continue;
    gone.run(now, site.id, String(row.type), String(row.item));
    event(`${String(row.name)} is no longer on ${site.name}`, {
      type: String(row.type),
      item: String(row.item),
    });
  }
  if (first) {
    event(
      `First inventory from ${site.name}: ${report.plugins.length} plugins, ${report.themes.length} themes`,
      {},
    );
  }
}

function lastGood(db: Db, siteId: string) {
  return db
    .prepare(
      `SELECT at, value FROM observations WHERE resource_type = 'site' AND resource_id = ?
       AND check_name = ? AND source = 'plugin' AND ok = 1 ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(siteId, REPORT_CHECK);
}

function lastRefreshAt(db: Db, siteId: string): number | null {
  const row = db
    .prepare(
      `SELECT at FROM observations WHERE resource_type = 'site' AND resource_id = ?
       AND check_name = ? AND source = 'plugin' AND ok = 1
       AND json_extract(value, '$.refreshed') = 1 ORDER BY at DESC LIMIT 1`,
    )
    .get(siteId, REPORT_CHECK);
  return row ? Number(row.at) : null;
}

/** Asks one site for its report and records the answer. Returns whether it worked. */
export async function reportSite(
  db: Db,
  site: { id: string; name: string; url: string },
  keys: CareKeys,
  send: CareSend,
  now: () => number,
  options: { refresh?: boolean } = {},
): Promise<boolean> {
  const lastRefresh = lastRefreshAt(db, site.id);
  const refresh =
    options.refresh ?? (lastRefresh === null || now() - lastRefresh >= REFRESH_EVERY_MS);
  const result = await send(new URL(site.url), keys.report, 'report', { refresh });
  const at = now();
  let value: ReportValue;
  if (!result.ok) {
    value = { ok: false, problem: result.problem };
  } else {
    const parsed = CareReport.safeParse(result.data);
    if (!parsed.success) {
      value = {
        ok: false,
        problem: 'The plugin answered, but not in a form this Kamaji understands',
      };
    } else {
      const report = parsed.data;
      storeReport(db, site, report, at);
      value = {
        ok: true,
        refreshed: report.refreshed,
        locale: report.core.locale,
        php: report.php,
        database: report.database.server,
        checkedAt: report.checked_at,
        siteHealth: report.site_health,
        muPlugins: report.mu_plugins !== undefined,
        counts: {
          plugins: report.plugins.length,
          themes: report.themes.length,
          offers: [...report.plugins, ...report.themes].filter((c) => c.offer).length,
        },
      };
    }
  }
  recordObservation(db, {
    resourceType: 'site',
    resourceId: site.id,
    check: REPORT_CHECK,
    source: 'plugin',
    at,
    ok: value.ok,
    value,
  });
  judgeReport(db, site, value, at);
  return value.ok;
}

function judgeReport(
  db: Db,
  site: { id: string; name: string },
  value: ReportValue,
  at: number,
): void {
  const key = { resourceType: 'site', resourceId: site.id, kind: 'inventory-stale' } as const;
  if (value.ok) {
    clearIssue(db, at, key, `${site.name} is reporting its inventory again`);
    return;
  }
  const good = lastGood(db, site.id);
  const since = good
    ? Number(good.at)
    : Number(
        db
          .prepare(
            `SELECT MIN(at) AS at FROM observations WHERE resource_type = 'site'
             AND resource_id = ? AND check_name = ? AND source = 'plugin'`,
          )
          .get(site.id, REPORT_CHECK)?.at ?? at,
      );
  if (at - since < STALE_AFTER_MS) return;
  raiseIssue(db, at, {
    ...key,
    severity: 'normal',
    summary: `${site.name} hasn’t reported its inventory for a day: ${value.problem}`,
  });
}

/** Sites due a report: connected, set up, not paused, and not asked within the hour. */
export function dueSites(db: Db, now: number): { id: string; name: string; url: string }[] {
  return db
    .prepare(
      `SELECT id, name, url FROM sites WHERE mode = 'connected' AND setup = 'done'
       AND removed_at IS NULL AND paused_at IS NULL ORDER BY id`,
    )
    .all()
    .filter((r) => {
      const [last] = latestObservations(db, 'site', String(r.id), REPORT_CHECK, 'plugin', 1);
      return !last || now - last.at >= REPORT_EVERY_MS;
    })
    .map((r) => ({ id: String(r.id), name: String(r.name), url: String(r.url) }));
}

/** The cycle's part: every due site, one at a time. Returns how many reported. */
export async function checkReports(
  db: Db,
  options: { keys: CareKeys | undefined; send: CareSend; now: () => number; signal: AbortSignal },
): Promise<number> {
  if (!options.keys) return 0;
  let reported = 0;
  for (const site of dueSites(db, options.now())) {
    if (options.signal.aborted) break;
    if (await reportSite(db, site, options.keys, options.send, options.now)) reported += 1;
  }
  return reported;
}

const iso = (ms: number) => new Date(ms).toISOString();
const secs = (s: number | null) => (s === null ? null : iso(s * 1000));
const offer = (r: Row) =>
  r.offer_version === null
    ? null
    : { version: String(r.offer_version), hasPackage: Number(r.offer_package) === 1 };

function toMatch(m: Match): VulnerabilityMatch {
  const v = m.vulnerability;
  return {
    id: v.id,
    title: v.title,
    informational: v.informational,
    cvssScore: v.cvssScore,
    cvssRating: v.cvssRating,
    cve: v.cve,
    fixedIn: m.fixedIn,
    remediation: v.remediation,
    reference: v.reference,
    published: v.published,
  };
}

/** Whether "no known vulnerabilities" can be believed. */
function vulnerabilityData(db: Db): Inventory['vulnerabilityData'] {
  const feed = readFeedState(db);
  if (feed.lastSuccessAt === null) {
    return {
      known: false,
      reason: feed.problem
        ? `No Wordfence data yet: ${feed.problem}`
        : 'No Wordfence data yet: vulnerabilities are unknown',
    };
  }
  return {
    known: true,
    value: {
      fetchedAt: iso(feed.lastSuccessAt),
      stale: Date.now() - feed.lastSuccessAt >= FEED_STALE_AFTER_MS,
      problem: feed.problem,
    },
  };
}

/** A site's inventory from its last good report, or why there isn't one. */
export function siteInventory(db: Db, site: { id: string; mode: string }): Known<Inventory> {
  if (site.mode !== 'connected')
    return { known: false, reason: 'Monitoring only: nothing reports' };
  const good = lastGood(db, site.id);
  const [latest] = latestObservations<ReportValue>(db, 'site', site.id, REPORT_CHECK, 'plugin', 1);
  if (!good) {
    return {
      known: false,
      reason:
        latest && !latest.value.ok
          ? `No report yet: ${latest.value.problem}`
          : 'First report pending',
    };
  }
  const value = JSON.parse(String(good.value)) as Extract<ReportValue, { ok: true }>;
  const rows = db
    .prepare(
      'SELECT * FROM components WHERE site_id = ? AND gone_at IS NULL ORDER BY name COLLATE NOCASE',
    )
    .all(site.id);
  const core = rows.find((r) => r.type === 'core');
  const found = new Map<string, VulnerabilityMatch[]>();
  for (const m of matches(db, site.id)) {
    const key = `${m.type}\u0000${m.item}`;
    found.set(key, [...(found.get(key) ?? []), toMatch(m)]);
  }
  const vulns = (type: string, item: string) => found.get(`${type}\u0000${item}`) ?? [];
  return {
    known: true,
    value: {
      reportedAt: iso(Number(good.at)),
      wordpressCheckedAt: {
        core: secs(value.checkedAt.core),
        plugins: secs(value.checkedAt.plugins),
        themes: secs(value.checkedAt.themes),
      },
      core: {
        version: core ? String(core.version) : 'unknown',
        locale: value.locale,
        offer: core ? offer(core) : null,
        vulnerabilities: vulns('core', 'core'),
      },
      vulnerabilityData: vulnerabilityData(db),
      php: value.php,
      database: value.database,
      endOfLife: {
        php: phpEndOfLife(value.php, Date.now()),
        database: databaseEndOfLife(value.database, Date.now()),
      },
      plugins: rows
        .filter((r) => r.type === 'plugin')
        .map((r) => ({
          file: String(r.item),
          slug: String(r.slug),
          name: String(r.name),
          version: String(r.version),
          active: Number(r.active) === 1,
          autoUpdate: Number(r.auto_update) === 1,
          offer: offer(r),
          directory: directoryStatus(db, String(r.slug)),
          vulnerabilities: vulns('plugin', String(r.item)),
        })),
      muPlugins: value.muPlugins
        ? {
            known: true,
            value: rows
              .filter((r) => r.type === 'mu-plugin')
              .map((r) => ({
                file: String(r.item),
                name: String(r.name),
                version: String(r.version),
              })),
          }
        : { known: false, reason: MU_PLUGINS_UNREAD },
      themes: rows
        .filter((r) => r.type === 'theme')
        .map((r) => ({
          stylesheet: String(r.item),
          name: String(r.name),
          version: String(r.version),
          active: Number(r.active) === 1,
          parent: r.parent === null ? null : String(r.parent),
          autoUpdate: Number(r.auto_update) === 1,
          offer: offer(r),
          vulnerabilities: vulns('theme', String(r.item)),
        })),
      siteHealth: value.siteHealth,
      lastFailure:
        latest && !latest.value.ok && latest.at > Number(good.at)
          ? { at: iso(latest.at), problem: latest.value.problem }
          : null,
    },
  };
}

/** How many components have an update on offer, from the last good report. */
export function updatesWaiting(db: Db, site: { id: string; mode: string }): Known<number> {
  if (site.mode !== 'connected') return { known: false, reason: 'Not connected' };
  if (!lastGood(db, site.id)) return { known: false, reason: 'No report yet' };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM components WHERE site_id = ? AND gone_at IS NULL
       AND offer_version IS NOT NULL`,
    )
    .get(site.id);
  return { known: true, value: Number(row?.n ?? 0) };
}
