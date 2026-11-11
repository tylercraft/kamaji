// craftish-care's update jobs and self-update, against the local DDEV WordPress (dev/README.md),
// with DISABLE_WP_CRON set throughout: the background run must not need WP-Cron, as on
// aleyahoerlein.com. A test plugin's updates are offered by a dev-only must-use plugin, from zips
// served by the DDEV site itself. Opt-in with the rest: `npm run test:plugin`.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRelease } from '../../packages/server/src/care/release.js';
import { zip } from '../../packages/server/src/care/zip.js';
import {
  copyPlugin,
  freshInstall,
  HOME,
  readEnv,
  refused,
  send,
  SOURCE,
  synced,
  update,
  wp,
  WORDPRESS,
  type Sent,
} from './ddev.js';

const DOCROOT = new URL('./', WORDPRESS);
const FIXTURES = new URL('care-test/', DOCROOT);
const RELEASES = new URL('care-releases/', DOCROOT);
const PLUGINS = new URL('wp-content/plugins/', DOCROOT);
const MU = new URL('wp-content/mu-plugins/', DOCROOT);
const TEST_PLUGIN = 'kamaji-test-plugin/kamaji-test-plugin.php';

const pluginSource = (version: string) =>
  `<?php\n/*\n * Plugin Name: Kamaji test plugin\n * Version: ${version}\n */\n`;

/** WordPress offers the test plugin's update as the options say: a version and a package. */
const OFFER_MU = `<?php
/* Plugin Name: Kamaji test offers (DDEV only) */
add_filter( 'site_transient_update_plugins', function ( $value ) {
	$offer = get_option( 'kamaji_test_offer' );
	if ( ! is_array( $offer ) ) {
		return $value;
	}
	$value = is_object( $value ) ? $value : new stdClass();
	$value->response = (array) ( $value->response ?? array() );
	$value->response['${TEST_PLUGIN}'] = (object) array(
		'slug' => 'kamaji-test-plugin', 'plugin' => '${TEST_PLUGIN}',
		'new_version' => $offer['version'], 'package' => $offer['package'],
	);
	return $value;
} );
add_filter( 'upgrader_pre_install', function ( $return ) {
	$slow = (int) get_option( 'kamaji_test_slow', 0 );
	if ( $slow > 0 ) {
		sleep( $slow );
	}
	return $return;
} );
`;

function installTestPlugin(version: string): void {
  const dir = new URL('kamaji-test-plugin/', PLUGINS);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('kamaji-test-plugin.php', dir), pluginSource(version));
  synced();
  wp('plugin', 'activate', 'kamaji-test-plugin');
}

function testPackage(version: string): string {
  mkdirSync(FIXTURES, { recursive: true });
  const name = `kamaji-test-plugin-${version}.zip`;
  writeFileSync(
    new URL(name, FIXTURES),
    zip(
      [
        {
          name: 'kamaji-test-plugin/kamaji-test-plugin.php',
          data: Buffer.from(pluginSource(version)),
        },
      ],
      new Date(),
    ),
  );
  synced();
  return new URL(`care-test/${name}`, HOME).href;
}

function offer(version: string, pkg: string): void {
  wp(
    'option',
    'update',
    'kamaji_test_offer',
    JSON.stringify({ version, package: pkg }),
    '--format=json',
  );
}

const job = (id: string, fields: Record<string, string>) =>
  JSON.stringify({
    job: id,
    type: 'plugin',
    item: TEST_PLUGIN,
    from: '1.0.0',
    to: '1.1.0',
    ...fields,
  });

const startUpdate = (body: string) => send('update', { key: update, body });

type Status = { job: string; state: string; result?: Record<string, unknown> };

/** Polls status until the job finishes, for up to 60 seconds. */
async function finished(id: string): Promise<Status> {
  for (let i = 0; i < 120; i++) {
    const answer = await send('status', { body: JSON.stringify({ job: id }) });
    const s = answer.body as Status;
    // 503 is WordPress's maintenance page while the upgrader runs: still going.
    if (answer.status === 200 && (s.state === 'succeeded' || s.state === 'failed')) return s;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`job ${id} didn't finish`);
}

/** WordPress's pending offers, read by the plugin's own report after a refresh. */
async function offeredSelf(): Promise<string | null> {
  wp('option', 'delete', 'craftish_care_refreshed');
  const body = (await send('report', { body: '{"refresh":true}' })).body as {
    plugins: { file: string; offer: { version: string } | null }[];
  };
  return (
    body.plugins.find((p) => p.file === 'craftish-care/craftish-care.php')?.offer?.version ?? null
  );
}

const settledConfig = async (check: (hello: Sent) => boolean) => {
  for (let i = 0; i < 20; i++) {
    if (check(await send('hello'))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('wp-config.php change not picked up');
};
const cronOff = (h: Sent) =>
  (h.body as { capabilities: { wp_cron_disabled: boolean } }).capabilities.wp_cron_disabled;

beforeAll(async () => {
  freshInstall();
  mkdirSync(MU, { recursive: true });
  writeFileSync(new URL('kamaji-test-offers.php', MU), OFFER_MU);
  synced();
  wp('config', 'set', 'DISABLE_WP_CRON', 'true', '--raw', '--type=constant');
  await settledConfig(cronOff);
});

afterAll(() => {
  wp('config', 'delete', 'DISABLE_WP_CRON', '--type=constant');
  wp('plugin', 'deactivate', 'kamaji-test-plugin');
  for (const dir of [FIXTURES, RELEASES, new URL('kamaji-test-plugin/', PLUGINS)]) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(new URL('kamaji-test-offers.php', MU), { force: true });
  rmSync(new URL('kamaji-test-channel.php', MU), { force: true });
  wp('option', 'delete', 'kamaji_test_offer');
  wp('option', 'delete', 'kamaji_test_slow');
  freshInstall();
});

describe('update jobs', () => {
  it('refuses what isn’t exactly WordPress’s offer', async () => {
    installTestPlugin('1.0.0');
    offer('1.1.0', testPackage('1.1.0'));
    expect(await startUpdate(job('a1', { from: '0.9.0' }))).toEqual(
      refused(409, 'version_changed'),
    );
    expect(await startUpdate(job('a2', { to: '1.2.0' }))).toEqual(refused(409, 'version_changed'));
    expect(await startUpdate(job('a3', { item: 'akismet/akismet.php' }))).toEqual(
      refused(409, 'version_changed'),
    );
    offer('1.1.0', '');
    expect(await startUpdate(job('a4', {}))).toEqual(refused(409, 'no_package'));
    expect(await startUpdate(JSON.stringify({ job: 'a5', type: 'plugin' }))).toEqual(
      refused(400, 'bad_body'),
    );
    expect(await startUpdate(job('a6', { type: 'core' }))).toEqual(refused(400, 'bad_body'));
  });

  it('answers at once and runs in the background with WP-Cron off, keeping the plugin active', async () => {
    installTestPlugin('1.0.0');
    offer('1.1.0', testPackage('1.1.0'));
    wp('option', 'update', 'kamaji_test_slow', '4');
    const started = Date.now();
    expect(await startUpdate(job('b1', {}))).toEqual({
      status: 202,
      body: { job: 'b1', state: 'queued' },
    });
    // The upgrade sleeps 4 seconds, so a quick answer means it ran after the response.
    expect(Date.now() - started).toBeLessThan(3000);
    // While it runs, WordPress's upgrader has the site in maintenance mode: every request,
    // Kamaji's status polls included, gets WordPress's 503 until it's done.
    expect(await finished('b1')).toEqual({
      job: 'b1',
      state: 'succeeded',
      result: { installed: '1.1.0', error: null, message: null, maintenance: false },
    });
    wp('option', 'delete', 'kamaji_test_slow');
    expect(wp('plugin', 'get', 'kamaji-test-plugin', '--field=status')).toBe('active');
    // No cron event for the job: only the hourly nonce sweep the plugin always has.
    expect(
      wp('cron', 'event', 'list', '--fields=hook', '--format=csv')
        .split('\n')
        .filter((hook) => hook.startsWith('craftish')),
    ).toEqual(['craftish_care_sweep']);
  });

  it('runs inline where PHP can’t finish the request early, as without PHP-FPM', async () => {
    installTestPlugin('1.0.0');
    offer('1.1.0', testPackage('1.1.0'));
    writeFileSync(
      new URL('kamaji-test-no-finish.php', MU),
      "<?php\n/* Plugin Name: Kamaji test: no early finish (DDEV only) */\nadd_filter( 'craftish_care_finish_request', '__return_false' );\n",
    );
    synced();
    wp('option', 'update', 'kamaji_test_slow', '4');
    try {
      const started = Date.now();
      const answer = await startUpdate(job('i1', {}));
      // The answer waits for the job: the 4-second upgrade ran before it was sent.
      expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
      expect(answer).toEqual({ status: 202, body: { job: 'i1', state: 'queued' } });
      expect(await finished('i1')).toMatchObject({
        state: 'succeeded',
        result: { installed: '1.1.0' },
      });
    } finally {
      wp('option', 'delete', 'kamaji_test_slow');
      rmSync(new URL('kamaji-test-no-finish.php', MU), { force: true });
      synced();
    }
  });

  it('runs one job at a time', async () => {
    installTestPlugin('1.0.0');
    offer('1.1.0', testPackage('1.1.0'));
    const now = Math.floor(Date.now() / 1000);
    wp(
      'db',
      'query',
      `INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('craftish_care_lock', '${now} other-job', 'off')`,
    );
    expect(await startUpdate(job('c1', {}))).toEqual(refused(409, 'busy'));
    // A lock older than 15 minutes is a run that died: it no longer blocks.
    wp(
      'db',
      'query',
      `UPDATE wp_options SET option_value = '${now - 901} other-job' WHERE option_name = 'craftish_care_lock'`,
    );
    expect((await startUpdate(job('c2', {}))).status).toBe(202);
    expect((await finished('c2')).state).toBe('succeeded');
  });

  it('answers the same job id with that job’s state, never a second run', async () => {
    expect(await startUpdate(job('b1', {}))).toMatchObject({
      status: 200,
      body: { job: 'b1', state: 'succeeded' },
    });
    expect(await startUpdate(job('b1', { to: '1.2.0' }))).toEqual(refused(409, 'job_id_reused'));
    const log = JSON.parse(wp('option', 'get', 'craftish_care_log', '--format=json')) as {
      endpoint: string;
      result: string;
    }[];
    // b1, i1 and c2 each ran once; asking for b1 again started nothing.
    expect(log.filter((e) => e.result.startsWith('succeeded: plugin'))).toHaveLength(3);
    expect(log.filter((e) => e.result.startsWith('queued:'))).toHaveLength(3);
  });

  it('reports a run that died as failed, with what’s installed', async () => {
    wp(
      'eval',
      `$jobs = get_option('craftish_care_jobs'); $jobs['b1']['state'] = 'running'; update_option('craftish_care_jobs', $jobs, false); delete_option('craftish_care_lock');`,
    );
    expect((await send('status', { body: '{"job":"b1"}' })).body).toEqual({
      job: 'b1',
      state: 'failed',
      result: {
        installed: '1.1.0',
        error: 'interrupted',
        message: 'The run stopped before it finished',
        maintenance: false,
      },
    });
  });
});

describe('self-update', () => {
  const channel = new URL('care-releases/', HOME).href;
  const env = readEnv();
  const key = {
    id: env.KAMAJI_CARE_RELEASE_KEY_ID ?? 'p1',
    seed: env.KAMAJI_CARE_RELEASE_KEY ?? '',
  };

  /** The repo's plugin as version 0.2.1, published to the DDEV channel. */
  function publish(options: { tamper?: boolean; badSignature?: boolean; version?: string } = {}) {
    const version = options.version ?? '0.2.1';
    const dir = join(tmpdir(), `kamaji-release-${Date.now()}`);
    cpSync(SOURCE.pathname, dir, { recursive: true });
    rmSync(join(dir, 'craftish-care-keys.php'), { force: true });
    const main = join(dir, 'craftish-care.php');
    writeFileSync(
      main,
      readFileSync(main, 'utf8')
        .replace(/^( \* Version:\s+)\S+$/m, `$1${version}`)
        .replace(/^const VERSION {2}= '[^']+';$/m, `const VERSION  = '${version}';`),
    );
    const release = buildRelease(dir, key, channel, new Date());
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(RELEASES, { recursive: true });
    const zipBytes = options.tamper ? Buffer.concat([release.zip, Buffer.from('x')]) : release.zip;
    writeFileSync(new URL(release.zipName, RELEASES), zipBytes);
    const info = options.badSignature ? { ...release.info, sha256: '0'.repeat(64) } : release.info;
    writeFileSync(new URL('info.json', RELEASES), JSON.stringify(info));
    synced();
  }

  beforeAll(() => {
    expect(key.seed).not.toBe('');
    copyPlugin();
    // A new file, so PHP's opcache has no old copy of it to run.
    writeFileSync(
      new URL('kamaji-test-channel.php', MU),
      `<?php\n/* Plugin Name: Kamaji test release channel (DDEV only) */\ndefine( 'CRAFTISH_CARE_RELEASES_URL', '${channel}' );\n`,
    );
    synced();
  });

  it('stores the release key from the keys file, apart from the request keys', () => {
    const stored = JSON.parse(
      wp('option', 'get', 'craftish_care_release_key', '--format=json'),
    ) as { use: string; id: string };
    expect(stored).toMatchObject({ use: 'release', id: key.id });
    expect(
      wp(
        'db',
        'query',
        "SELECT autoload FROM wp_options WHERE option_name = 'craftish_care_release_key'",
        '--skip-column-names',
      ),
    ).toMatch(/^(off|no)$/);
  });

  it('refuses a package that doesn’t match its signed hash', async () => {
    publish({ tamper: true });
    expect(await offeredSelf()).toBe('0.2.1');
    expect(
      await startUpdate(
        JSON.stringify({
          job: 's1',
          type: 'plugin',
          item: 'craftish-care/craftish-care.php',
          from: '0.2.0',
          to: '0.2.1',
        }),
      ),
    ).toMatchObject({ status: 202 });
    expect(await finished('s1')).toMatchObject({
      state: 'failed',
      result: { installed: '0.2.0', error: 'craftish_care_bad_package' },
    });
    expect((await send('hello')).body).toMatchObject({ plugin: '0.2.0' });
  });

  // After the test above, which shows the channel answers.
  it('never offers an unsigned or older release', async () => {
    publish({ badSignature: true });
    expect(await offeredSelf()).toBeNull();
    publish({ version: '0.1.9' });
    expect(await offeredSelf()).toBeNull();
  });

  it('updates itself to a signed release through an ordinary job, and keeps its keys', async () => {
    publish();
    expect(await offeredSelf()).toBe('0.2.1');
    expect(
      await startUpdate(
        JSON.stringify({
          job: 's2',
          type: 'plugin',
          item: 'craftish-care/craftish-care.php',
          from: '0.2.0',
          to: '0.2.1',
        }),
      ),
    ).toMatchObject({ status: 202 });
    expect(await finished('s2')).toMatchObject({
      state: 'succeeded',
      result: { installed: '0.2.1', error: null },
    });
    expect((await send('hello')).body).toMatchObject({ plugin: '0.2.1' });
    expect(wp('plugin', 'get', 'craftish-care', '--field=status')).toBe('active');
    // The release carries no site's keys file; the stored keys carry on.
    expect(
      wp(
        'eval',
        'echo file_exists(WP_PLUGIN_DIR . "/craftish-care/craftish-care-keys.php") ? "yes" : "no";',
      ),
    ).toBe('no');
    expect(await offeredSelf()).toBeNull();
  });
});
