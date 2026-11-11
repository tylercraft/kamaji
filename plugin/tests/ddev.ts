// The DDEV WordPress the plugin tests run against (dev/README.md), shared by every test file.
// The plugin is copied in, never mounted: an update test lets WordPress's upgrader replace it,
// and that must only ever replace the copy.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  loadCareKeys,
  type CareKeys,
  type SigningKey,
} from '../../packages/server/src/care/keys.js';
import { signRequest } from '../../packages/server/src/care/sign.js';
import { keysFile } from '../../packages/server/src/care/zip.js';

export const HOME = new URL('https://kamaji-wp.ddev.site');
export const ALIAS = new URL('https://kamaji-wp-alias.ddev.site');
export const WORDPRESS = new URL('../../dev/wordpress/', import.meta.url);
export const SOURCE = new URL('../craftish-care/', import.meta.url);
export const INSTALLED = new URL(
  '../../dev/wordpress/wp-content/plugins/craftish-care/',
  import.meta.url,
);
export const KEYS_FILE = new URL('craftish-care-keys.php', INSTALLED);

export function readEnv(): NodeJS.ProcessEnv {
  const text = readFileSync(new URL('../../dev/care-keys.env', import.meta.url), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

export const keys = loadCareKeys(readEnv()) as CareKeys;
export const report = keys.report;
export const update = keys.update as SigningKey;

export function wp(...args: string[]): string {
  return execFileSync('ddev', ['wp', ...args], { cwd: WORDPRESS, encoding: 'utf8' }).trim();
}

export function sql(query: string): string {
  return wp('db', 'query', query, '--skip-column-names');
}

/**
 * Flushes DDEV's Mutagen sync both ways. After writing on this side: the container sees it. Before
 * writing on this side: anything written in the container (WordPress's upgrader) has landed here
 * first. Otherwise, writing back a file's last-synced content (an update undone by hand) looks
 * like no change here, and the container's newer copy is synced back over it.
 */
export function synced(): void {
  execFileSync('ddev', ['mutagen', 'sync'], { cwd: WORDPRESS, stdio: 'ignore' });
}

/** The repo's plugin copied into the site, with a keys file built as Kamaji builds it. */
export function copyPlugin(): void {
  synced();
  execFileSync('rsync', [
    '-a',
    '--delete',
    '--exclude',
    'craftish-care-keys.php',
    '--exclude',
    '.gitignore',
    SOURCE.pathname,
    INSTALLED.pathname,
  ]);
  writeFileSync(KEYS_FILE, keysFile(keys, HOME.host, new Date()));
  synced();
}

/** A fresh install: everything the plugin stored deleted, then activated with the dev keys. */
export function freshInstall(): void {
  copyPlugin();
  try {
    wp('plugin', 'deactivate', 'craftish-care');
  } catch {
    // Not active yet.
  }
  sql("DELETE FROM wp_options WHERE option_name LIKE 'craftish\\_care\\_%'");
  wp('plugin', 'activate', 'craftish-care');
}

export interface Sent {
  status: number;
  body: unknown;
}

/** One request, built by hand so a test can change any part of it after signing. */
export async function send(
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

export const refused = (status: number, error: string) => ({ status, body: { error } });
