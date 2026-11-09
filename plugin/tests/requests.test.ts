// craftish-care's request checks, against the local DDEV WordPress (dev/README.md): one test per
// refusal in docs/protocol.md, "Tests the plugin ships with", plus the happy paths. Opt-in, since
// it needs DDEV running: `npm run test:plugin`. Never pointed at a real site.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { careRequest } from '../../packages/server/src/care/client.js';
import {
  loadCareKeys,
  type CareKeys,
  type SigningKey,
} from '../../packages/server/src/care/keys.js';
import { newNonce, signRequest } from '../../packages/server/src/care/sign.js';
import { keysFile } from '../../packages/server/src/care/zip.js';

const HOME = new URL('https://kamaji-wp.ddev.site');
const ALIAS = new URL('https://kamaji-wp-alias.ddev.site');
const WORDPRESS = new URL('../../dev/wordpress/', import.meta.url);
const KEYS_FILE = new URL('../craftish-care/craftish-care-keys.php', import.meta.url);

function readEnv(): NodeJS.ProcessEnv {
  const text = readFileSync(new URL('../../dev/care-keys.env', import.meta.url), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const keys = loadCareKeys(readEnv()) as CareKeys;
const report = keys.report;
const update = keys.update as SigningKey;

function wp(...args: string[]): string {
  return execFileSync('ddev', ['wp', ...args], { cwd: WORDPRESS, encoding: 'utf8' }).trim();
}

function sql(query: string): string {
  return wp('db', 'query', query, '--skip-column-names');
}

/** A fresh install: everything the plugin stored deleted, then activated with the dev keys. */
function freshInstall(): void {
  writeFileSync(KEYS_FILE, keysFile(keys, HOME.host, new Date()));
  try {
    wp('plugin', 'deactivate', 'craftish-care');
  } catch {
    // Not active yet.
  }
  sql("DELETE FROM wp_options WHERE option_name LIKE 'craftish\\_care\\_%'");
  wp('plugin', 'activate', 'craftish-care');
}

interface Sent {
  status: number;
  body: unknown;
}

/** One request, built by hand so a test can change any part of it after signing. */
async function send(
  endpoint: string,
  options: {
    key?: SigningKey;
    body?: string;
    sentBody?: string;
    signedHost?: URL;
    to?: URL;
    sentEndpoint?: string;
    now?: number;
    nonce?: string;
    headers?: (h: Record<string, string>) => Record<string, string>;
    restRoute?: boolean;
  } = {},
): Promise<Sent> {
  const body = options.body ?? '{}';
  let headers = signRequest(options.key ?? report, options.signedHost ?? HOME, endpoint, body, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
  });
  if (options.headers) headers = options.headers(headers);
  const base = options.to ?? HOME;
  const route = `/craftish-care/v1/${options.sentEndpoint ?? endpoint}`;
  const url = options.restRoute
    ? new URL(`/?rest_route=${route}`, base)
    : new URL(`/wp-json${route}`, base);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: options.sentBody ?? body,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const refused = (status: number, error: string) => ({ status, body: { error } });

beforeAll(() => {
  freshInstall();
});

describe('happy paths', () => {
  it('says hello, by either URL form', async () => {
    const hello = await send('hello');
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ plugin: '0.1.0', protocol: 1, multisite: false });
    expect((await send('hello', { restRoute: true })).status).toBe(200);
  });

  it('reports the inventory, and refreshes at most once per 10 minutes', async () => {
    const first = await send('report', { body: '{"refresh":true}' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ refreshed: true, core: { version: expect.any(String) } });
    const body = first.body as { plugins: { file: string }[]; themes: { active: boolean }[] };
    expect(body.plugins.map((p) => p.file)).toContain('craftish-care/craftish-care.php');
    expect(body.themes.some((t) => t.active)).toBe(true);
    expect((await send('report', { body: '{"refresh":true}' })).body).toMatchObject({
      refreshed: false,
    });
  });

  it('goes through Kamaji’s own client', async () => {
    const result = await careRequest(HOME, report, 'hello', {});
    expect(result.ok).toBe(true);
  });

  it('knows no jobs yet', async () => {
    expect(await send('status', { body: '{"job":"8b1f6e3c"}' })).toEqual(
      refused(404, 'unknown_job'),
    );
    expect(await send('status', { body: '{"job":["x"]}' })).toEqual(refused(400, 'bad_body'));
  });
});

describe('refusals, in the protocol’s order', () => {
  it('refuses a missing or malformed header', async () => {
    const drop = (name: string) => (h: Record<string, string>) =>
      Object.fromEntries(Object.entries(h).filter(([k]) => k !== name));
    for (const name of ['X-Care-Key', 'X-Care-Time', 'X-Care-Nonce', 'X-Care-Signature']) {
      expect(await send('hello', { headers: drop(name) })).toEqual(refused(400, 'malformed'));
    }
    expect(
      await send('hello', { headers: (h) => ({ ...h, 'X-Care-Nonce': 'not a nonce' }) }),
    ).toEqual(refused(400, 'malformed'));
  });

  it('refuses a key it doesn’t know', async () => {
    expect(await send('hello', { headers: (h) => ({ ...h, 'X-Care-Key': 'r9' }) })).toEqual(
      refused(401, 'unknown_key'),
    );
  });

  it('never lets the report key disconnect, nor the update key report', async () => {
    expect(await send('disconnect')).toEqual(refused(401, 'wrong_key'));
    expect(await send('hello', { key: update })).toEqual(refused(401, 'wrong_key'));
  });

  it('has no update endpoint yet, nor anything else outside the table', async () => {
    expect(await send('update', { key: update })).toEqual(refused(404, 'not_found'));
    expect(await send('users')).toEqual(refused(404, 'not_found'));
  });

  it('refuses old and future timestamps', async () => {
    expect(await send('hello', { now: Date.now() - 301_000 })).toEqual(refused(401, 'stale'));
    expect(await send('hello', { now: Date.now() + 301_000 })).toEqual(refused(401, 'stale'));
  });

  it('refuses a body changed after signing', async () => {
    expect(await send('report', { body: '{}', sentBody: '{"refresh":true}' })).toEqual(
      refused(401, 'bad_signature'),
    );
  });

  it('refuses a request whose host or route changed after signing', async () => {
    expect(await send('hello', { signedHost: ALIAS })).toEqual(refused(401, 'bad_signature'));
    expect(await send('hello', { sentEndpoint: 'report' })).toEqual(refused(401, 'bad_signature'));
  });

  it('refuses a reused nonce', async () => {
    const nonce = newNonce();
    expect((await send('hello', { nonce })).status).toBe(200);
    expect(await send('hello', { nonce })).toEqual(refused(401, 'replay'));
  });

  it('lets exactly one of two racing requests with the same nonce through', async () => {
    const nonce = newNonce();
    const results = await Promise.all([send('hello', { nonce }), send('hello', { nonce })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('refuses a request signed for, and sent to, another of the server’s hostnames', async () => {
    expect(await send('hello', { signedHost: ALIAS, to: ALIAS })).toEqual(
      refused(401, 'wrong_host'),
    );
  });
});

// The refusals above count toward the rate limit; each later group starts from zero.
const clearRefusals = () => wp('option', 'delete', 'craftish_care_refusals');

describe('what it keeps', () => {
  beforeAll(clearRefusals);
  it('autoloads only the two keys', () => {
    const rows = sql(
      "SELECT option_name, autoload FROM wp_options WHERE option_name LIKE 'craftish\\_care\\_%' ORDER BY option_name",
    )
      .split('\n')
      .map((l) => l.split('\t'));
    const autoloaded = rows.filter(([, a]) => a === 'on' || a === 'yes').map(([n]) => n);
    expect(autoloaded).toEqual(['craftish_care_report_key', 'craftish_care_update_key']);
    expect(rows.some(([n]) => n?.startsWith('craftish_care_n_'))).toBe(true);
  });

  it('sweeps stale nonces on a request, without WP-Cron', async () => {
    const stale = Math.floor(Date.now() / 1000) - 1000;
    sql(
      `INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('craftish_care_n_stale', '${stale}', 'off')`,
    );
    await send('hello');
    expect(sql("SELECT COUNT(*) FROM wp_options WHERE option_name = 'craftish_care_n_stale'")).toBe(
      '0',
    );
  });

  it('logs events only: no bodies, header values or addresses', () => {
    const log = JSON.parse(wp('option', 'get', 'craftish_care_log', '--format=json')) as Record<
      string,
      unknown
    >[];
    expect(log.length).toBeGreaterThan(5);
    for (const entry of log) {
      expect(Object.keys(entry).sort()).toEqual(['endpoint', 'key', 'result', 't']);
      expect(['r1', 'u1', null]).toContain(entry.key);
    }
    // Nothing from a request: its body ("refresh":, a job id), an unknown key id, an address.
    expect(JSON.stringify(log)).not.toMatch(/"refresh"|8b1f6e3c|\d+\.\d+\.\d+\.\d+|r9/);
  });
});

describe('where it can’t update', () => {
  beforeAll(clearRefusals);
  const blockers = async () =>
    (
      (await send('hello')).body as {
        capabilities: { can_update: boolean; update_blockers: string[] };
      }
    ).capabilities;

  it('says why with FS_METHOD set to ftpext', async () => {
    wp('config', 'set', 'FS_METHOD', 'ftpext', '--type=constant');
    try {
      expect(await blockers()).toMatchObject({
        can_update: false,
        update_blockers: expect.arrayContaining(['filesystem_not_direct']),
      });
    } finally {
      wp('config', 'delete', 'FS_METHOD', '--type=constant');
    }
  });

  it('says why with DISALLOW_FILE_MODS', async () => {
    wp('config', 'set', 'DISALLOW_FILE_MODS', 'true', '--raw', '--type=constant');
    try {
      expect(await blockers()).toMatchObject({
        can_update: false,
        update_blockers: expect.arrayContaining(['file_mods_disallowed']),
      });
    } finally {
      wp('config', 'delete', 'DISALLOW_FILE_MODS', '--type=constant');
    }
    expect((await blockers()).can_update).toBe(true);
  });
});

describe('the rate limit', () => {
  beforeAll(clearRefusals);
  it('refuses everything for 10 minutes after more than 20 refusals in a minute', async () => {
    for (let i = 0; i < 21; i++) {
      await send('hello', { headers: (h) => ({ ...h, 'X-Care-Key': 'r9' }) });
    }
    expect(await send('hello')).toEqual(refused(429, 'rate_limited'));
    wp('option', 'delete', 'craftish_care_refusals');
    expect((await send('hello')).status).toBe(200);
  });
});

describe('disconnect', () => {
  it('forgets its keys and nonces, then answers 410 to everything', async () => {
    expect(await send('disconnect', { key: update })).toEqual({
      status: 200,
      body: { disconnected: true },
    });
    for (const endpoint of ['hello', 'report', 'status', 'disconnect']) {
      expect(await send(endpoint)).toEqual(refused(410, 'disconnected'));
    }
    expect(await send('disconnect', { key: update })).toEqual(refused(410, 'disconnected'));
    expect(
      sql(
        "SELECT COUNT(*) FROM wp_options WHERE option_name LIKE 'craftish\\_care\\_n\\_%' OR option_name LIKE 'craftish\\_care\\_%\\_key'",
      ),
    ).toBe('0');
  });

  it('stays disconnected through deactivating and activating again', async () => {
    wp('plugin', 'deactivate', 'craftish-care');
    wp('plugin', 'activate', 'craftish-care');
    expect(await send('hello')).toEqual(refused(410, 'disconnected'));
  });

  it('leaves a fresh install working, and refuses to activate without keys', async () => {
    freshInstall();
    expect((await send('hello')).status).toBe(200);
    wp('plugin', 'deactivate', 'craftish-care');
    sql("DELETE FROM wp_options WHERE option_name LIKE 'craftish\\_care\\_%'");
    rmSync(KEYS_FILE);
    expect(() => wp('plugin', 'activate', 'craftish-care')).toThrow();
    freshInstall();
  });
});
