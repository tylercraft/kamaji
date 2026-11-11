// M4's done test on DDEV (calcifer explore/kamaji/plan.md, M4): Kamaji's own updater, approval
// and checks, against the local WordPress with Craftish Care 0.2.0 and DISABLE_WP_CRON set, as on
// aleyahoerlein.com. A core update (WordPress downgraded to 7.1.3 first, so wordpress.org offers
// 7.1.4), a good plugin update, one that breaks a check, the site going away mid-run, and Kamaji
// restarted mid-run, each ending in the right outcome; plus the path a host without PHP-FPM takes.
// The Worker is a stand-in that records what it's told; Discord isn't involved.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { CareHello } from '@kamaji/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { careRequest } from '../../packages/server/src/care/client.js';
import { realCheckers } from '../../packages/server/src/checks/sites.js';
import type { Db } from '../../packages/server/src/db.js';
import { reportSite } from '../../packages/server/src/inventory/report.js';
import { recordObservation } from '../../packages/server/src/observations.js';
import { testDb } from '../../packages/server/src/testing.js';
import { runUpdater, type UpdaterDeps } from '../../packages/server/src/updater/run.js';
import { approveBatch, batchViews } from '../../packages/server/src/updates/batches.js';
import { queue } from '../../packages/server/src/updates/queue.js';
import { zip } from '../../packages/server/src/care/zip.js';
import { freshInstall, HOME, keys, synced, update, wp, WORDPRESS } from './ddev.js';

const DOCROOT = new URL('./', WORDPRESS);
const FIXTURES = new URL('care-done/', DOCROOT);
const PLUGINS = new URL('wp-content/plugins/', DOCROOT);
const MU = new URL('wp-content/mu-plugins/', DOCROOT);
const SITE = HOME.host;
const ONE = 'kamaji-done-one/kamaji-done-one.php';
const TWO = 'kamaji-done-two/kamaji-done-two.php';

/** A test plugin; `breaks` makes every front-end page a PHP fatal (REST still answers). */
const source = (file: string, version: string, breaks = false) =>
  `<?php\n/*\n * Plugin Name: Kamaji done test ${file.split('/')[0]}\n * Version: ${version}\n */\n` +
  (breaks ? "add_action( 'wp', function () { kamaji_done_test_no_such_function(); } );\n" : '');

/** WordPress offers each test plugin's update as the kamaji_done_offers option says. */
const OFFERS_MU = `<?php
/* Plugin Name: Kamaji done test offers (DDEV only) */
add_filter( 'site_transient_update_plugins', function ( $value ) {
	$offers = get_option( 'kamaji_done_offers' );
	if ( ! is_array( $offers ) ) {
		return $value;
	}
	$value = is_object( $value ) ? $value : new stdClass();
	$value->response = (array) ( $value->response ?? array() );
	foreach ( $offers as $file => $offer ) {
		$value->response[ $file ] = (object) array(
			'slug' => dirname( $file ), 'plugin' => $file,
			'new_version' => $offer['version'], 'package' => $offer['package'],
		);
	}
	return $value;
} );
add_filter( 'upgrader_pre_install', function ( $return ) {
	$slow = (int) get_option( 'kamaji_done_slow', 0 );
	if ( $slow > 0 ) {
		sleep( $slow );
	}
	return $return;
} );
`;

const ddev = (...args: string[]) =>
  execFileSync('ddev', args, {
    cwd: WORDPRESS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/** Until the home page passes: PHP's opcache can run a replaced plugin's old copy for seconds. */
async function healthy(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await realCheckers.homePage(HOME.href, 'Kamaji test', AbortSignal.timeout(20_000))).ok)
      return;
    await delay(500);
  }
  throw new Error('the DDEV home page didn’t recover');
}

function install(file: string, version: string): void {
  const dir = new URL(`${file.split('/')[0]}/`, PLUGINS);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(file.split('/')[1]!, dir), source(file, version));
  synced();
  wp('plugin', 'activate', file.split('/')[0]!);
}

/** A zip the DDEV site serves to itself, and WordPress offering it. */
function offer(offers: Record<string, { version: string; breaks?: boolean }>): void {
  mkdirSync(FIXTURES, { recursive: true });
  const value: Record<string, { version: string; package: string }> = {};
  for (const [file, o] of Object.entries(offers)) {
    const name = `${file.split('/')[0]}-${o.version}.zip`;
    writeFileSync(
      new URL(name, FIXTURES),
      zip([{ name: file, data: Buffer.from(source(file, o.version, o.breaks)) }], new Date()),
    );
    value[file] = { version: o.version, package: new URL(`care-done/${name}`, HOME).href };
  }
  synced();
  wp('option', 'update', 'kamaji_done_offers', JSON.stringify(value), '--format=json');
}

const worker: string[] = [];
const workerFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  worker.push(
    u.endsWith('/v1/sites')
      ? `PUT ${(JSON.parse(String(init?.body)) as { id: string }[]).map((s) => s.id).join(',') || '(none)'}`
      : `POST ${new URL(u).pathname}`,
  );
  return new Response('{}', { status: 200 });
}) as typeof fetch;

let db: Db;

function deps(
  signal = new AbortController().signal,
  timing: UpdaterDeps['timing'] = {},
): UpdaterDeps {
  return {
    db,
    keys: { report: keys.report, update },
    send: (home, key, endpoint, body, options = {}) =>
      careRequest(home, key, endpoint, body, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    homePage: realCheckers.homePage,
    checkers: realCheckers,
    worker: { url: 'https://worker.test', token: 't', fetch: workerFetch },
    backup: async () => ({
      ok: false,
      words: 'not used: the DDEV site’s backups are “the host’s”',
    }),
    now: Date.now,
    sleep: (ms, s) => delay(ms, undefined, { signal: s }),
    signal,
    log: () => {},
    timing: { pollMs: 1_000, ...timing },
  };
}

const refresh = (id: string) =>
  reportSite(db, { id, name: 'Kamaji test', url: HOME.href }, keys, careRequest, Date.now, {
    refresh: true,
  });

/** Approves what's queued for the given items, as the Updates page would. */
async function approve(items: string[]): Promise<string> {
  wp('option', 'delete', 'craftish_care_refreshed');
  await refresh(SITE);
  const chosen = queue(db)
    .items.filter((i) => items.includes(i.item))
    .map(({ siteId, type, item, from, to }) => ({ siteId, type, item, from, to }));
  expect(chosen.map((i) => i.item).sort()).toEqual([...items].sort());
  wp('option', 'delete', 'craftish_care_refreshed');
  const result = await approveBatch(
    db,
    { items: chosen, confirmedBackups: [], oneSiteFirst: false },
    'tyler',
    Date.now,
    refresh,
  );
  if (!result.ok) throw new Error(`not approved: ${JSON.stringify(result)}`);
  return result.batchId;
}

const items = (batchId: string) =>
  batchViews(db)
    .find((b) => b.id === batchId)!
    .sites.flatMap((s) =>
      s.items.map((i) => ({ item: i.item, state: i.state, outcome: i.outcome, detail: i.detail })),
    );

beforeAll(async () => {
  freshInstall();
  mkdirSync(MU, { recursive: true });
  writeFileSync(new URL('kamaji-done-offers.php', MU), OFFERS_MU);
  synced();
  wp('config', 'set', 'DISABLE_WP_CRON', 'true', '--raw', '--type=constant');
  // An older WordPress, so wordpress.org offers a core update.
  wp('core', 'download', '--version=7.1.3', '--force', '--skip-content');
  install(ONE, '1.0.0');
  install(TWO, '1.0.0');

  db = testDb();
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, expected_text, created_at)
     VALUES (?, 'Kamaji test', ?, 'other', 'connected', 'done', 'host', 'Kamaji test', 0)`,
  ).run(SITE, HOME.href);
  const hello = await careRequest(HOME, keys.report, 'hello', {});
  expect(hello.ok).toBe(true);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: SITE,
    check: 'hello',
    source: 'plugin',
    at: Date.now(),
    ok: true,
    value: { ok: true, hello: CareHello.parse(hello.ok ? hello.data : null) },
  });
}, 600_000);

afterAll(() => {
  wp('option', 'delete', 'kamaji_done_offers');
  wp('option', 'delete', 'kamaji_done_slow');
  for (const file of [ONE, TWO]) {
    try {
      wp('plugin', 'deactivate', file.split('/')[0]!);
    } catch {
      // Already gone.
    }
    rmSync(new URL(`${file.split('/')[0]}/`, PLUGINS), { recursive: true, force: true });
  }
  rmSync(FIXTURES, { recursive: true, force: true });
  rmSync(new URL('kamaji-done-offers.php', MU), { force: true });
  rmSync(new URL('kamaji-done-no-finish.php', MU), { force: true });
  synced();
  try {
    wp('config', 'delete', 'DISABLE_WP_CRON', '--type=constant');
  } catch {
    // Not set.
  }
  freshInstall();
});

describe('M4’s done test on DDEV', () => {
  it('a good update: WordPress itself, then a plugin, each checked after', async () => {
    offer({ [ONE]: { version: '1.1.0' } });
    const batch = await approve(['core', ONE]);
    worker.length = 0;
    await runUpdater(deps());
    expect(items(batch)).toEqual([
      {
        item: 'core',
        state: 'done',
        outcome: 'passed',
        detail: '7.1.4 installed; the checks passed',
      },
      { item: ONE, state: 'done', outcome: 'passed', detail: '1.1.0 installed; the checks passed' },
    ]);
    expect(wp('core', 'version')).toBe('7.1.4');
    expect(wp('plugin', 'get', 'kamaji-done-one', '--field=status')).toBe('active');
    // Uptime alerts paused on both paths for the run, then resumed and re-checked at once.
    expect(worker).toEqual(['PUT (none)', `PUT ${SITE}`, `POST /v1/check/${SITE}`]);
    expect(db.prepare('SELECT updating_until FROM sites WHERE id = ?').get(SITE)).toEqual({
      updating_until: null,
    });
  }, 600_000);

  it('an update that breaks a check: updated and failed, the rest held', async () => {
    offer({ [ONE]: { version: '1.2.0', breaks: true }, [TWO]: { version: '1.1.0' } });
    const batch = await approve([ONE, TWO]);
    await runUpdater(deps());
    expect(items(batch)).toEqual([
      {
        item: ONE,
        state: 'done',
        outcome: 'checks_failed',
        detail: expect.stringMatching(/^1\.2\.0 installed, but home page: /),
      },
      { item: TWO, state: 'held', outcome: null, detail: null },
    ]);
    expect(
      db
        .prepare(
          "SELECT severity, summary FROM issues WHERE kind = 'update-held' AND resolved_at IS NULL",
        )
        .get(),
    ).toEqual({
      severity: 'urgent',
      summary: 'Kamaji test: updates are held and need a look',
    });
    install(ONE, '1.1.0'); // The fix, by hand, as Tyler would.
    await healthy();
  }, 600_000);

  it('the site going away mid-run: the update failed, naming the .maintenance left behind', async () => {
    db.prepare("UPDATE batch_sites SET state = 'done' WHERE state = 'held'").run();
    db.prepare(
      "UPDATE batch_items SET state = 'done', outcome = 'update_failed' WHERE state = 'held'",
    ).run();
    offer({ [ONE]: { version: '1.3.0' } });
    wp('option', 'update', 'kamaji_done_slow', '30');
    const batch = await approve([ONE]);
    const run = runUpdater(deps(undefined, { jobTimeoutMs: 150_000 }));
    // Once WordPress is mid-upgrade (in maintenance mode), the site goes away.
    for (let i = 0; i < 60 && !ddev('exec', 'ls', '-a').split('\n').includes('.maintenance'); i++) {
      await delay(500);
    }
    ddev('stop');
    await delay(5_000);
    ddev('start');
    await run;
    expect(items(batch)).toEqual([
      {
        item: ONE,
        state: 'done',
        outcome: 'update_failed',
        detail: expect.stringMatching(/left \.maintenance behind$/),
      },
    ]);
    expect(ddev('exec', 'ls', '-a').split('\n')).toContain('.maintenance');
    // The killed run's lock would refuse new jobs for 15 minutes (the updater test above
    // covers that); clear it, with the .maintenance, as Tyler would after a look.
    ddev('exec', 'rm', '-f', '.maintenance');
    wp('option', 'delete', 'craftish_care_lock');
    wp('option', 'delete', 'kamaji_done_slow');
    install(ONE, '1.1.0');
    await healthy();
  }, 600_000);

  it('Kamaji restarted mid-run: the next start asks the site with the same job id', async () => {
    offer({ [ONE]: { version: '1.4.0' } });
    wp('option', 'update', 'kamaji_done_slow', '6');
    const batch = await approve([ONE]);
    const stop = new AbortController();
    const run = runUpdater(deps(stop.signal));
    for (let i = 0; i < 60 && items(batch)[0]!.state !== 'running'; i++) await delay(250);
    stop.abort(new Error('Kamaji restarted'));
    await expect(run).rejects.toThrow();
    expect(items(batch)[0]!.state).toBe('running');
    await runUpdater(deps());
    expect(items(batch)).toEqual([
      { item: ONE, state: 'done', outcome: 'passed', detail: '1.4.0 installed; the checks passed' },
    ]);
    const log = JSON.parse(wp('option', 'get', 'craftish_care_log', '--format=json')) as {
      result: string;
    }[];
    // Queued once: the second start asked with the same job id and started nothing.
    expect(
      log.filter((e) => /^queued: plugin kamaji-done-one\/\S+ \S+ → 1\.4\.0$/.test(e.result)),
    ).toHaveLength(1);
    wp('option', 'delete', 'kamaji_done_slow');
  }, 600_000);

  it('a host without PHP-FPM: the update runs inside the request, and still passes', async () => {
    writeFileSync(
      new URL('kamaji-done-no-finish.php', MU),
      "<?php\n/* Plugin Name: Kamaji done test: no early finish (DDEV only) */\nadd_filter( 'craftish_care_finish_request', '__return_false' );\n",
    );
    synced();
    offer({ [TWO]: { version: '1.1.0' } });
    wp('option', 'update', 'kamaji_done_slow', '4');
    const batch = await approve([TWO]);
    await runUpdater(deps());
    expect(items(batch)).toEqual([
      { item: TWO, state: 'done', outcome: 'passed', detail: '1.1.0 installed; the checks passed' },
    ]);
    wp('option', 'delete', 'kamaji_done_slow');
    rmSync(new URL('kamaji-done-no-finish.php', MU), { force: true });
    synced();
  }, 600_000);
});
