// Rollback end to end against the local DDEV WordPress (dev/README.md), laptop only, never the
// mini or a real site: `npm run test:rollback`. The real push script, run as Kinsta runs it (the
// site's own user, its WordPress at ~/public), with a home whose `public` is the DDEV site; the
// restore point a real pull of the site (kinsta-pull/pull); the "run" real updates through
// wp-cli; and Kamaji's own code between them (rollback/push.ts), with the snapshot served from
// the pull's tar. It rolls back the files, undoes that, rolls back with the database, and undoes
// that too, checking the site with wp-cli and its home page each time; then puts the site back
// as it found it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../packages/server/src/db.js';
import { realExec } from '../packages/server/src/sitebackups/exec.js';
import type { Restic } from '../packages/server/src/sitebackups/restic.js';
import { testDb } from '../packages/server/src/testing.js';
import { requestRollback, requestUndo } from '../packages/server/src/rollback/request.js';
import { runRollback, type PushDeps } from '../packages/server/src/rollback/push.js';

const CONTAINER = 'ddev-kamaji-wp-web';
const SITE = 'kamaji-wp.ddev.site';
const ROOT = '/var/www/html';
/** The test's home in the container: `public` is the DDEV site, the hold beside it. */
const E2E = `${ROOT}/.kamaji-e2e`;
// DDEV's own user and group for `ddev exec` (uid 501, gid 20), which own the site's files.
const UID = '501:20';
const PUSH = readFileSync(new URL('push', import.meta.url), 'utf8');
const PULL = readFileSync(new URL('../kinsta-pull/pull', import.meta.url), 'utf8');

const inDdev = (script: string, input?: Buffer) =>
  execFileSync(
    'docker',
    ['exec', '-i', '-u', UID, '-e', `HOME=${E2E}`, CONTAINER, 'bash', '-c', script],
    {
      ...(input ? { input } : {}),
      maxBuffer: 1024 ** 3,
    },
  );
const wp = (args: string) =>
  inDdev(`cd ${ROOT} && wp ${args} --skip-plugins --skip-themes`).toString().trim();
const versions = () => ({
  core: wp('core version'),
  akismet: wp('plugin get akismet --field=version'),
  theme: wp('theme get twentytwentyfour --field=version'),
});
const home = () =>
  execFileSync('curl', [
    '-sk',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    `https://${SITE}/`,
  ]).toString();

let start: { core: string; akismet: string; theme: string };
let snapshot: Buffer;
let db: Db;
let deps: PushDeps;
let comment = '';

function setUpKamaji(before: typeof start, after: typeof start, snapshotAt: number) {
  db = testDb();
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule, created_at)
     VALUES (?, 'DDEV', ?, 'kinsta', 'connected', 'done', 1, 'weekly', 0)`,
  ).run(SITE, `https://${SITE}/`);
  db.prepare(
    `INSERT INTO kinsta_access (site_id, host, port, user, updated_at, updated_by, tested_at, test_ok)
     VALUES (?, 'ddev', 22, 'tyler', 0, 'tyler', 0, 1)`,
  ).run(SITE);
  db.prepare(
    `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, finished_at)
     VALUES ('ddev-run', ?, 'tyler', 0, 'finished', ?)`,
  ).run(snapshotAt + 1000, snapshotAt + 2000);
  db.prepare(
    `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state, started_at, finished_at)
     VALUES ('ddev-run', ?, 0, 'kamaji', 'words', 'done', ?, ?)`,
  ).run(SITE, snapshotAt + 1000, snapshotAt + 2000);
  const items = [
    ['core', 'core', 'WordPress', before.core, after.core],
    ['plugin', 'akismet/akismet.php', 'Akismet', before.akismet, after.akismet],
    ['theme', 'twentytwentyfour', 'Twenty Twenty-Four', before.theme, after.theme],
  ] as const;
  items.forEach(([type, item, name, from, to], n) => {
    db.prepare(
      `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version, to_version, state, outcome)
       VALUES (?, 'ddev-run', ?, ?, ?, ?, ?, ?, ?, 'done', 'passed')`,
    ).run(`i${n}`, SITE, n, type, item, name, from, to);
  });
  db.prepare(
    `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id, bytes, batch_id)
     VALUES (?, ?, ?, 1, ?, ?, 'ddev-run')`,
  ).run(SITE, snapshotAt, snapshotAt + 500, 'e'.repeat(64), snapshot.length);
  report(after);
  const restic = {
    async dump(_id: string, _site: string, read: (s: Readable) => Promise<unknown>) {
      return { ok: true, value: await read(Readable.from([snapshot])) };
    },
  } as unknown as Restic;
  deps = {
    db,
    restic,
    exec: realExec(),
    workDir: mkdtempSync(join(tmpdir(), 'kamaji-ddev-rollback-')),
    tar: '/usr/bin/tar',
    // As Kinsta's is sent: the script as it is, `kinsta` and the words, as the site's user.
    pushCommand: (_site, _host, words) => [
      'docker',
      'exec',
      '-i',
      '-u',
      UID,
      '-e',
      `HOME=${E2E}`,
      CONTAINER,
      'bash',
      '-c',
      PUSH,
      'kamaji-push',
      'kinsta',
      ...words,
    ],
    now: Date.now,
    sleep: async () => {},
    log: () => {},
  };
}

/** What the updater's fresh report would store: the versions as they are now. */
function report(v: typeof start) {
  const set = db.prepare(
    `INSERT INTO components (site_id, type, item, name, version, active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0)
     ON CONFLICT (site_id, type, item) DO UPDATE SET version = excluded.version`,
  );
  set.run(SITE, 'core', 'core', 'WordPress', v.core);
  set.run(SITE, 'plugin', 'akismet/akismet.php', 'Akismet', v.akismet);
  set.run(SITE, 'theme', 'twentytwentyfour', 'Twenty Twenty-Four', v.theme);
}

const latest = () =>
  db.prepare('SELECT * FROM rollbacks ORDER BY requested_at DESC, rowid DESC LIMIT 1').get()!;
/** The updater's part, in short: the checks ran, and the report says what's there now. */
function checked() {
  db.prepare('UPDATE rollbacks SET checked_at = ?, checks_ok = 1 WHERE checked_at IS NULL').run(
    Date.now(),
  );
  report(versions());
}

beforeAll(() => {
  start = versions();
  // The site before the run: Twenty Twenty-Four a release back, so the run has a theme to update.
  wp('theme install twentytwentyfour --version=1.5 --force');
  inDdev(`rm -rf ${E2E} && mkdir -p ${E2E} && ln -s ${ROOT} ${E2E}/public`);
  // The restore point: a real pull, as Kinsta's is made.
  snapshot = execFileSync(
    'docker',
    ['exec', '-u', UID, '-e', `HOME=${E2E}`, CONTAINER, 'bash', '-c', PULL, 'kamaji-pull', SITE],
    { maxBuffer: 1024 ** 3 },
  );
}, 300_000);

afterAll(() => {
  if (comment) wp(`comment delete ${comment} --force`);
  wp(`theme install twentytwentyfour --version=${start.theme} --force`);
  wp(`plugin install akismet --version=${start.akismet} --force`);
  wp(`core update --version=${start.core} --force`);
  inDdev(`rm -rf ${E2E}`);
  expect(versions()).toEqual(start);
}, 300_000);

describe('rollback on the DDEV site', () => {
  it('rolls back a real run, undoes it, then does both with the database', async () => {
    const before = versions();
    expect(before.theme).toBe('1.5');
    const snapshotAt = Date.now() - 60_000;
    // The run: core, a plugin and a theme, through WordPress's own updaters.
    wp('core update --version=7.1.5');
    wp('plugin update akismet');
    wp('theme update twentytwentyfour');
    const after = versions();
    expect(after).not.toEqual(before);
    // Written after the restore point: lost with the database, kept without it.
    comment = wp(
      'comment create --comment_post_ID=1 --comment_content="after the snapshot" --comment_approved=1 --porcelain',
    );
    setUpKamaji(before, after, snapshotAt);

    // Files only.
    const asked = requestRollback(
      db,
      SITE,
      { batchId: 'ddev-run', withDatabase: false },
      'tyler',
      Date.now(),
    );
    expect(asked).toMatchObject({ ok: true });
    await runRollback(deps, asked.ok ? asked.id : '');
    expect(latest()).toMatchObject({ state: 'done', changed: 'all', problem: null });
    expect(versions()).toEqual(before);
    expect(wp(`comment get ${comment} --field=content`)).toBe('after the snapshot');
    expect(home()).toBe('200');
    expect(inDdev(`test -e ${ROOT}/.maintenance && echo yes || echo no`).toString().trim()).toBe(
      'no',
    );
    checked();

    // Its undo: the files as the run left them.
    const undo = requestUndo(
      db,
      SITE,
      { rollbackId: asked.ok ? asked.id : '', withDatabase: false },
      'tyler',
      Date.now(),
    );
    expect(undo).toMatchObject({ ok: true });
    await runRollback(deps, undo.ok ? undo.id : '');
    expect(latest()).toMatchObject({ kind: 'undo', state: 'done', changed: 'all' });
    expect(versions()).toEqual(after);
    expect(home()).toBe('200');
    checked();

    // With the database: the comment since the restore point is counted, then lost.
    const withDb = requestRollback(
      db,
      SITE,
      { batchId: 'ddev-run', withDatabase: true },
      'tyler',
      Date.now(),
    );
    expect(withDb).toMatchObject({ ok: true });
    await runRollback(deps, withDb.ok ? withDb.id : '');
    expect(latest()).toMatchObject({ state: 'done', changed: 'all' });
    expect(JSON.parse(String(latest().counts))).toMatchObject({ orders: null, comments: 1 });
    expect(versions()).toEqual(before);
    expect(() => wp(`comment get ${comment} --field=content`)).toThrow();
    expect(home()).toBe('200');
    checked();

    // And its undo, with the database as it was before the rollback: the comment is back.
    const back = requestUndo(
      db,
      SITE,
      { rollbackId: withDb.ok ? withDb.id : '', withDatabase: true },
      'tyler',
      Date.now(),
    );
    expect(back).toMatchObject({ ok: true });
    await runRollback(deps, back.ok ? back.id : '');
    expect(latest()).toMatchObject({ kind: 'undo', state: 'done', changed: 'all' });
    expect(versions()).toEqual(after);
    expect(wp(`comment get ${comment} --field=content`)).toBe('after the snapshot');
    expect(home()).toBe('200');
  }, 900_000);
});
