// The restore check (ops/backups-plan.md, "restore to a test copy"): a site's snapshot restored
// on the mini, checked against its manifest, then started as an offline WordPress in Docker
// Desktop and asked for its home page. Nothing in it can reach the internet: the containers are
// on an --internal network, so a restored shop can't send email or call a payment API. Whatever
// happens, the containers, the network and the restored files are removed after.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Restic } from './restic.js';
import { checkPull, readTar, type Manifest } from './tar.js';

export interface Ran {
  code: number | null;
  stdout: string;
}
export type Exec = (
  command: string,
  args: string[],
  options?: { stdinFile?: string; timeoutMs?: number },
) => Promise<Ran>;

export interface RestoreDeps {
  restic: Restic;
  exec: Exec;
  /** Where restores are unpacked: ~/kamaji-backups/restore, mode 700. */
  workDir: string;
  docker: string;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export type RestoreStep =
  'restore' | 'verify' | 'unpack' | 'docker' | 'database' | 'wordpress' | 'home page';
export type RestoreResult = { ok: true } | { ok: false; step: RestoreStep; problem: string };

export const MARIADB = 'mariadb:11.4';
/** The official image for the manifest's WordPress, e.g. wordpress:6.8.3-apache. */
export const wordpressImage = (version: string) => `wordpress:${version}-apache`;

const fail = (step: RestoreStep, problem: string): RestoreResult => ({ ok: false, step, problem });

async function waitFor(
  deps: RestoreDeps,
  seconds: number,
  attempt: () => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < seconds / 2; i++) {
    if (deps.signal?.aborted) return false;
    if (await attempt()) return true;
    await deps.sleep(2_000);
  }
  return false;
}

export async function restoreCheck(
  deps: RestoreDeps,
  site: { id: string; expectedText: string | null },
  snapshotId: string,
): Promise<RestoreResult> {
  await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(deps.workDir, `${site.id}-`));
  const name = `kamaji-restore-${randomBytes(4).toString('hex')}`;
  const docker = (args: string[], options?: Parameters<Exec>[2]) =>
    deps.exec(deps.docker, args, options);
  let started = false;
  try {
    const restored = await deps.restic.restore(snapshotId, dir, deps.signal);
    if (!restored.ok) return fail('restore', restored.problem);
    const tar = join(dir, `${site.id}.tar`);
    let manifest: Manifest;
    try {
      const checked = checkPull(await readTar(createReadStream(tar)), site.id);
      if (!checked.ok) return fail('verify', checked.problem);
      manifest = checked.manifest;
    } catch {
      return fail('verify', 'the restored tar couldn’t be read');
    }
    const files = join(dir, 'site');
    await mkdir(files, { mode: 0o700 });
    const unpacked = await deps.exec('/usr/bin/tar', ['-xf', tar, '-C', files], {
      timeoutMs: 30 * 60_000,
    });
    if (unpacked.code !== 0)
      return fail('unpack', `tar couldn’t unpack it (exit ${unpacked.code})`);
    await rm(tar, { force: true });
    // Readable to the test copy's www-data, whatever modes the tar carried. The folder around it
    // stays 700, so nobody else on the mini can reach it.
    await deps.exec('/bin/chmod', ['-R', 'u+rwX,go+rX', files]);

    const network = await docker(['network', 'create', '--internal', name]);
    if (network.code !== 0) return fail('docker', 'Docker isn’t answering on the mini');
    started = true;

    const db = await docker(
      [
        'run',
        '--detach',
        '--name',
        `${name}-db`,
        '--network',
        name,
        '--env',
        'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1',
        '--env',
        'MARIADB_DATABASE=wordpress',
        MARIADB,
      ],
      { timeoutMs: 10 * 60_000 },
    );
    if (db.code !== 0) return fail('database', `MariaDB (${MARIADB}) didn’t start`);
    const ready = await waitFor(deps, 120, async () => {
      const ping = await docker(['exec', `${name}-db`, 'mariadb', '-uroot', '-e', 'SELECT 1']);
      return ping.code === 0;
    });
    if (!ready) return fail('database', 'MariaDB didn’t become ready within 2 minutes');
    const imported = await docker(['exec', '-i', `${name}-db`, 'mariadb', '-uroot', 'wordpress'], {
      stdinFile: join(files, 'database.sql'),
      timeoutMs: 30 * 60_000,
    });
    if (imported.code !== 0) return fail('database', 'database.sql didn’t import');

    const home = `http://${name}-wp`;
    const wp = await docker(
      [
        'run',
        '--detach',
        '--name',
        `${name}-wp`,
        '--network',
        name,
        '--volume',
        `${join(files, 'wp-content')}:/var/www/html/wp-content`,
        '--env',
        `WORDPRESS_DB_HOST=${name}-db`,
        '--env',
        'WORDPRESS_DB_USER=root',
        '--env',
        'WORDPRESS_DB_PASSWORD=',
        '--env',
        'WORDPRESS_DB_NAME=wordpress',
        '--env',
        `WORDPRESS_TABLE_PREFIX=${manifest.tablePrefix}`,
        '--env',
        `WORDPRESS_CONFIG_EXTRA=define('WP_HOME', '${home}'); define('WP_SITEURL', '${home}'); define('DISABLE_WP_CRON', true);`,
        wordpressImage(manifest.wordpress),
      ],
      { timeoutMs: 10 * 60_000 },
    );
    if (wp.code !== 0) {
      return fail('wordpress', `${wordpressImage(manifest.wordpress)} didn’t start`);
    }
    let last = 'no answer';
    const served = await waitFor(deps, 120, async () => {
      const page = await docker([
        'exec',
        `${name}-wp`,
        'curl',
        '--silent',
        '--location',
        '--max-time',
        '20',
        '--write-out',
        '\n%{http_code}',
        `${home}/`,
      ]);
      const end = page.stdout.lastIndexOf('\n');
      const status = page.stdout.slice(end + 1).trim();
      const body = page.stdout.slice(0, Math.max(end, 0));
      if (status !== '200') {
        last = status && status !== '000' ? `HTTP ${status}` : 'no answer';
        return false;
      }
      if (site.expectedText && !body.includes(site.expectedText)) {
        last = 'a page without the site’s expected text';
        return false;
      }
      return true;
    });
    if (!served) return fail('home page', `the test copy’s home page gave ${last}`);
    return { ok: true };
  } finally {
    if (started) {
      await docker(['rm', '--force', `${name}-wp`, `${name}-db`]);
      await docker(['network', 'rm', name]);
    }
    // A folder unpacked without write or search permission can't be emptied until it has them.
    await deps.exec('/bin/chmod', ['-R', 'u+rwX', dir]);
    await rm(dir, { recursive: true, force: true });
  }
}
