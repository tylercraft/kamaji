import { readFileSync } from 'node:fs';
import { CareReport } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import type { CareResult } from '../care/client.js';
import { loadCareKeys, newKeyPair } from '../care/keys.js';
import type { HomePageResult } from '../checks/http.js';
import type { Db } from '../db.js';
import { storeReport } from '../inventory/report.js';
import { recordObservation } from '../observations.js';
import { testDb } from '../testing.js';
import { approveBatch, batchViews, carryOn } from '../updates/batches.js';
import { queue } from '../updates/queue.js';
import { backupHistory } from '../backups/evidence.js';
import { runUpdater, type UpdaterDeps } from './run.js';
import { dueSites } from '../sitebackups/run.js';
import { randomBytes } from 'node:crypto';
import type { RuleBody } from '@kamaji/shared';
import { ruleApprovalProblem } from '../passkeys/guard.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { bodyHash, challengeFor } from '../passkeys/webauthn.js';
import type { OrgLookup } from '../rules/org.js';
import { makeRuleRuns } from '../rules/runs.js';
import { pauseRule, saveRule } from '../rules/store.js';
import { KAMAJI_ZONE, wallClock } from '../sitebackups/schedule.js';

const REPORT = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('../inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);
const keys = loadCareKeys({
  KAMAJI_CARE_REPORT_KEY: newKeyPair().seed,
  KAMAJI_CARE_UPDATE_KEY: newKeyPair().seed,
})!;
const T = Date.UTC(2026, 10, 12, 0, 0);
const SITE = 'one.test';

/** A site running Craftish Care 0.2.0, as the updater sees it over the protocol. */
class FakeSite {
  core = '7.1.3';
  akismet = '5.3';
  jobs = new Map<string, { state: string; to: string; item: string; polls: number }>();
  sent: { endpoint: string; body: Record<string, unknown> }[] = [];
  /** What the next jobs do. */
  behave: {
    breaksHomePage?: boolean;
    failJob?: boolean;
    versionChanged?: boolean;
    maintenanceForever?: boolean;
    /** The process dies mid-upgrade: maintenance mode from then on. */
    diesMidUpgrade?: boolean;
    pollsToFinish?: number;
    /** Updates refused as busy before one is taken; Infinity for a lock that never frees. */
    busyFor?: number;
  } = {};
  homeOk = true;
  maintenance = false;
  /** Site Health's critical items beyond the fixture's. */
  health: string[] = [];

  report(): unknown {
    const r = structuredClone(REPORT);
    r.site_health.push(...this.health.map((label) => ({ test: 'x', label })));
    r.core.version = this.core;
    r.core.offers =
      this.core === '7.1.4'
        ? []
        : [{ version: '7.1.4', locale: 'en_US', response: 'upgrade', package: true }];
    r.plugins[0]!.version = this.akismet;
    r.plugins[0]!.offer = this.akismet === '5.7.2' ? null : { version: '5.7.2', package: true };
    r.plugins[1]!.version = '0.2.0';
    return r;
  }

  hello(): unknown {
    return {
      plugin: '0.2.0',
      protocol: 1,
      wordpress: this.core,
      php: '8.3.6',
      multisite: false,
      capabilities: {
        can_report: true,
        can_update: true,
        update_blockers: [],
        auto_updates: { all_disabled: false, plugins: true, themes: true },
        maintenance: { present: this.maintenance, age_seconds: this.maintenance ? 5 : null },
        wp_cron_disabled: true,
        loopback: { ok: true },
      },
    };
  }

  send = async (
    _home: URL,
    _key: unknown,
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<CareResult> => {
    this.sent.push({ endpoint, body });
    const ok = (data: unknown, status = 200): CareResult => ({ ok: true, status, data });
    if (this.behave.maintenanceForever && endpoint !== 'update') {
      return { ok: false, status: 503, code: 'maintenance', problem: 'maintenance' };
    }
    if (endpoint === 'report') return ok(this.report());
    if (endpoint === 'hello') return ok(this.hello());
    if (endpoint === 'update') {
      const id = String(body.job);
      const known = this.jobs.get(id);
      if (known) return ok({ job: id, state: known.state });
      if ((this.behave.busyFor ?? 0) > 0) {
        this.behave.busyFor = (this.behave.busyFor ?? 0) - 1;
        return { ok: false, status: 409, code: 'busy', problem: 'busy' };
      }
      if (this.behave.versionChanged) {
        return { ok: false, status: 409, code: 'version_changed', problem: 'version changed' };
      }
      this.jobs.set(id, {
        state: 'queued',
        to: String(body.to),
        item: String(body.item),
        polls: 0,
      });
      if (this.behave.diesMidUpgrade) this.behave.maintenanceForever = true;
      return ok({ job: id, state: 'queued' }, 202);
    }
    if (endpoint === 'status') {
      const job = this.jobs.get(String(body.job));
      if (!job) return { ok: false, status: 404, code: 'unknown_job', problem: 'unknown job' };
      job.polls += 1;
      if (job.state === 'queued' || job.state === 'running') {
        if (job.polls < (this.behave.pollsToFinish ?? 1)) {
          job.state = 'running';
          return { ok: false, status: 503, code: 'maintenance', problem: 'maintenance' };
        }
        if (this.behave.failJob) {
          job.state = 'failed';
        } else {
          job.state = 'succeeded';
          if (job.item === 'core') this.core = job.to;
          else this.akismet = job.to;
          if (this.behave.breaksHomePage) this.homeOk = false;
        }
      }
      return ok({
        job: String(body.job),
        state: job.state,
        result: {
          installed: job.item === 'core' ? this.core : this.akismet,
          error: job.state === 'failed' ? 'download_failed' : null,
          message: job.state === 'failed' ? 'The upgrader reported download_failed' : null,
          maintenance: false,
        },
      });
    }
    return { ok: false, status: 404, code: 'not_found', problem: 'not found' };
  };

  homePage = async (): Promise<HomePageResult> => ({
    ok: this.homeOk,
    status: this.homeOk ? 200 : 500,
    responseMs: 100,
    finalUrl: 'https://one.test/',
    expectedText: this.homeOk,
    phpError: !this.homeOk,
    problem: this.homeOk ? null : 'PHP error on the page',
    errorCode: null,
  });
}

function setup(backup: 'host' | 'tyler' | 'kamaji' = 'host') {
  const db = testDb();
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, expected_text, created_at)
     VALUES (?, 'One', 'https://one.test/', 'craftish', 'connected', 'done', ?, 'One', 0)`,
  ).run(SITE, backup);
  const site = new FakeSite();
  recordObservation(db, {
    resourceType: 'site',
    resourceId: SITE,
    check: 'hello',
    source: 'plugin',
    at: T,
    ok: true,
    value: { ok: true, hello: site.hello() },
  });
  storeReport(db, { id: SITE, name: 'One' }, CareReport.parse(site.report()), T);
  const worker: string[] = [];
  const pausedDuring: (number | null)[] = [];
  const workerFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v1/sites')) {
      const sites = JSON.parse(String(init?.body)) as { id: string }[];
      worker.push(`PUT ${sites.map((s) => s.id).join(',') || '(none)'}`);
    } else worker.push(`POST ${new URL(u).pathname}`);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const deps = (signal = new AbortController().signal): UpdaterDeps => ({
    db,
    keys: { report: keys.report, update: keys.update! },
    send: async (home, key, endpoint, body) => {
      if (endpoint === 'update') {
        pausedDuring.push(
          Number(
            db.prepare('SELECT updating_until FROM sites WHERE id = ?').get(SITE)?.updating_until ??
              0,
          ) || null,
        );
      }
      return site.send(home, key, endpoint, body);
    },
    homePage: site.homePage,
    checkers: {
      homePage: site.homePage,
      certificate: async () =>
        ({ ok: true, daysLeft: 60, notAfter: null, problem: null, errorCode: null }) as never,
    },
    worker: { url: 'https://worker.test', token: 't', fetch: workerFetch },
    backup: async () => ({ ok: false, words: 'The export on craftish failed: the export failed' }),
    now: () => T,
    sleep: async () => {},
    signal,
    log: () => {},
    timing: { jobTimeoutMs: 60_000 },
    approvalProblem: () => null,
  });
  return { db, site, deps, worker, pausedDuring };
}

async function approve(db: Db, confirmed: string[] = [], oneSiteFirst = false) {
  const items = queue(db).items.map(({ siteId, type, item, from, to }) => ({
    siteId,
    type,
    item,
    from,
    to,
  }));
  return approveBatch(
    db,
    { items, confirmedBackups: confirmed, oneSiteFirst },
    'tyler',
    () => T,
    async () => true,
  );
}

const outcomes = (db: Db) =>
  batchViews(db)[0]!.sites.flatMap((s) => s.items.map((i) => [i.type, i.state, i.outcome]));
const openIssues = (db: Db) =>
  db
    .prepare('SELECT kind, severity, summary FROM issues WHERE resolved_at IS NULL')
    .all()
    .map((r) => ({ ...r }));

describe('the queue and approval', () => {
  it('queues what WordPress offers on a site that can update, core first', () => {
    const { db } = setup();
    expect(queue(db).items.map((i) => [i.type, i.from, i.to, i.major])).toEqual([
      ['core', '7.1.3', '7.1.4', false],
      ['plugin', '5.3', '5.7.2', false],
    ]);
  });

  it('sends a changed offer back to review, and asks for a backup Tyler vouches for', async () => {
    const { db } = setup('tyler');
    expect(await approve(db)).toEqual({ ok: false, changed: [], needsBackup: [SITE] });
    const items = [
      {
        siteId: SITE,
        type: 'plugin' as const,
        item: 'akismet/akismet.php',
        from: '5.3',
        to: '5.8',
      },
    ];
    expect(
      await approveBatch(
        db,
        { items, confirmedBackups: [SITE], oneSiteFirst: false },
        'tyler',
        () => T,
        async () => true,
      ),
    ).toEqual({
      ok: false,
      changed: [`${SITE} akismet/akismet.php`],
      needsBackup: [],
    });
    expect((await approve(db, [SITE])).ok).toBe(true);
    // Approved items leave the queue, so they can't be approved twice.
    expect(queue(db).items).toEqual([]);
  });
});

describe('one site’s updates', () => {
  it('narrows the queue to the site, and the runs to its latest, with only its part', async () => {
    const { db, site } = setup();
    const TWO = 'two.test';
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, expected_text, created_at)
       VALUES (?, 'Two', 'https://two.test/', 'craftish', 'connected', 'done', 'host', 'Two', 0)`,
    ).run(TWO);
    recordObservation(db, {
      resourceType: 'site',
      resourceId: TWO,
      check: 'hello',
      source: 'plugin',
      at: T,
      ok: true,
      value: { ok: true, hello: site.hello() },
    });
    storeReport(db, { id: TWO, name: 'Two' }, CareReport.parse(site.report()), T);

    const two = queue(db, TWO);
    expect(two.sites.map((s) => s.siteId)).toEqual([TWO]);
    expect(two.items.length).toBeGreaterThan(0);
    expect(two.items.every((i) => i.siteId === TWO)).toBe(true);
    expect(batchViews(db, 1, TWO)).toEqual([]);

    expect((await approve(db)).ok).toBe(true);
    expect(batchViews(db)[0]!.sites.map((s) => s.siteId)).toEqual([SITE, TWO]);
    const latest = batchViews(db, 1, TWO);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.sites.map((s) => s.siteId)).toEqual([TWO]);
    expect(queue(db, TWO).items).toEqual([]);
  });
});

describe('the updater', () => {
  it('runs nothing in a batch whose approval doesn’t hold, and holds it with the reason', async () => {
    const { db, site, deps } = setup();
    await approve(db);
    await runUpdater({ ...deps(), approvalProblem: () => 'no passkey approval' });
    expect(site.sent.filter((s) => s.endpoint === 'update')).toEqual([]);
    expect(batchViews(db)[0]!.sites[0]).toMatchObject({
      state: 'held',
      heldReason: expect.stringContaining('the approval doesn’t hold (no passkey approval)'),
    });
    expect(openIssues(db).map((i) => i.kind)).toEqual(['update-held']);
  });

  it('runs core first, then each component, with checks after each, inside a pause on both paths', async () => {
    const { db, site, deps, worker, pausedDuring } = setup();
    await approve(db);
    await runUpdater(deps());
    expect(outcomes(db)).toEqual([
      ['core', 'done', 'passed'],
      ['plugin', 'done', 'passed'],
    ]);
    expect(site.sent.filter((s) => s.endpoint === 'update').map((s) => s.body.item)).toEqual([
      'core',
      'akismet/akismet.php',
    ]);
    // Paused for each update, the Worker told at once, then resumed and re-checked straight after.
    expect(pausedDuring.every((p) => p !== null && p > T)).toBe(true);
    expect(worker).toEqual([`PUT (none)`, `PUT ${SITE}`, `POST /v1/check/${SITE}`]);
    expect(db.prepare('SELECT updating_until FROM sites WHERE id = ?').get(SITE)).toEqual({
      updating_until: null,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM observations WHERE check_name = 'http' AND source = 'mini'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(batchViews(db)[0]).toMatchObject({ state: 'finished', sites: [{ state: 'done' }] });
    expect(openIssues(db)).toEqual([]);
  });

  it('asks for a refreshed report after WordPress itself, so its update checks run again', async () => {
    const { db, site, deps } = setup();
    await approve(db);
    await runUpdater(deps());
    // The report straight after each job: refreshed after core (Craftish Care cleared update_core
    // at the end of the job), as usual after a plugin.
    const reports = site.sent.flatMap((s, n) =>
      s.endpoint === 'report' && site.sent[n - 1]?.endpoint === 'status' ? [s.body] : [],
    );
    expect(reports).toEqual([{ refresh: true }, { refresh: false }]);
  });

  it('holds the rest when an update breaks a check, and alerts without naming the component', async () => {
    const { db, site, deps } = setup();
    site.behave.breaksHomePage = true;
    await approve(db);
    await runUpdater(deps());
    expect(outcomes(db)).toEqual([
      ['core', 'done', 'checks_failed'],
      ['plugin', 'held', null],
    ]);
    expect(batchViews(db)[0]!.sites[0]!.heldReason).toMatch(
      /^Held after WordPress 7\.1\.3 → 7\.1\.4: 7\.1\.4 installed, but home page: PHP error/,
    );
    expect(openIssues(db)).toContainEqual({
      kind: 'update-held',
      severity: 'urgent',
      summary: 'One: updates are held and need a look',
    });
  });

  it('checks each page to check with its own text, and holds the run when a page lacks it', async () => {
    const { db, deps } = setup();
    db.prepare('UPDATE sites SET important_pages = ? WHERE id = ?').run(
      JSON.stringify([
        { url: 'https://one.test/shop/', expectedText: 'Add to cart' },
        { url: 'https://one.test/contact/', expectedText: null },
      ]),
      SITE,
    );
    await approve(db);
    const asked: [string, string | null][] = [];
    const d = deps();
    const home = d.homePage;
    d.homePage = async (url, expected, signal) => {
      asked.push([url, expected]);
      // The shop page passes the check before updating, then loses its cart button in the update.
      if (url.endsWith('/shop/') && asked.filter(([u]) => u === url).length > 1)
        return {
          ...(await home(url, expected, signal)),
          ok: false,
          expectedText: false,
          problem: 'Expected text not found',
        };
      return home(url, expected, signal);
    };
    await runUpdater(d);
    expect(asked.slice(0, 3)).toEqual([
      ['https://one.test/', 'One'],
      ['https://one.test/shop/', 'Add to cart'],
      ['https://one.test/contact/', null],
    ]);
    expect(outcomes(db)).toEqual([
      ['core', 'done', 'checks_failed'],
      ['plugin', 'held', null],
    ]);
    expect(batchViews(db)[0]!.sites[0]!.heldReason).toMatch(/\/shop\/: Expected text not found/);
  });

  it('still checks pages saved in the first shape, a list of paths', async () => {
    const { db, deps } = setup();
    db.prepare('UPDATE sites SET important_pages = ? WHERE id = ?').run('["/shop/"]', SITE);
    await approve(db);
    const asked: string[] = [];
    const d = deps();
    const home = d.homePage;
    d.homePage = async (url, expected, signal) => {
      asked.push(url);
      return home(url, expected, signal);
    };
    await runUpdater(d);
    expect(asked).toContain('https://one.test/shop/');
    expect(outcomes(db)).toEqual([
      ['core', 'done', 'passed'],
      ['plugin', 'done', 'passed'],
    ]);
  });

  it('names a failed job, and a version that changed', async () => {
    const failed = setup();
    failed.site.behave.failJob = true;
    await approve(failed.db);
    await runUpdater(failed.deps());
    expect(batchViews(failed.db)[0]!.sites[0]!.items[0]).toMatchObject({
      outcome: 'update_failed',
      detail: 'The upgrader reported download_failed (download_failed); installed: 7.1.3',
    });

    const changed = setup();
    changed.site.behave.versionChanged = true;
    await approve(changed.db);
    await runUpdater(changed.deps());
    expect(batchViews(changed.db)[0]!.sites[0]!.items[0]).toMatchObject({
      outcome: 'update_failed',
      detail: 'version changed; nothing was changed',
    });
  });

  it('offers a job again while the plugin is busy with another, and gives up at the deadline', async () => {
    const waits = setup();
    waits.site.behave.busyFor = 3;
    await approve(waits.db);
    await runUpdater(waits.deps());
    expect(outcomes(waits.db)).toEqual([
      ['core', 'done', 'passed'],
      ['plugin', 'done', 'passed'],
    ]);

    const stuck = setup();
    stuck.site.behave.busyFor = Infinity;
    await approve(stuck.db);
    let now = T;
    await runUpdater({ ...stuck.deps(), now: () => (now += 10_000) });
    expect(batchViews(stuck.db)[0]!.sites[0]!.items[0]).toMatchObject({
      outcome: 'update_failed',
      detail: 'the plugin stayed busy with another update the whole time; nothing was changed',
    });
  });

  it('says .maintenance was left behind when the site stays in maintenance mode past the job’s time', async () => {
    const { db, site, deps } = setup();
    await approve(db);
    site.behave.diesMidUpgrade = true;
    let now = T;
    await runUpdater({ ...deps(), now: () => (now += 10_000) });
    expect(batchViews(db)[0]!.sites[0]!.items[0]).toMatchObject({
      outcome: 'update_failed',
      detail: expect.stringMatching(
        /in maintenance mode since .*: the update stopped part-way and left \.maintenance behind$/,
      ),
    });
  });

  it('after a restart mid-job, asks the site with the same job id and carries on', async () => {
    const { db, site, deps } = setup();
    site.behave.pollsToFinish = 3;
    await approve(db);
    const stop = new AbortController();
    let polls = 0;
    const first = deps(stop.signal);
    await expect(
      runUpdater({
        ...first,
        sleep: async () => {
          if (++polls === 2) stop.abort(new Error('killed'));
          if (stop.signal.aborted) throw stop.signal.reason;
        },
      }),
    ).rejects.toThrow('killed');
    expect(outcomes(db)[0]).toEqual(['core', 'running', null]);

    await runUpdater(deps());
    expect(outcomes(db)).toEqual([
      ['core', 'done', 'passed'],
      ['plugin', 'done', 'passed'],
    ]);
    const coreSends = site.sent.filter((s) => s.endpoint === 'update' && s.body.item === 'core');
    expect(new Set(coreSends.map((s) => s.body.job)).size).toBe(1);
    expect(site.jobs.size).toBe(2);
  });

  it('holds a craftish site without a fresh export, and carries on after a look', async () => {
    const { db, deps } = setup('kamaji');
    await approve(db);
    await runUpdater(deps());
    const view = batchViews(db)[0]!;
    expect(view.sites[0]).toMatchObject({
      state: 'held',
      heldReason:
        'Held: no backup evidence. Database export before update failed: The export on craftish failed: the export failed',
    });
    expect(outcomes(db)).toEqual([
      ['core', 'held', null],
      ['plugin', 'held', null],
    ]);
    expect(carryOn(db, view.id, SITE, 'tyler', T)).toBe(true);
    await runUpdater(deps());
    expect(batchViews(db)[0]!.sites[0]).toMatchObject({
      state: 'done',
      backup: expect.stringMatching(/^Tyler carried on without fresh backup evidence/),
    });
    // The failed export is kept as evidence, and the carry-on shows in the history beside it.
    expect(backupHistory(db, SITE).map((e) => [e.state, e.batchId])).toEqual([
      ['failed', view.id],
      ['recorded', view.id],
    ]);
  });

  it('keeps what a good export answered, apart, for the site’s Backups', async () => {
    const { db, deps } = setup('kamaji');
    await approve(db);
    const answer = { at: '20261112T000000Z', bytes: 4096, sha256: 'b'.repeat(64) };
    await runUpdater({
      ...deps(),
      backup: async () => ({ ok: true, words: 'Kamaji exported the database on craftish', answer }),
    });
    const [entry] = backupHistory(db, SITE);
    expect(entry).toMatchObject({
      state: 'exported',
      batchId: batchViews(db)[0]!.id,
      exportedAt: '2026-11-12T00:00:00.000Z',
      bytes: 4096,
    });
    expect(backupHistory(db, SITE)).toHaveLength(1);
  });

  it('never updates a site already failing its checks', async () => {
    const { db, site, deps } = setup();
    site.homeOk = false;
    await approve(db);
    await runUpdater(deps());
    expect(site.sent.some((s) => s.endpoint === 'update')).toBe(false);
    expect(batchViews(db)[0]!.sites[0]!.heldReason).toMatch(/already failing its checks/);
  });
});

describe('a whole-site backup before an update', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  /** Whole-site backups on, with the last good snapshot taken at `at`. */
  function wholeSite(at: number) {
    const made = setup('kamaji');
    made.db
      .prepare("UPDATE sites SET own = 1, site_backup_schedule = 'weekly' WHERE id = ?")
      .run(SITE);
    made.db
      .prepare(
        `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id, bytes)
         VALUES (?, ?, ?, 1, ?, 1000)`,
      )
      .run(SITE, at, at, 'f'.repeat(64));
    return made;
  }
  /** The backups process, as the updater sees it: it takes the request and records a result. */
  function backupsProcess(db: Db, result: { ok: true } | { ok: false; problem: string }) {
    const taken: (string | null)[] = [];
    const sleep = async () => {
      const request = db
        .prepare('SELECT id, batch_id FROM site_backup_requests WHERE taken_at IS NULL')
        .get();
      if (!request) return;
      const batchId = request.batch_id === null ? null : String(request.batch_id);
      db.prepare('UPDATE site_backup_requests SET taken_at = ? WHERE id = ?').run(
        T,
        Number(request.id),
      );
      taken.push(batchId);
      db.prepare(
        `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id, bytes,
           problem, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        SITE,
        T,
        T + 60_000,
        result.ok ? 1 : 0,
        result.ok ? 'c'.repeat(64) : null,
        result.ok ? 184 * 1024 ** 2 : null,
        result.ok ? null : result.problem,
        batchId,
      );
    };
    return { taken, sleep };
  }

  it('a snapshot from the last day: the database export alone, as before', async () => {
    const { db, deps, site } = wholeSite(T - 2 * HOUR);
    await approve(db);
    let exports = 0;
    await runUpdater({
      ...deps(),
      backup: async () => {
        exports += 1;
        return { ok: true, words: 'Kamaji exported the database on craftish' };
      },
    });
    expect(exports).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM site_backup_requests').get()).toEqual({ n: 0 });
    expect(batchViews(db)[0]!.sites[0]!.backup).toBe(
      'Database export before update: Kamaji exported the database on craftish',
    );
    expect(backupHistory(db, SITE)[0]).toMatchObject({ state: 'exported', kind: 'export' });
    expect(site.sent.some((s) => s.endpoint === 'update')).toBe(true);
  });

  it('an older snapshot: a fresh whole-site one first, waited for, in place of the export', async () => {
    const { db, deps, site } = wholeSite(T - 3 * DAY);
    await approve(db);
    const batchId = batchViews(db)[0]!.id;
    const process = backupsProcess(db, { ok: true });
    // Without it, the site would be due for this week's backup.
    expect(dueSites(db, T)).toEqual([SITE]);
    let exports = 0;
    const updatesBefore: number[] = [];
    await runUpdater({
      ...deps(),
      sleep: async () => {
        updatesBefore.push(site.sent.filter((s) => s.endpoint === 'update').length);
        await process.sleep();
      },
      backup: async () => {
        exports += 1;
        return { ok: true, words: 'exported' };
      },
    });
    expect(process.taken).toEqual([batchId]);
    expect(updatesBefore[0]).toBe(0);
    expect(exports).toBe(0);
    expect(batchViews(db)[0]!.sites[0]).toMatchObject({
      state: 'done',
      backup: expect.stringMatching(
        /^Whole-site backup before update: snapshot cccccccc, 184\.0 MB, read back whole/,
      ),
    });
    expect(backupHistory(db, SITE)[0]).toMatchObject({
      state: 'exported',
      kind: 'snapshot',
      batchId,
      bytes: 184 * 1024 ** 2,
    });
    // It counts as this week's: the hourly run leaves the site alone now.
    expect(dueSites(db, T + HOUR)).toEqual([]);
  });

  it('a snapshot that fails holds the update, with why', async () => {
    const { db, deps, site } = wholeSite(T - 3 * DAY);
    await approve(db);
    const process = backupsProcess(db, { ok: false, problem: 'craftish: not on the allowlist' });
    await runUpdater({ ...deps(), sleep: process.sleep });
    expect(batchViews(db)[0]!.sites[0]).toMatchObject({
      state: 'held',
      heldReason:
        'Held: no backup evidence. Whole-site backup before update failed: craftish: not on the allowlist',
    });
    expect(site.sent.some((s) => s.endpoint === 'update')).toBe(false);
    expect(backupHistory(db, SITE)[0]).toMatchObject({ state: 'failed', kind: 'snapshot' });
  });

  /** The same site on Kinsta, its SSH access saved. */
  function onKinsta(made: ReturnType<typeof wholeSite>) {
    made.db.prepare("UPDATE sites SET host_kind = 'kinsta' WHERE id = ?").run(SITE);
    made.db
      .prepare(
        `INSERT INTO kinsta_access (site_id, host, port, user, updated_at, updated_by, tested_at,
           test_ok) VALUES (?, '203.0.113.7', 12345, 'site', 0, 'tylercraft@github', 0, 1)`,
      )
      .run(SITE);
    return made;
  }

  it('on Kinsta, a snapshot from the last day is the backup: there’s no export to make', async () => {
    const { db, deps, site } = onKinsta(wholeSite(T - 2 * HOUR));
    await approve(db);
    let exports = 0;
    await runUpdater({
      ...deps(),
      backup: async () => {
        exports += 1;
        return { ok: false, words: 'Kamaji makes exports only on craftish' };
      },
    });
    expect(exports).toBe(0);
    expect(batchViews(db)[0]!.sites[0]).toMatchObject({
      state: 'done',
      backup: `Whole-site backup before update: the latest snapshot, ffffffff, from ${new Date(T - 2 * HOUR).toISOString()}, under a day old`,
    });
    expect(backupHistory(db, SITE)[0]).toMatchObject({ kind: 'snapshot' });
    expect(site.sent.some((s) => s.endpoint === 'update')).toBe(true);
  });

  it('on Kinsta, an older snapshot: a fresh one first, as on craftish', async () => {
    const { db, deps } = onKinsta(wholeSite(T - 3 * DAY));
    await approve(db);
    const process = backupsProcess(db, { ok: true });
    await runUpdater({ ...deps(), sleep: process.sleep });
    expect(process.taken).toHaveLength(1);
    expect(batchViews(db)[0]!.sites[0]!.backup).toMatch(
      /^Whole-site backup before update: snapshot cccccccc/,
    );
  });

  it('a snapshot that never comes holds the update, and withdraws the request', async () => {
    const { db, deps, site } = wholeSite(T - 3 * DAY);
    await approve(db);
    let now = T;
    await runUpdater({
      ...deps(),
      now: () => now,
      sleep: async () => {
        now += 15 * 60_000;
      },
      timing: { jobTimeoutMs: 60_000, snapshotWaitMs: 60 * 60_000 },
    });
    expect(batchViews(db)[0]!.sites[0]!.heldReason).toBe(
      'Held: no backup evidence. Whole-site backup before update didn’t finish within 60 min: the backups process may not be running',
    );
    expect(site.sent.some((s) => s.endpoint === 'update')).toBe(false);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM site_backup_requests WHERE taken_at IS NULL').get(),
    ).toEqual({ n: 0 });
  });
});

describe('rollbacks, from the updater’s side', () => {
  /** A rollback the backups process pushed for the run that took Akismet to 5.7.2. */
  function pushed(db: Db, changed = 'all') {
    const batchId = String(db.prepare('SELECT id FROM batches').get()!.id);
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by,
         with_database, state, changed, step, finished_at)
       VALUES ('r1', 'rollback', ?, ?, 'craftish', ?, 'tyler', 0, 'done', ?, 'done', ?)`,
    ).run(SITE, batchId, T, changed, T);
    db.prepare(
      `INSERT INTO rollback_items (rollback_id, position, type, item, name, now_version, back_version)
       VALUES ('r1', 0, 'plugin', 'akismet/akismet.php', 'Akismet', '5.7.2', '5.3')`,
    ).run();
    db.prepare('UPDATE sites SET updating_until = ? WHERE id = ?').run(T + 15 * 60_000, SITE);
  }
  const checked = (db: Db) =>
    db.prepare('SELECT checked_at, checks_ok, checks_problem FROM rollbacks').get();

  it('holds a site’s run while a rollback waits for it', async () => {
    const { db, deps } = setup();
    expect((await approve(db)).ok).toBe(true);
    const batchId = String(db.prepare('SELECT id FROM batches').get()!.id);
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by, with_database, state)
       VALUES ('r0', 'rollback', ?, ?, 'craftish', ?, 'tyler', 0, 'waiting')`,
    ).run(SITE, batchId, T);
    await runUpdater(deps());
    expect(db.prepare('SELECT state, held_reason FROM batch_sites').get()).toEqual({
      state: 'held',
      held_reason: 'Held: a rollback is waiting or running for this site',
    });
    expect(outcomes(db).every(([, state]) => state === 'held')).toBe(true);
  });

  it('checks a pushed rollback as an update is checked, the versions from a fresh report, then ends the pause', async () => {
    const { db, deps, site, worker } = setup();
    expect((await approve(db)).ok).toBe(true);
    await runUpdater(deps());
    expect(site.akismet).toBe('5.7.2');
    pushed(db);
    site.akismet = '5.3';
    worker.length = 0;
    await runUpdater(deps());
    expect(checked(db)).toEqual({ checked_at: T, checks_ok: 1, checks_problem: null });
    // Its report has WordPress rerun the update checks the push had it forget.
    expect(site.sent.filter((s) => s.endpoint === 'report').at(-1)?.body).toEqual({
      refresh: true,
    });
    expect(db.prepare('SELECT updating_until FROM sites').get()!.updating_until).toBeNull();
    expect(worker).toContain(`POST /v1/check/${SITE}`);
    expect(
      db.prepare("SELECT summary FROM events WHERE kind = 'site.rollback'").get()!.summary,
    ).toBe('Rolled back One: Akismet 5.7.2 → 5.3; checks passed');
  });

  it('fails the checks when the report doesn’t show what the rollback put back, or the home page fails', async () => {
    const { db, deps, site } = setup();
    expect((await approve(db)).ok).toBe(true);
    await runUpdater(deps());
    pushed(db);
    site.homeOk = false;
    await runUpdater(deps());
    expect(checked(db)).toEqual({
      checked_at: T,
      checks_ok: 0,
      checks_problem: 'home page: PHP error on the page; Akismet is at 5.7.2, not 5.3',
    });
    expect(
      db.prepare("SELECT summary FROM events WHERE kind = 'site.rollback-failed'").get()!.summary,
    ).toContain('checks failed');
  });

  const NEW_RELEASE = 'WordPress update available (7.1.5)';

  it('measures Site Health against the last report before the rollback, not the run’s baseline', async () => {
    const { db, deps, site } = setup();
    expect((await approve(db)).ok).toBe(true);
    await runUpdater(deps());
    // Days after the run, WordPress offers a release the run's baseline didn't know of, and the
    // site's report says so before the rollback is asked for.
    site.health = [NEW_RELEASE];
    recordObservation(db, {
      resourceType: 'site',
      resourceId: SITE,
      check: 'report',
      source: 'plugin',
      at: T,
      ok: true,
      value: { ok: true, siteHealth: CareReport.parse(site.report()).site_health },
    });
    pushed(db);
    site.akismet = '5.3';
    await runUpdater(deps());
    expect(checked(db)).toEqual({ checked_at: T, checks_ok: 1, checks_problem: null });
  });

  it('still fails an item that’s new since that report', async () => {
    const { db, deps, site } = setup();
    expect((await approve(db)).ok).toBe(true);
    await runUpdater(deps());
    pushed(db);
    site.akismet = '5.3';
    site.health = ['A plugin has failed to load'];
    await runUpdater(deps());
    expect(checked(db)).toMatchObject({
      checks_ok: 0,
      checks_problem: 'Site Health: A plugin has failed to load',
    });
  });

  it('falls back to the run’s baseline when there’s no report from before the rollback', async () => {
    const { db, deps, site } = setup();
    expect((await approve(db)).ok).toBe(true);
    await runUpdater(deps());
    db.prepare("DELETE FROM observations WHERE check_name = 'report'").run();
    pushed(db);
    site.akismet = '5.3';
    site.health = [NEW_RELEASE];
    await runUpdater(deps());
    expect(checked(db)).toMatchObject({
      checks_ok: 0,
      checks_problem: `Site Health: ${NEW_RELEASE}`,
    });
  });
});

describe('screenshot checks, from the updater’s side', () => {
  /** A screenshots process that finishes each set as soon as it's started. */
  function shots(db: Db, order: string[]) {
    return {
      start: () => {
        const set = db
          .prepare("SELECT id, kind FROM screenshot_sets WHERE state = 'waiting'")
          .get();
        if (!set) return;
        order.push(`shots ${String(set.kind)}`);
        db.prepare("UPDATE screenshot_sets SET state = 'done' WHERE id = ?").run(String(set.id));
      },
    };
  }

  it('shoots just before the first update and just after the last', async () => {
    const { db, deps, site } = setup();
    expect((await approve(db)).ok).toBe(true);
    const order: string[] = [];
    const send = deps().send;
    await runUpdater({
      ...deps(),
      screenshots: shots(db, order),
      send: async (home, key, endpoint, body, options) => {
        if (endpoint === 'update') order.push(`update ${String(body.item)}`);
        return send(home, key, endpoint, body, options);
      },
    });
    expect(order).toEqual([
      'shots before',
      'update core',
      'update akismet/akismet.php',
      'shots after',
    ]);
    expect(site.akismet).toBe('5.7.2');
    expect(
      db
        .prepare(
          'SELECT kind, batch_id IS NOT NULL AS run FROM screenshot_sets ORDER BY requested_at, rowid',
        )
        .all(),
    ).toEqual([
      { kind: 'before', run: 1 },
      { kind: 'after', run: 1 },
    ]);
  });

  it('shoots after a held site too, and a run without them takes none', async () => {
    const { db, deps, site } = setup();
    expect((await approve(db)).ok).toBe(true);
    site.behave.breaksHomePage = true;
    const order: string[] = [];
    await runUpdater({ ...deps(), screenshots: shots(db, order) });
    expect(outcomes(db)[0]).toEqual(['core', 'done', 'checks_failed']);
    expect(order).toEqual(['shots before', 'shots after']);

    const plain = setup();
    expect((await approve(plain.db)).ok).toBe(true);
    await runUpdater(plain.deps());
    expect(plain.db.prepare('SELECT COUNT(*) AS n FROM screenshot_sets').get()).toEqual({ n: 0 });
  });

  it('a screenshot failure changes nothing about the run', async () => {
    const { db, deps } = setup();
    expect((await approve(db)).ok).toBe(true);
    await runUpdater({
      ...deps(),
      screenshots: {
        start: () =>
          db
            .prepare(
              "UPDATE screenshot_sets SET state = 'failed', problem = 'Docker isn’t answering'",
            )
            .run(),
      },
    });
    expect(outcomes(db).every(([, , outcome]) => outcome === 'passed')).toBe(true);
    expect(db.prepare('SELECT state FROM batch_sites').get()).toEqual({ state: 'done' });
  });
});

describe('a rule’s run, from the updater’s side (ops/rules-plan.md)', () => {
  const tyler = testAuthenticator();
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  // T is on the hour, so the rule's update time is T itself.
  const wall = wallClock(KAMAJI_ZONE, T);
  const rule = (patch: Partial<RuleBody> = {}): RuleBody => ({
    ruleId: null,
    name: 'Minor plugin updates',
    sites: [{ id: SITE, url: 'https://one.test/', backup: 'host' }],
    types: ['plugin'],
    only: [],
    leaveOut: ['woocommerce'],
    change: 'minor',
    waitDays: 3,
    securityWaitDays: 0,
    when: { weekday: wall.weekday, hour: wall.hour },
    most: { perSite: 10, sites: 10 },
    ...patch,
  });
  /** What the page sends: the body as signed, and the passkey's proof over it. */
  const sign = (body: RuleBody, path = '/api/rules') => {
    const text = JSON.stringify(body);
    const nonce = randomBytes(32).toString('base64url');
    return JSON.stringify({
      body: text,
      proof: tyler.assert(nonce, challengeFor(nonce, 'POST', path, bodyHash(text))),
    });
  };
  const AFTER = T + HOUR + 60_000;

  function ruled(body = rule(), approval = sign(body)) {
    const s = setup('host');
    const { id } = saveRule(s.db, body, approval, 'tyler', T - DAY);
    let release = { version: '5.7.2', at: T - 10 * DAY };
    const org: OrgLookup = async () => release;
    const hosts: string[] = [];
    const run = (now: number, extra: Partial<UpdaterDeps> = {}) => {
      const base = s.deps();
      return runUpdater({
        ...base,
        now: () => now,
        send: (home, key, endpoint, body, options) => {
          hosts.push(`${endpoint} ${home.host}`);
          return base.send(home, key, endpoint, body, options);
        },
        ruleApproval: (r, v) => ruleApprovalProblem(s.db, tyler.config, r, v),
        org,
        ...extra,
      });
    };
    return {
      ...s,
      id,
      org,
      run,
      hosts,
      sent: () => hosts.filter((h) => h.startsWith('update ')),
      releasedAt: (at: number) => (release = { version: '5.7.2', at }),
    };
  }

  const ruleState = (db: Db, id: string) =>
    db.prepare('SELECT paused_by, paused_reason FROM rules WHERE id = ?').get(id);
  const items = (db: Db) =>
    db
      .prepare('SELECT site_id, item, state, outcome, detail FROM batch_items ORDER BY site_id')
      .all()
      .map((r) => ({ ...r }));

  it('waits out its hour after the update time, then runs what it matches, never core', async () => {
    const r = ruled();
    expect(await makeRuleRuns(r.db, T, r.org)).toBe(1);
    // Once per update time.
    expect(await makeRuleRuns(r.db, T + 60_000, r.org)).toBe(0);
    expect(queue(r.db).items.map((i) => i.item)).toEqual(['core']);
    await r.run(T + 30 * 60_000);
    expect(r.sent()).toEqual([]);
    await r.run(AFTER);
    expect(r.sent()).toEqual(['update one.test']);
    expect([r.site.akismet, r.site.core]).toEqual(['5.7.2', '7.1.3']);
    const view = batchViews(r.db)[0]!;
    expect(view).toMatchObject({ approvedBy: 'rule', oneSiteFirst: true });
    expect(view.rule).toMatchObject({ id: r.id, name: 'Minor plugin updates', version: 1 });
    expect(outcomes(r.db)).toEqual([['plugin', 'done', 'passed']]);
    expect(ruleState(r.db, r.id)).toEqual({ paused_by: null, paused_reason: null });
  });

  describe('runs nothing when the signed rule doesn’t hold, and pauses it', () => {
    async function refused(
      r: ReturnType<typeof ruled>,
      problem: RegExp,
      now = AFTER,
    ): Promise<void> {
      await r.run(now);
      expect(r.sent()).toEqual([]);
      expect(r.site.akismet).toBe('5.3');
      const site = batchViews(r.db)[0]!.sites[0]!;
      expect(site.state).toBe('held');
      expect(site.heldReason).toMatch(problem);
      // Its update is back in the queue, for Tyler.
      expect(items(r.db)).toMatchObject([{ state: 'done', outcome: null }]);
      expect(queue(r.db).items.map((i) => i.item)).toContain('akismet/akismet.php');
      expect(ruleState(r.db, r.id)).toMatchObject({ paused_by: 'kamaji' });
      expect(openIssues(r.db)).toContainEqual(
        expect.objectContaining({ kind: 'rule-paused', severity: 'urgent' }),
      );
    }

    it('a body changed after it was signed', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      const stored = JSON.parse(
        String(r.db.prepare('SELECT approval FROM rule_versions').get()!.approval),
      ) as { body: string; proof: unknown };
      const wider = { ...rule(), change: 'security', waitDays: 0 };
      r.db
        .prepare('UPDATE rule_versions SET approval = ?')
        .run(JSON.stringify({ ...stored, body: JSON.stringify(wider) }));
      await refused(r, /passkey/);
    });

    it('a proof signed for another write', async () => {
      const r = ruled(rule(), sign(rule(), '/api/batches'));
      await makeRuleRuns(r.db, T, r.org);
      await refused(r, /passkey/);
    });

    it('a nonce that signed something else too', async () => {
      const approval = sign(rule());
      const r = ruled(rule(), approval);
      await makeRuleRuns(r.db, T, r.org);
      r.db
        .prepare(
          `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, approval)
           VALUES ('other', 0, 'tyler', 0, 'finished', ?)`,
        )
        .run(approval);
      await refused(r, /more than once/);
    });

    it('a rule changed after its run was set out, or paused, or deleted', async () => {
      const changed = ruled();
      await makeRuleRuns(changed.db, T, changed.org);
      const next = rule({ ruleId: changed.id });
      saveRule(changed.db, next, sign(next), 'tyler', T + 60_000);
      await refused(changed, /changed after this run/);

      const paused = ruled();
      await makeRuleRuns(paused.db, T, paused.org);
      pauseRule(paused.db, paused.id, 'tyler', 'Paused by Tyler', T + 60_000);
      await paused.run(AFTER);
      expect(paused.sent()).toEqual([]);
      expect(batchViews(paused.db)[0]!.sites[0]!.heldReason).toMatch(/the rule is paused/);
      // Tyler's own pause stands, with his reason, and raises nothing.
      expect(ruleState(paused.db, paused.id)).toMatchObject({ paused_by: 'tyler' });
    });

    it('too late after its update time', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      await refused(r, /too late/, T + 7 * HOUR);
    });

    it('a run whose start was moved earlier in the database', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      r.db.prepare('UPDATE batches SET starts_at = ?').run(T);
      await refused(r, /too early/, T + 10 * 60_000);
    });
  });

  describe('a change to a site’s row can’t widen a signed rule', () => {
    function another(db: Db, id: string) {
      db.prepare(
        `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, expected_text, own, created_at)
         VALUES (?, 'Two', ?, 'craftish', 'connected', 'done', 'host', 'Two', 1, 0)`,
      ).run(id, `https://${id}/`);
      recordObservation(db, {
        resourceType: 'site',
        resourceId: id,
        check: 'hello',
        source: 'plugin',
        at: T,
        ok: true,
        value: { ok: true, hello: new FakeSite().hello() },
      });
      storeReport(db, { id, name: 'Two' }, CareReport.parse(new FakeSite().report()), T);
    }

    it('a site the rule doesn’t name, added to its run: nothing runs anywhere', async () => {
      const r = ruled();
      another(r.db, 'two.test');
      await makeRuleRuns(r.db, T, r.org);
      // The rule never took two.test, own site or not.
      expect(batchViews(r.db)[0]!.sites.map((s) => s.siteId)).toEqual([SITE]);
      const batch = String(r.db.prepare('SELECT id FROM batches').get()!.id);
      r.db
        .prepare(
          `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, state)
           VALUES (?, 'two.test', 1, 'host', 'waiting')`,
        )
        .run(batch);
      r.db
        .prepare(
          `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version, to_version, state)
           VALUES ('forged', ?, 'two.test', 0, 'plugin', 'akismet/akismet.php', 'Akismet', '5.3', '5.7.2', 'waiting')`,
        )
        .run(batch);
      await r.run(AFTER);
      expect(r.sent()).toEqual([]);
      expect(
        batchViews(r.db)[0]!.sites.map((s) => [
          s.siteId,
          s.state,
          s.heldReason?.includes('two.test isn’t one of the rule’s sites'),
        ]),
      ).toEqual([
        [SITE, 'held', true],
        ['two.test', 'held', true],
      ]);
    });

    it('a new address in the row: nothing goes to it, or to the old one', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      r.db.prepare("UPDATE sites SET url = 'https://elsewhere.test/' WHERE id = ?").run(SITE);
      await r.run(AFTER);
      expect(r.hosts.some((h) => h.includes('elsewhere.test'))).toBe(false);
      expect(r.sent()).toEqual([]);
      expect(batchViews(r.db)[0]!.sites[0]!.heldReason).toBe(
        'Not run: its address changed since the rule was signed',
      );
      expect(ruleState(r.db, r.id)).toMatchObject({ paused_by: 'kamaji' });
    });

    it('a backup changed in the row, from what was signed: not run', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      r.db.prepare("UPDATE sites SET backup_expectation = 'tyler' WHERE id = ?").run(SITE);
      await r.run(AFTER);
      expect(r.sent()).toEqual([]);
      expect(batchViews(r.db)[0]!.sites[0]!.heldReason).toBe(
        'Not run: its backup changed since the rule was signed',
      );
    });

    it('a release dated long ago in the row, or a major written into the run: left out', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      // Kamaji's own record says the offer is old; wordpress.org says it came out yesterday.
      r.db.prepare('UPDATE components SET offer_seen_at = 0').run();
      r.releasedAt(AFTER - DAY);
      await r.run(AFTER);
      expect(r.sent()).toEqual([]);
      expect(items(r.db)).toMatchObject([
        { state: 'done', outcome: null, detail: 'Left out: out 1 day; the rule waits 3 days' },
      ]);
      // Left out isn't a failure: the rule carries on.
      expect(ruleState(r.db, r.id)).toEqual({ paused_by: null, paused_reason: null });

      const major = ruled();
      await makeRuleRuns(major.db, T, major.org);
      major.db.prepare("UPDATE batch_items SET to_version = '6.0'").run();
      major.db
        .prepare("UPDATE components SET offer_version = '6.0' WHERE item = 'akismet/akismet.php'")
        .run();
      await major.run(AFTER);
      expect(major.sent()).toEqual([]);
      expect(items(major.db)).toMatchObject([
        { detail: 'Left out: WordPress no longer offers this version' },
      ]);
    });

    it('a backup and baseline written into the run don’t stand in for its own', async () => {
      const r = ruled();
      await makeRuleRuns(r.db, T, r.org);
      r.db
        .prepare('UPDATE batch_sites SET backup = ?, baseline = ?')
        .run('forged', JSON.stringify({ ok: true, problems: [], siteHealth: [] }));
      r.site.homeOk = false;
      await r.run(AFTER);
      expect(r.sent()).toEqual([]);
      expect(batchViews(r.db)[0]!.sites[0]!.heldReason).toMatch(
        /already failing its checks before any update/,
      );
    });
  });

  it('a held site pauses the whole rule, and the rest of its run goes back to the queue', async () => {
    const body = rule({
      sites: [
        { id: SITE, url: 'https://one.test/', backup: 'host' },
        { id: 'two.test', url: 'https://two.test/', backup: 'host' },
      ],
    });
    const r = ruled(body);
    r.db
      .prepare(
        `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, expected_text, created_at)
       VALUES ('two.test', 'Two', 'https://two.test/', 'craftish', 'connected', 'done', 'host', 'Two', 0)`,
      )
      .run();
    recordObservation(r.db, {
      resourceType: 'site',
      resourceId: 'two.test',
      check: 'hello',
      source: 'plugin',
      at: T,
      ok: true,
      value: { ok: true, hello: r.site.hello() },
    });
    storeReport(r.db, { id: 'two.test', name: 'Two' }, CareReport.parse(r.site.report()), T);
    await makeRuleRuns(r.db, T, r.org);
    r.site.behave.breaksHomePage = true;
    await r.run(AFTER);
    expect(r.sent()).toEqual(['update one.test']);
    const sites = batchViews(r.db)[0]!.sites;
    expect(sites.map((s) => [s.siteId, s.state])).toEqual([
      [SITE, 'held'],
      ['two.test', 'held'],
    ]);
    expect(sites[1]!.heldReason).toBe('the rule paused: One was held');
    expect(ruleState(r.db, r.id)).toEqual({
      paused_by: 'kamaji',
      paused_reason: 'its run stopped: One was held',
    });
    expect(
      queue(r.db)
        .items.filter((i) => i.siteId === 'two.test')
        .map((i) => i.item),
    ).toContain('akismet/akismet.php');
    // A rule's run never carries on.
    expect(carryOn(r.db, batchViews(r.db)[0]!.id, SITE, 'tyler', AFTER)).toBe(false);
  });

  it('screenshots that changed pause the rule, though the run passed', async () => {
    const r = ruled();
    await makeRuleRuns(r.db, T, r.org);
    const screenshots = {
      start: () => {
        const set = r.db
          .prepare("SELECT id, kind, site_id FROM screenshot_sets WHERE state = 'waiting'")
          .get();
        if (!set) return;
        r.db.prepare("UPDATE screenshot_sets SET state = 'done' WHERE id = ?").run(String(set.id));
        if (set.kind === 'after') {
          const before = r.db
            .prepare("SELECT id FROM screenshot_sets WHERE kind = 'before'")
            .get()!;
          r.db
            .prepare(
              `INSERT INTO screenshot_comparisons (set_id, against_set_id, site_id, page_url, viewport, compared, changed_pct, at)
               VALUES (?, ?, ?, 'https://one.test/', 'desktop', 'page', 5, 0)`,
            )
            .run(String(set.id), String(before.id), SITE);
        }
      },
    };
    await r.run(AFTER, { screenshots });
    expect(outcomes(r.db)).toEqual([['plugin', 'done', 'passed']]);
    expect(ruleState(r.db, r.id)).toEqual({
      paused_by: 'kamaji',
      paused_reason: 'its run stopped: the screenshots changed on One',
    });
  });
});
