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
import { runUpdater, type UpdaterDeps } from './run.js';

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
      heldReason: 'Held: no backup evidence. The export on craftish failed: the export failed',
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
