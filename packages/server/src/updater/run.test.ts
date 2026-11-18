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

  report(): unknown {
    const r = structuredClone(REPORT);
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
