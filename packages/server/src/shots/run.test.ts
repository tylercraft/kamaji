import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { testDb } from '../testing.js';
import { BLOCKED_HOSTS } from './blocked.js';
import {
  dockerArgs,
  KEEP_MS,
  orphanedSets,
  readShots,
  retain,
  runShots,
  type ShotsDeps,
} from './run.js';
import {
  MANUAL_WAIT_MS,
  requestSet,
  runScreenshots,
  setDir,
  setFile,
  setView,
  siteScreenshots,
  staleManual,
} from './sets.js';
import { runLines } from '../updates/announce.js';
import { batch, fakeDocker, site, T, type FakeShot } from './testShots.js';

function setup(shot?: (round: number, position: number, viewport: string) => FakeShot) {
  const db = testDb();
  site(db);
  batch(db);
  const dir = mkdtempSync(join(tmpdir(), 'kamaji-shots-'));
  const docker = fakeDocker(shot);
  let now = T;
  const deps: ShotsDeps = {
    db,
    exec: docker.exec,
    docker: '/usr/local/bin/docker',
    dir,
    seccomp: '/repo/shots/seccomp.json',
    image: 'kamaji-shots:abcdef012345',
    now: () => now,
    log: () => {},
  };
  return { db, dir, deps, docker, tick: (ms: number) => (now += ms) };
}

const ask = (db: Db, kind: 'before' | 'after' | 'manual', at = T) =>
  requestSet(
    db,
    { siteId: 'one.test', batchId: kind === 'manual' ? null : 'b1', kind, by: null },
    at,
  )!;

describe('taking a set', () => {
  it('shoots each page at both sizes, twice for “before”, in a locked-down container', async () => {
    const { db, deps, docker, dir } = setup();
    const id = ask(db, 'before');
    await runShots(deps);
    const run = docker.calls.find((c) => c[0] === 'run')!;
    expect(run.slice(0, -1)).toEqual(
      dockerArgs(deps, `kamaji-shots-${id}`, join(dir, 'one.test', id), {}).slice(0, -1),
    );
    expect(run).toEqual(
      expect.arrayContaining([
        '--read-only',
        'no-new-privileges',
        'seccomp=/repo/shots/seccomp.json',
        '--pull',
        'never',
      ]),
    );
    // Not on an internal network: it needs the internet. No mount but its own folder.
    expect(run.filter((a) => a === '--volume')).toHaveLength(1);
    expect(run).not.toContain('--network');
    const job = JSON.parse(run.at(-1)!);
    expect(job).toMatchObject({
      rounds: 2,
      pages: ['https://one.test/', 'https://one.test/shop/'],
      blocked: BLOCKED_HOSTS,
      maxHeight: 15_000,
    });
    expect(job.viewports.map((v: { width: number }) => v.width)).toEqual([1440, 390]);
    const view = setView(db, id)!;
    expect(view).toMatchObject({ state: 'done', problem: null });
    expect(view.shots.map((s) => [s.pageUrl, s.viewport])).toEqual([
      ['https://one.test/', 'desktop'],
      ['https://one.test/', 'mobile'],
      ['https://one.test/shop/', 'desktop'],
      ['https://one.test/shop/', 'mobile'],
    ]);
    expect(view.shots[0]!.image).toBe(`/api/screenshots/${id}/r1-p0-desktop.png`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM screenshots WHERE round = 2').get()).toEqual({
      n: 4,
    });
  });

  it('compares “after” with “before”, masks what moved between the two “before” rounds, then drops that round', async () => {
    // The home page's band moves between the "before" rounds (a carousel); the shop's header
    // moves only after the update.
    const { db, deps, dir } = setup((round, position) =>
      position === 0 ? { band: round === 2 ? 50 : 0 } : { band: round === 3 ? 30 : 0 },
    );
    const before = ask(db, 'before');
    await runShots(deps);
    // "after" is the fake's third round of the same pages.
    const after = ask(db, 'after', T + 60_000);
    const { exec } = fakeDocker((_r, position) => (position === 0 ? {} : { band: 30 }));
    await runShots({ ...deps, exec });
    const view = setView(db, after)!;
    expect(view.comparisons.map((c) => [c.pageUrl, c.viewport, c.compared, c.changedPct])).toEqual([
      ['https://one.test/', 'desktop', 'page', 0],
      ['https://one.test/', 'mobile', 'page', 0],
      ['https://one.test/shop/', 'desktop', 'page', 20],
      ['https://one.test/shop/', 'mobile', 'page', 20],
    ]);
    expect(view.comparisons[0]!.maskedPct).toBeGreaterThan(0);
    expect(view.comparisons[2]!.diff).toBe(`/api/screenshots/${after}/diff-p1-desktop.png`);
    expect(existsSync(join(dir, 'one.test', after, 'diff-p1-desktop.png'))).toBe(true);
    // The mask round's images are gone; the first round's stay.
    expect(readdirSync(join(dir, 'one.test', before)).filter((f) => f.startsWith('r2-'))).toEqual(
      [],
    );
    expect(existsSync(join(dir, 'one.test', before, 'r1-p0-desktop.png'))).toBe(true);
    expect(runScreenshots(db, 'b1', 'one.test')).toMatchObject({
      before: { state: 'done' },
      after: { state: 'done' },
      comparisons: [{}, {}, {}, {}],
    });
  });

  it('says what’s new after: JavaScript errors and failed requests not seen in either “before” round', async () => {
    const { db, deps } = setup((round) => ({
      jsKeys: round === 2 ? ['aaaaaaaaaaaaaaaa'] : [],
      failedKeys: ['GET one.test/a.js 404'],
    }));
    ask(db, 'before');
    await runShots(deps);
    const after = ask(db, 'after', T + 60_000);
    const { exec } = fakeDocker(() => ({
      jsKeys: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      failedKeys: ['GET one.test/a.js 404', 'GET one.test/b.css 500'],
    }));
    await runShots({ ...deps, exec });
    expect(setView(db, after)!.comparisons[0]).toMatchObject({
      newJsErrors: 1,
      newFailedRequests: 1,
    });
  });

  it('a page shot before but not after is reported, and one the bot check answered says so', async () => {
    const { db, deps } = setup();
    ask(db, 'before');
    await runShots(deps);
    const after = ask(db, 'after', T + 60_000);
    const { exec } = fakeDocker((_r, position, viewport) =>
      position === 1
        ? viewport === 'desktop'
          ? { ok: false, problem: 'the page answered HTTP 500' }
          : {
              ok: false,
              blocked: true,
              problem: 'Cloudflare’s bot check answered instead of the page',
            }
        : {},
    );
    await runShots({ ...deps, exec });
    const view = setView(db, after)!;
    expect(view.state).toBe('done');
    expect(view.comparisons.slice(2).map((c) => [c.compared, c.problem])).toEqual([
      ['none', 'it was shot before, but not after: the page answered HTTP 500'],
      ['none', 'Cloudflare’s bot check answered instead of the page'],
    ]);
    expect(view.shots[3]).toMatchObject({ blocked: true, image: null });
  });

  it('compares only the first screen when a page got taller', async () => {
    const { db, deps } = setup();
    ask(db, 'before');
    await runShots(deps);
    const after = ask(db, 'after', T + 60_000);
    const { exec } = fakeDocker(() => ({ height: 400 }));
    await runShots({ ...deps, exec });
    expect(setView(db, after)!.comparisons[0]).toMatchObject({
      compared: 'first screen',
      heightBefore: 100,
      heightAfter: 400,
    });
  });

  it('one taken by hand is compared with the site’s last set, and asked twice is one', async () => {
    const { db, deps } = setup();
    ask(db, 'before');
    await runShots(deps);
    const a = ask(db, 'manual', T + 60_000);
    expect(ask(db, 'manual', T + 61_000)).toBe(a);
    await runShots(deps);
    expect(setView(db, a)!.comparisons).toHaveLength(4);
    expect(siteScreenshots(db, 'one.test')).toMatchObject({
      latest: { id: a, kind: 'manual' },
      pending: null,
      pages: ['https://one.test/', 'https://one.test/shop/'],
      settings: { hide: [], mask: [] },
    });
  });
});

describe('when it goes wrong', () => {
  it('a container that took no shots fails the set, in words', async () => {
    const { db, deps } = setup();
    const id = ask(db, 'manual');
    const { exec } = fakeDocker(undefined, { skipRun: true, code: 125 });
    await runShots({ ...deps, exec });
    expect(setView(db, id)).toMatchObject({
      state: 'failed',
      problem: 'Docker couldn’t start the browser',
    });
  });

  it('at its cap, the container is killed and the shots it finished are kept', async () => {
    const { db, deps } = setup();
    const id = ask(db, 'manual');
    const full = fakeDocker();
    const calls: string[][] = [];
    const exec: ShotsDeps['exec'] = async (command, args, options) => {
      calls.push(args);
      const ran = await full.exec(command, args, options);
      if (args[0] !== 'run') return ran;
      // Killed after the first shot.
      return { code: null, stdout: ran.stdout.split('\n')[0]! };
    };
    await runShots({ ...deps, exec });
    expect(calls.some((c) => c[0] === 'kill' && c[1] === `kamaji-shots-${id}`)).toBe(true);
    expect(setView(db, id)).toMatchObject({
      state: 'done',
      problem: 'it took too long: 1 of 4 shots were finished',
    });
  });

  it('a set the updater stopped waiting for keeps nothing', async () => {
    const { db, deps, dir } = setup();
    const id = ask(db, 'before');
    const exec: ShotsDeps['exec'] = async (command, args, options) => {
      db.prepare(
        "UPDATE screenshot_sets SET state = 'failed', problem = 'gave up' WHERE id = ?",
      ).run(id);
      return fakeDocker().exec(command, args, options);
    };
    await runShots({ ...deps, exec });
    expect(setView(db, id)).toMatchObject({ state: 'failed', problem: 'gave up' });
    expect(existsSync(join(dir, 'one.test', id))).toBe(false);
  });

  it('ignores lines that aren’t shots, and file names it didn’t ask for', async () => {
    expect(
      readShots(
        [
          'Chromium says hello',
          '{"format":1,"kind":"shot","round":1,"position":0,"viewport":"desktop","ok":true,"file":"../../etc/passwd"}',
          '{"format":1,"kind":"done"}',
        ].join('\n'),
      ),
    ).toMatchObject({ done: true, shots: [{ file: '../../etc/passwd' }] });
    const { db, deps } = setup();
    const id = ask(db, 'manual');
    const exec: ShotsDeps['exec'] = async (_c, args) =>
      args[0] === 'run'
        ? {
            code: 0,
            stdout:
              '{"format":1,"kind":"shot","round":1,"position":0,"viewport":"desktop","ok":true,"file":"../../etc/passwd"}',
          }
        : { code: 0, stdout: '' };
    await runShots({ ...deps, exec });
    expect(setView(db, id)).toMatchObject({ state: 'failed', shots: [{ image: null }] });
  });

  it('one taken by hand that waited 15 minutes fails, so the page doesn’t wait forever', () => {
    const { db } = setup();
    const id = ask(db, 'manual');
    expect(staleManual(db, T + MANUAL_WAIT_MS - 1)).toBe(0);
    expect(staleManual(db, T + MANUAL_WAIT_MS + 1)).toBe(1);
    expect(setView(db, id)).toMatchObject({
      state: 'failed',
      problem: 'the screenshots process didn’t start',
    });
  });

  it('marks sets left running when the process stopped', () => {
    const { db } = setup();
    const id = ask(db, 'manual');
    db.prepare("UPDATE screenshot_sets SET state = 'running'").run();
    orphanedSets(db, T);
    expect(setView(db, id)).toMatchObject({
      state: 'failed',
      problem: 'the screenshots process stopped while it shot',
    });
  });
});

describe('serving and keeping', () => {
  it('serves only files a set’s rows name, never a path as given', async () => {
    const { db, deps, dir } = setup();
    const id = ask(db, 'manual');
    await runShots(deps);
    expect(setFile(db, dir, id, 'r1-p0-desktop.png')).toEqual({
      path: join(dir, 'one.test', id, 'r1-p0-desktop.png'),
      type: 'image/png',
    });
    expect(setFile(db, dir, id, 'r1-p0-desktop.jpg')?.type).toBe('image/jpeg');
    for (const bad of ['../kamaji.db', 'r1-p9-desktop.png', 'x.svg'])
      expect(setFile(db, dir, id, bad)).toBeNull();
    expect(setFile(db, dir, 'ffffffffffffffff', 'r1-p0-desktop.png')).toBeNull();
    expect(setDir(dir, '../etc', id)).toBeNull();
  });

  it('keeps 30 days, and each site’s latest set with the “before” it was compared with', async () => {
    const { db, deps, dir } = setup();
    const old = ask(db, 'manual');
    await runShots(deps);
    const before = ask(db, 'before', T + 1000);
    await runShots(deps);
    const after = ask(db, 'after', T + 2000);
    await runShots(deps);
    expect(await retain(deps, T + KEEP_MS + 10_000)).toBe(1);
    expect(setView(db, old)).toBeNull();
    expect(existsSync(join(dir, 'one.test', old))).toBe(false);
    expect(setView(db, before)).not.toBeNull();
    expect(setView(db, after)!.comparisons).toHaveLength(4);
  });
});

describe('Discord', () => {
  it('adds a count of pages that changed, never which, and nothing when none did', async () => {
    const { db, deps } = setup();
    db.prepare(
      `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state, finished_at)
       VALUES ('b1', 'one.test', 0, 'host', 'the host’s daily backup', 'done', ?)`,
    ).run(T + 5000);
    db.prepare(
      `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version, to_version, state, outcome)
       VALUES ('i1', 'b1', 'one.test', 0, 'plugin', 'a/a.php', 'A', '1', '2', 'done', 'passed')`,
    ).run();
    ask(db, 'before');
    await runShots(deps);
    expect(runLines(db, 'b1')[0]).not.toContain('screenshots');
    ask(db, 'after', T + 60_000);
    const { exec } = fakeDocker((_r, position) => (position === 1 ? { band: 30 } : {}));
    await runShots({ ...deps, exec });
    const line = runLines(db, 'b1')[0]!;
    expect(line).toMatch(/; screenshots changed on 1 page$/);
    expect(line).not.toContain('shop');
  });
});
