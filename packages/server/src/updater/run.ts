// The updater's work (calcifer explore/kamaji.md, "Updating, end to end"): one approved batch at
// a time, one site at a time, core first and alone, then one component at a time with the checks
// after each. It runs in its own process with the update key (updater/main.ts); everything it
// touches outside comes in through UpdaterDeps, so the tests can drive it against DDEV.
//
// For each site: pause its uptime alerts on both paths (its upgrades answer 503 while WordPress
// is in maintenance mode), record the backup evidence and the baseline checks, run the items,
// then resume the alerts and re-check straight away. Any outcome but "passed" holds the rest of
// that site's items and raises an urgent issue. After a restart, an item left mid-way is
// reconciled by asking the site, never assumed done or blindly retried.
import { recordEvidence, type ExportAnswer } from '../backups/evidence.js';
import { CareHello, CareReport, type Outcome } from '@kamaji/shared';
import type { CareResult } from '../care/client.js';
import type { SigningKey } from '../care/keys.js';
import { checkOutsideNow, pushOutsideSites, type OutsideClient } from '../checks/outside.js';
import type { HomePageResult } from '../checks/http.js';
import { checkSites, realCheckers, type SiteCheckers } from '../checks/sites.js';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { recordEvent } from '../events.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { storeReport } from '../inventory/report.js';
import { recordObservation } from '../observations.js';

export type Send = (
  home: URL,
  key: SigningKey,
  endpoint: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<CareResult>;

export interface BackupResult {
  ok: boolean;
  /** Plain words for the record: when, how big, its hash; or why not. */
  words: string;
  /** What a craftish export answered, kept apart in backup_evidence. */
  answer?: ExportAnswer;
}

export interface Timing {
  /** How often to ask a running job's status. */
  pollMs: number;
  /** How long a job may take before Kamaji stops waiting for it. */
  jobTimeoutMs: number;
  /** How long one request may take; a job that runs inline (no PHP-FPM) can take this long. */
  requestTimeoutMs: number;
  /** How far ahead each renewal of a site's pause reaches. */
  pauseMs: number;
}

export const TIMING: Timing = {
  pollMs: 3_000,
  jobTimeoutMs: 20 * 60_000,
  requestTimeoutMs: 120_000,
  pauseMs: 25 * 60_000,
};

export interface UpdaterDeps {
  db: Db;
  keys: { report: SigningKey; update: SigningKey };
  send: Send;
  homePage: SiteCheckers['homePage'];
  /** The app's site checks, for the re-check straight after a run. */
  checkers?: SiteCheckers;
  worker: OutsideClient | undefined;
  backup: (site: RunSite) => Promise<BackupResult>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: (message: string) => void;
  timing?: Partial<Timing>;
}

export interface RunSite {
  id: string;
  name: string;
  url: string;
  hostKind: string;
  expectedText: string | null;
  importantPages: string[];
}

interface Item {
  id: string;
  batchId: string;
  siteId: string;
  type: 'core' | 'plugin' | 'theme';
  item: string;
  name: string;
  from: string;
  to: string;
  state: string;
  sentAt: number | null;
}

interface Checks {
  ok: boolean;
  problems: string[];
  siteHealth: string[];
}

const label = (i: Item) => `${i.name} ${i.from} → ${i.to}`;

export const OUTCOME_WORDS: Record<Outcome, string> = {
  passed: 'updated and passed its checks',
  checks_failed: 'updated, but failed its checks',
  update_failed: 'the update failed',
  incomplete: 'couldn’t be verified',
};

export async function runUpdater(deps: UpdaterDeps): Promise<void> {
  for (;;) {
    if (deps.signal.aborted) throw deps.signal.reason;
    const batch = nextBatch(deps.db);
    if (!batch) return;
    await runBatch(deps, batch.id, batch.oneSiteFirst);
  }
}

function nextBatch(db: Db): { id: string; oneSiteFirst: boolean } | null {
  const row = db
    .prepare(
      `SELECT b.id, b.one_site_first FROM batches b
       WHERE b.state IN ('approved', 'running')
       AND EXISTS (SELECT 1 FROM batch_sites s WHERE s.batch_id = b.id AND s.state IN ('waiting', 'running'))
       ORDER BY b.approved_at LIMIT 1`,
    )
    .get();
  if (!row) {
    db.prepare(
      `UPDATE batches SET state = 'finished', finished_at = ? WHERE state != 'finished'
       AND NOT EXISTS (SELECT 1 FROM batch_sites s WHERE s.batch_id = batches.id AND s.state IN ('waiting', 'running'))`,
    ).run(Date.now());
    return null;
  }
  return { id: String(row.id), oneSiteFirst: Number(row.one_site_first) === 1 };
}

async function runBatch(deps: UpdaterDeps, batchId: string, oneSiteFirst: boolean): Promise<void> {
  const { db } = deps;
  db.prepare("UPDATE batches SET state = 'running' WHERE id = ?").run(batchId);
  const sites = db
    .prepare(
      `SELECT site_id, position, state FROM batch_sites WHERE batch_id = ?
       AND state IN ('waiting', 'running') ORDER BY position`,
    )
    .all(batchId)
    .map((r) => ({ id: String(r.site_id), position: Number(r.position) }));
  for (const [n, s] of sites.entries()) {
    const held = await runSite(deps, batchId, s.id);
    // "One site first": the rest wait on the first site passing.
    if (held && oneSiteFirst && n === 0 && s.position === 0) {
      for (const rest of sites.slice(1)) {
        hold(
          db,
          batchId,
          rest.id,
          'Held: the first site’s updates need a look before the rest run',
          deps.now(),
        );
      }
      break;
    }
  }
  const open = db
    .prepare(
      "SELECT 1 FROM batch_sites WHERE batch_id = ? AND state IN ('waiting', 'running') LIMIT 1",
    )
    .get(batchId);
  if (!open) {
    db.prepare("UPDATE batches SET state = 'finished', finished_at = ? WHERE id = ?").run(
      deps.now(),
      batchId,
    );
  }
}

function importantPages(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function siteRow(db: Db, id: string): RunSite {
  const r = db
    .prepare(
      'SELECT id, name, url, host_kind, expected_text, important_pages FROM sites WHERE id = ?',
    )
    .get(id);
  if (!r) throw new Error('site not found');
  const pages = importantPages(String(r.important_pages ?? '[]'));
  return {
    id: String(r.id),
    name: String(r.name),
    url: String(r.url),
    hostKind: String(r.host_kind),
    expectedText: r.expected_text === null ? null : String(r.expected_text),
    importantPages: pages,
  };
}

/** Runs one site's part of a batch. Returns whether the site ended held. */
async function runSite(deps: UpdaterDeps, batchId: string, siteId: string): Promise<boolean> {
  const { db } = deps;
  const site = siteRow(db, siteId);
  db.prepare(
    "UPDATE batch_sites SET state = 'running', started_at = COALESCE(started_at, ?) WHERE batch_id = ? AND site_id = ?",
  ).run(deps.now(), batchId, siteId);
  await pause(deps, site);
  let held = false;
  try {
    const run = db
      .prepare(
        'SELECT backup_kind, backup, baseline FROM batch_sites WHERE batch_id = ? AND site_id = ?',
      )
      .get(batchId, siteId)!;

    if (run.backup === null) {
      const evidence = await backupEvidence(deps, site, String(run.backup_kind));
      if (run.backup_kind === 'kamaji') {
        recordEvidence(db, {
          siteId,
          batchId,
          requestedBy: null,
          at: deps.now(),
          ok: evidence.ok,
          words: evidence.words,
          answer: evidence.answer,
        });
      }
      if (!evidence.ok) {
        hold(db, batchId, siteId, `Held: no backup evidence. ${evidence.words}`, deps.now());
        return true;
      }
      db.prepare('UPDATE batch_sites SET backup = ? WHERE batch_id = ? AND site_id = ?').run(
        evidence.words,
        batchId,
        siteId,
      );
    }

    const baseline =
      run.baseline === null
        ? null
        : (JSON.parse(String(run.baseline)) as Checks & { accepted?: boolean });
    let siteHealthBefore = baseline?.siteHealth ?? [];
    if (!baseline || (!baseline.ok && !baseline.accepted)) {
      const report = await freshReport(deps, site);
      // Site Health's critical items before any update are the baseline: only new ones fail.
      const health = report?.site_health.map((h) => h.label) ?? [];
      const checks = await runChecks(deps, site, health, health);
      db.prepare('UPDATE batch_sites SET baseline = ? WHERE batch_id = ? AND site_id = ?').run(
        JSON.stringify(checks),
        batchId,
        siteId,
      );
      siteHealthBefore = checks.siteHealth;
      if (!checks.ok) {
        hold(
          db,
          batchId,
          siteId,
          `Held: the site was already failing its checks before any update (${checks.problems.join('; ')})`,
          deps.now(),
        );
        return true;
      }
    }

    for (;;) {
      const item = nextItem(db, batchId, siteId);
      if (!item) break;
      await pause(deps, site);
      const { outcome, detail } = await runItem(deps, site, item, siteHealthBefore);
      finishItem(db, item, outcome, detail, deps.now());
      deps.log(`updater: ${site.name}: ${item.type} ${outcome}`);
      if (outcome !== 'passed') {
        hold(db, batchId, siteId, `Held after ${label(item)}: ${detail}`, deps.now());
        held = true;
        break;
      }
    }
    if (!held) {
      db.prepare(
        "UPDATE batch_sites SET state = 'done', finished_at = ? WHERE batch_id = ? AND site_id = ? AND state = 'running'",
      ).run(deps.now(), batchId, siteId);
      clearIssue(
        db,
        deps.now(),
        { resourceType: 'site', resourceId: siteId, kind: 'update-held' },
        `${site.name}: the held updates are done`,
      );
    }
    return held;
  } finally {
    await resume(deps, site);
  }
}

function nextItem(db: Db, batchId: string, siteId: string): Item | null {
  const r = db
    .prepare(
      `SELECT * FROM batch_items WHERE batch_id = ? AND site_id = ?
       AND state IN ('waiting', 'sent', 'running', 'checking') ORDER BY position LIMIT 1`,
    )
    .get(batchId, siteId);
  if (!r) return null;
  return {
    id: String(r.id),
    batchId: String(r.batch_id),
    siteId: String(r.site_id),
    type: String(r.type) as Item['type'],
    item: String(r.item),
    name: String(r.name),
    from: String(r.from_version),
    to: String(r.to_version),
    state: String(r.state),
    sentAt: r.sent_at === null ? null : Number(r.sent_at),
  };
}

function setItem(db: Db, id: string, state: string, extra: { sentAt?: number } = {}): void {
  if (extra.sentAt !== undefined) {
    db.prepare('UPDATE batch_items SET state = ?, sent_at = ? WHERE id = ?').run(
      state,
      extra.sentAt,
      id,
    );
  } else {
    db.prepare('UPDATE batch_items SET state = ? WHERE id = ?').run(state, id);
  }
}

function finishItem(db: Db, item: Item, outcome: Outcome, detail: string, at: number): void {
  transaction(db, () => {
    db.prepare(
      "UPDATE batch_items SET state = 'done', outcome = ?, detail = ?, finished_at = ? WHERE id = ?",
    ).run(outcome, detail, at, item.id);
    recordEvent(db, at, {
      kind: `update.${outcome}`,
      summary: `${label(item)} on ${String(db.prepare('SELECT name FROM sites WHERE id = ?').get(item.siteId)?.name ?? item.siteId)}: ${OUTCOME_WORDS[outcome]}`,
      resourceType: 'site',
      resourceId: item.siteId,
      detail: {
        batch: item.batchId,
        job: item.id,
        type: item.type,
        item: item.item,
        from: item.from,
        to: item.to,
        outcome,
        words: detail,
      },
    });
  });
}

/** Holds the rest of a site's items, with the reason, and alerts. Discord gets labels only. */
function hold(db: Db, batchId: string, siteId: string, reason: string, at: number): void {
  transaction(db, () => {
    db.prepare(
      "UPDATE batch_sites SET state = 'held', held_reason = ?, finished_at = ? WHERE batch_id = ? AND site_id = ?",
    ).run(reason, at, batchId, siteId);
    db.prepare(
      "UPDATE batch_items SET state = 'held' WHERE batch_id = ? AND site_id = ? AND state = 'waiting'",
    ).run(batchId, siteId);
    const name = String(
      db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId)?.name ?? siteId,
    );
    raiseIssue(db, at, {
      resourceType: 'site',
      resourceId: siteId,
      kind: 'update-held',
      severity: 'urgent',
      summary: `${name}: updates are held and need a look`,
    });
    recordEvent(db, at, {
      kind: 'batch.held',
      summary: `${name}: ${reason}`,
      resourceType: 'site',
      resourceId: siteId,
      detail: { batch: batchId },
    });
  });
}

// --- The pause ---------------------------------------------------------------------------------

async function pause(deps: UpdaterDeps, site: RunSite): Promise<void> {
  const until = deps.now() + (deps.timing?.pauseMs ?? TIMING.pauseMs);
  const was = deps.db
    .prepare('SELECT updating_until FROM sites WHERE id = ?')
    .get(site.id)?.updating_until;
  deps.db.prepare('UPDATE sites SET updating_until = ? WHERE id = ?').run(until, site.id);
  if ((was === null || Number(was) <= deps.now()) && deps.worker) {
    const ok = await pushOutsideSites(deps.db, deps.worker, { now: deps.now, signal: deps.signal });
    if (!ok) deps.log(`updater: ${site.name}: couldn’t pause the outside check`);
  }
}

/** Ends the pause, and re-checks the site at once from the mini and from outside. */
async function resume(deps: UpdaterDeps, site: RunSite): Promise<void> {
  deps.db.prepare('UPDATE sites SET updating_until = NULL WHERE id = ?').run(site.id);
  if (deps.worker) {
    const ok = await pushOutsideSites(deps.db, deps.worker, { now: deps.now, signal: deps.signal });
    if (ok) await checkOutsideNow(deps.worker, site.id, deps.signal);
    else deps.log(`updater: ${site.name}: couldn’t resume the outside check; the next cycle will`);
  }
  await checkSites(deps.db, {
    now: deps.now,
    signal: deps.signal,
    checkers: deps.checkers ?? realCheckers,
    only: [site.id],
  });
}

// --- Evidence and checks ---------------------------------------------------------------------

async function backupEvidence(
  deps: UpdaterDeps,
  site: RunSite,
  kind: string,
): Promise<BackupResult> {
  const at = new Date(deps.now()).toISOString();
  if (kind === 'host')
    return { ok: true, words: `Handled by the host (recorded for the site), ${at}` };
  if (kind === 'client')
    return { ok: true, words: `Handled by the client (recorded for the site), ${at}` };
  if (kind === 'kamaji') return deps.backup(site);
  return { ok: false, words: 'Tyler’s confirmation is missing for this run' };
}

/** A report, stored as the app stores one: the installed versions after an update. */
async function freshReport(deps: UpdaterDeps, site: RunSite): Promise<CareReport | null> {
  const result = await deps.send(
    new URL(site.url),
    deps.keys.report,
    'report',
    { refresh: false },
    {
      signal: deps.signal,
    },
  );
  if (!result.ok) return null;
  const parsed = CareReport.safeParse(result.data);
  if (!parsed.success) return null;
  const at = deps.now();
  storeReport(deps.db, site, parsed.data, at);
  recordObservation(deps.db, {
    resourceType: 'site',
    resourceId: site.id,
    check: 'report',
    source: 'plugin',
    at,
    ok: true,
    value: {
      ok: true,
      refreshed: false,
      locale: parsed.data.core.locale,
      php: parsed.data.php,
      database: parsed.data.database.server,
      checkedAt: parsed.data.checked_at,
      siteHealth: parsed.data.site_health,
      muPlugins: parsed.data.mu_plugins !== undefined,
      counts: {
        plugins: parsed.data.plugins.length,
        themes: parsed.data.themes.length,
        offers: [...parsed.data.plugins, ...parsed.data.themes].filter((c) => c.offer).length,
      },
    },
  });
  return parsed.data;
}

function installedVersion(report: CareReport, item: Item): string | null {
  if (item.type === 'core') return report.core.version;
  if (item.type === 'plugin')
    return report.plugins.find((p) => p.file === item.item)?.version ?? null;
  return report.themes.find((t) => t.stylesheet === item.item)?.version ?? null;
}

/**
 * The checks after an update (calcifer explore/kamaji.md, "Verification"): the home page with
 * its expected text and no PHP error, each important page, no new Site Health critical item,
 * and no .maintenance left. Passing means these passed, nothing more.
 */
async function runChecks(
  deps: UpdaterDeps,
  site: RunSite,
  siteHealth: string[],
  siteHealthBefore: string[],
): Promise<Checks> {
  const problems: string[] = [];
  const home: HomePageResult = await deps.homePage(site.url, site.expectedText, deps.signal);
  if (!home.ok) problems.push(`home page: ${home.problem ?? 'failed'}`);
  for (const page of site.importantPages) {
    const url = new URL(page, site.url).href;
    const result = await deps.homePage(url, null, deps.signal);
    if (!result.ok) problems.push(`${new URL(url).pathname}: ${result.problem ?? 'failed'}`);
  }
  const fresh = siteHealth.filter((h) => !siteHealthBefore.includes(h));
  if (fresh.length > 0) problems.push(`Site Health: ${fresh.join('; ')}`);
  const hello = await deps.send(
    new URL(site.url),
    deps.keys.report,
    'hello',
    {},
    { signal: deps.signal },
  );
  const parsed = hello.ok ? CareHello.safeParse(hello.data) : null;
  if (parsed?.success && parsed.data.capabilities.maintenance.present) {
    problems.push('.maintenance was left behind');
  } else if (!parsed?.success) {
    problems.push(
      `the plugin didn’t answer after the update: ${hello.ok ? 'unreadable answer' : hello.problem}`,
    );
  }
  return { ok: problems.length === 0, problems, siteHealth };
}

// --- One item ----------------------------------------------------------------------------------

const StatusAnswer = (data: unknown) => {
  const d = data as {
    state?: string;
    result?: {
      installed?: string | null;
      error?: string | null;
      message?: string | null;
      maintenance?: boolean;
    };
  } | null;
  return d && typeof d.state === 'string' ? d : null;
};

async function runItem(
  deps: UpdaterDeps,
  site: RunSite,
  item: Item,
  siteHealthBefore: string[],
): Promise<{ outcome: Outcome; detail: string }> {
  const timing = { ...TIMING, ...deps.timing };
  const home = new URL(site.url);
  const body = { job: item.id, type: item.type, item: item.item, from: item.from, to: item.to };

  if (item.state !== 'checking') {
    // Stored as sent before it's sent, so a restart asks the site rather than sending blind.
    const sentAt = item.sentAt ?? deps.now();
    if (item.state === 'waiting') setItem(deps.db, item.id, 'sent', { sentAt });
    const ask = () =>
      deps.send(home, deps.keys.update, 'update', body, {
        timeoutMs: timing.requestTimeoutMs,
        signal: deps.signal,
      });
    let answer = await ask();
    // Busy is another job holding the plugin's lock (one a dead run left lasts 15 minutes):
    // keep offering this one until the deadline. It was never accepted, so nothing changed.
    while (!answer.ok && answer.code === 'busy') {
      if (deps.now() - sentAt > timing.jobTimeoutMs) {
        return {
          outcome: 'update_failed',
          detail: 'the plugin stayed busy with another update the whole time; nothing was changed',
        };
      }
      await deps.sleep(timing.pollMs, deps.signal);
      answer = await ask();
    }
    if (
      !answer.ok &&
      answer.code !== null &&
      ['version_changed', 'no_package', 'job_id_reused'].includes(answer.code)
    ) {
      return { outcome: 'update_failed', detail: `${answer.problem}; nothing was changed` };
    }
    setItem(deps.db, item.id, 'running');

    let finished: ReturnType<typeof StatusAnswer> = answer.ok ? StatusAnswer(answer.data) : null;
    let lastProblem = answer.ok ? null : answer.problem;
    let maintenanceSince: number | null =
      answer.ok || answer.code !== 'maintenance' ? null : deps.now();
    while (!finished || finished.state === 'queued' || finished.state === 'running') {
      if (deps.now() - sentAt > timing.jobTimeoutMs) {
        return maintenanceSince !== null
          ? {
              outcome: 'update_failed',
              detail: `the site has been in maintenance mode since ${new Date(maintenanceSince).toISOString()}: the update stopped part-way and left .maintenance behind`,
            }
          : {
              outcome: 'incomplete',
              detail: `no result from the site within ${Math.round(timing.jobTimeoutMs / 60_000)} minutes (last: ${lastProblem ?? 'still running'})`,
            };
      }
      await deps.sleep(timing.pollMs, deps.signal);
      const status = await deps.send(
        home,
        deps.keys.report,
        'status',
        { job: item.id },
        { signal: deps.signal },
      );
      if (status.ok) {
        finished = StatusAnswer(status.data);
        maintenanceSince = null;
        continue;
      }
      lastProblem = status.problem;
      if (status.code === 'maintenance') {
        maintenanceSince ??= deps.now();
      } else {
        maintenanceSince = null;
        // The plugin never got the job (the request was lost, or it was busy): offer it again.
        // The same id can never run twice.
        if (status.code === 'unknown_job') {
          answer = await ask();
          if (answer.ok) finished = StatusAnswer(answer.data);
        }
      }
    }
    const r = finished.result ?? {};
    if (finished.state === 'failed') {
      const left = r.maintenance ? ', and .maintenance was left behind' : '';
      return {
        outcome: 'update_failed',
        detail: `${r.message ?? 'the upgrader failed'}${r.error ? ` (${r.error})` : ''}${left}; installed: ${r.installed ?? 'unknown'}`,
      };
    }
    setItem(deps.db, item.id, 'checking');
  }

  const report = await freshReport(deps, site);
  if (!report)
    return { outcome: 'incomplete', detail: 'the site’s report after the update couldn’t be read' };
  const installed = installedVersion(report, item);
  if (installed !== item.to) {
    return {
      outcome: 'update_failed',
      detail: `the plugin said it succeeded, but ${installed ?? 'nothing'} is installed`,
    };
  }
  const checks = await runChecks(
    deps,
    site,
    report.site_health.map((h) => h.label),
    siteHealthBefore,
  );
  return checks.ok
    ? { outcome: 'passed', detail: `${item.to} installed; the checks passed` }
    : {
        outcome: 'checks_failed',
        detail: `${item.to} installed, but ${checks.problems.join('; ')}`,
      };
}
