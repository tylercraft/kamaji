import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realExec } from './exec.js';
import { fakeRestic } from './fakeRestic.js';
import { fallbackVersion, restoreCheck, type Exec, type RestoreDeps } from './restore.js';
import { pullOf, SITE } from './testTar.js';

/** Docker as a list of what it was asked, answering from `answer`; tar runs for real. */
function setup(
  tar: Buffer,
  answer: (args: string[]) => { code: number; stdout?: string; stderr?: string },
) {
  const workDir = mkdtempSync(join(tmpdir(), 'kamaji-restore-'));
  const { restic } = fakeRestic(() => tar);
  // restic restore puts <site>.tar under the target, as it was backed up.
  restic.restore = async (_id, target) => {
    writeFileSync(join(target, `${SITE}.tar`), tar);
    return { ok: true };
  };
  const asked: string[][] = [];
  const tarExec = realExec();
  const exec: Exec = async (command, args, options) => {
    if (command !== deps.docker) return tarExec(command, args, options);
    asked.push(args);
    const a = answer(args);
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  const deps: RestoreDeps = {
    restic,
    exec,
    workDir,
    docker: '/usr/local/bin/docker',
    sleep: async () => {},
  };
  return { deps, asked, workDir };
}

const site = { id: SITE, expectedText: 'Hello' };

describe('the restore check', () => {
  it('restores, starts an offline copy, finds the home page’s text, and cleans up', async () => {
    const { deps, asked, workDir } = setup(pullOf(), (args) =>
      args.includes('curl') ? { code: 0, stdout: '<h1>Hello</h1>\n200' } : { code: 0 },
    );
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({ ok: true });
    const network = asked[0]!;
    expect(network.slice(0, 3)).toEqual(['network', 'create', '--internal']);
    const wp = asked.find((a) => a.at(-1) === 'wordpress:6.8.3-apache')!;
    expect(wp).toContain('WORDPRESS_TABLE_PREFIX=wp_');
    expect(wp).toContain(network[3]);
    expect(asked.at(-2)?.slice(0, 2)).toEqual(['rm', '--force']);
    expect(asked.at(-1)).toEqual(['network', 'rm', network[3]]);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('fails at the home page without the expected text, still cleaning up', async () => {
    const { deps, asked, workDir } = setup(pullOf(), (args) =>
      args.includes('curl') ? { code: 0, stdout: 'Install WordPress\n200' } : { code: 0 },
    );
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({
      ok: false,
      step: 'home page',
      problem: 'the test copy’s home page gave a page without the site’s expected text',
    });
    expect(asked.at(-1)?.slice(0, 2)).toEqual(['network', 'rm']);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('says so when Docker isn’t answering, or the restored tar doesn’t check out', async () => {
    const down = setup(pullOf(), () => ({ code: 1 }));
    expect(await restoreCheck(down.deps, site, 'a'.repeat(64))).toEqual({
      ok: false,
      step: 'docker',
      problem: 'Docker isn’t answering on the mini',
      detail: null,
    });
    expect(down.asked).toHaveLength(1);
    const other = setup(pullOf('other.test'), () => ({ code: 0 }));
    expect(await restoreCheck(other.deps, site, 'a'.repeat(64))).toMatchObject({
      step: 'verify',
      problem: 'the backup is of another site',
    });
    expect(existsSync(other.workDir)).toBe(true);
    expect(readdirSync(other.workDir)).toEqual([]);
  });

  it('keeps the end of what a failed import said, scrubbed, and still cleans up', async () => {
    const said = [
      ...Array.from({ length: 30 }, (_, i) => `noise ${i}`),
      'mysql: [Warning] Using a password on the command line: --password hunter2',
      `ERROR 1064 (42000) at line 2711: You have an error in your SQL syntax near '${'Client Ltd, 4021 Main St, invoice 1182 for 250000 NZD'}' at line 1`,
      `auth_token=${'a1B2'.repeat(12)} and a bare ${'Zx9_'.repeat(10)}`,
    ].join('\n');
    const { deps, asked, workDir } = setup(pullOf(), (args) =>
      args.includes('wordpress') && args.includes('-i') ? { code: 1, stderr: said } : { code: 0 },
    );
    const result = await restoreCheck(deps, site, 'a'.repeat(64));
    expect(result).toMatchObject({
      ok: false,
      step: 'database',
      problem: 'database.sql didn’t import',
    });
    const detail = (result as { detail: string }).detail;
    const lines = detail.split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('noise 13');
    expect(detail).not.toContain('hunter2');
    expect(detail).toContain('--password [hidden]');
    expect(detail).toContain('at line 2711');
    // The dump's own text is cut to its first 40 characters.
    expect(detail).toContain("near 'Client Ltd, 4021 Main St, invoice 1182 f…'");
    expect(detail).not.toContain('250000');
    expect(detail).not.toContain('a1B2a1B2');
    expect(detail).not.toContain('Zx9_Zx9_');
    expect(asked.at(-1)?.slice(0, 2)).toEqual(['network', 'rm']);
    expect(readdirSync(workDir)).toEqual([]);
  });
});

describe('waiting for MariaDB', () => {
  const NO_SOCKET =
    "ERROR 2002 (HY000): Can't connect to local server through socket '/run/mysqld/mysqld.sock' (2)";
  const healthcheck = (args: string[]) => args.includes('healthcheck.sh');
  const importing = (args: string[]) => args.includes('-i') && args.includes('wordpress');
  const ok = (args: string[]) =>
    args.includes('curl') ? { code: 0, stdout: '<h1>Hello</h1>\n200' } : { code: 0 };

  it('waits for the image’s healthcheck, not a socket ping the first-run server passes', async () => {
    // The temporary server answers over the socket from the start; the real one, over TCP, only
    // from the fourth healthcheck.
    let checks = 0;
    let imports = 0;
    const { deps, asked } = setup(pullOf(), (args) => {
      if (args.includes('SELECT 1')) return { code: 0 };
      if (healthcheck(args)) return { code: ++checks >= 4 ? 0 : 1 };
      if (importing(args)) {
        imports += 1;
        return checks >= 4 ? { code: 0 } : { code: 1, stderr: NO_SOCKET };
      }
      return ok(args);
    });
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({ ok: true });
    expect(checks).toBe(4);
    expect(imports).toBe(1);
    expect(asked.find(healthcheck)).toEqual([
      'exec',
      expect.stringMatching(/-db$/),
      'healthcheck.sh',
      '--connect',
      '--innodb_initialized',
    ]);
    expect(asked.some((a) => a.includes('SELECT 1'))).toBe(false);
  });

  it('tries an import that couldn’t reach the server once more, after waiting again', async () => {
    let imports = 0;
    const { deps } = setup(pullOf(), (args) => {
      if (importing(args)) return ++imports === 1 ? { code: 1, stderr: NO_SOCKET } : { code: 0 };
      return ok(args);
    });
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({ ok: true });
    expect(imports).toBe(2);
  });

  it('tries only once more, and never for an import that failed in the SQL', async () => {
    let imports = 0;
    const always = setup(pullOf(), (args) =>
      importing(args) ? (imports++, { code: 1, stderr: NO_SOCKET }) : ok(args),
    );
    expect(await restoreCheck(always.deps, site, 'a'.repeat(64))).toMatchObject({
      step: 'database',
      problem: 'database.sql didn’t import',
    });
    expect(imports).toBe(2);
    imports = 0;
    const syntax = setup(pullOf(), (args) =>
      importing(args)
        ? (imports++, { code: 1, stderr: 'ERROR 1064 (42000) at line 3: syntax' })
        : ok(args),
    );
    expect(await restoreCheck(syntax.deps, site, 'a'.repeat(64))).toMatchObject({
      problem: 'database.sql didn’t import',
    });
    expect(imports).toBe(1);
  });

  it('gives up after two minutes of an unhealthy server, still cleaning up', async () => {
    const { deps, asked, workDir } = setup(pullOf(), (args) =>
      healthcheck(args) ? { code: 1 } : ok(args),
    );
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({
      ok: false,
      step: 'database',
      problem: 'MariaDB didn’t become ready within 2 minutes',
    });
    expect(asked.filter(healthcheck)).toHaveLength(60);
    expect(asked.at(-1)?.slice(0, 2)).toEqual(['network', 'rm']);
    expect(readdirSync(workDir)).toEqual([]);
  });
});

describe('a WordPress release Docker Hub doesn’t have yet', () => {
  // What docker run said for briardalewealth.com's 7.1.5, as the test tar's 6.8.3.
  const missing = (version: string) =>
    readFileSync(
      join(import.meta.dirname, 'fixtures', 'docker-run-image-not-found.txt'),
      'utf8',
    ).replaceAll('7.1.5', version);
  const runs = (asked: string[][]) =>
    asked.filter((a) => a[0] === 'run' && a.at(-1)?.startsWith('wordpress:')).map((a) => a.at(-1));
  const answer =
    (wordpress: (image: string) => { code: number; stderr?: string }) => (args: string[]) => {
      if (args[0] === 'run' && args.at(-1)?.startsWith('wordpress:'))
        return wordpress(args.at(-1)!);
      return args.includes('curl') ? { code: 0, stdout: '<h1>Hello</h1>\n200' } : { code: 0 };
    };

  it('uses the release’s own image when there is one', async () => {
    const { deps, asked } = setup(
      pullOf(),
      answer(() => ({ code: 0 })),
    );
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({ ok: true });
    expect(runs(asked)).toEqual(['wordpress:6.8.3-apache']);
  });

  it('falls back to the major.minor image, says so, and cleans up', async () => {
    const { deps, asked, workDir } = setup(
      pullOf(),
      answer((image) =>
        image === 'wordpress:6.8.3-apache' ? { code: 125, stderr: missing('6.8.3') } : { code: 0 },
      ),
    );
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toEqual({
      ok: true,
      note: 'checked on wordpress:6.8-apache (6.8.3 not on Docker Hub yet)',
    });
    expect(runs(asked)).toEqual(['wordpress:6.8.3-apache', 'wordpress:6.8-apache']);
    const first = asked.findIndex((a) => a.at(-1) === 'wordpress:6.8.3-apache');
    expect(asked[first + 1]).toEqual(['rm', '--force', expect.stringMatching(/-wp$/)]);
    expect(asked.at(-1)?.slice(0, 2)).toEqual(['network', 'rm']);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('fails at WordPress, naming both images, when the fallback is missing too', async () => {
    const { deps, asked } = setup(
      pullOf(),
      answer((image) => ({ code: 125, stderr: missing(image.slice(10, -7)) })),
    );
    const result = await restoreCheck(deps, site, 'a'.repeat(64));
    expect(result).toMatchObject({
      ok: false,
      step: 'wordpress',
      problem:
        'wordpress:6.8.3-apache isn’t on Docker Hub, and wordpress:6.8-apache didn’t start either',
    });
    expect((result as { detail: string }).detail).toContain('wordpress:6.8-apache: not found');
    expect(runs(asked)).toEqual(['wordpress:6.8.3-apache', 'wordpress:6.8-apache']);
    expect(asked.at(-1)?.slice(0, 2)).toEqual(['network', 'rm']);
  });

  it('doesn’t fall back when the image is there and the container didn’t start', async () => {
    const conflict =
      'docker: Error response from daemon: Conflict. The container name "/kamaji-restore-1-wp" is already in use.';
    const { deps, asked } = setup(
      pullOf(),
      answer(() => ({ code: 125, stderr: conflict })),
    );
    expect(await restoreCheck(deps, site, 'a'.repeat(64))).toMatchObject({
      ok: false,
      step: 'wordpress',
      problem: 'wordpress:6.8.3-apache didn’t start',
    });
    expect(runs(asked)).toEqual(['wordpress:6.8.3-apache']);
  });

  it('falls back only from a three-part version', () => {
    expect(fallbackVersion('7.1.5')).toBe('7.1');
    expect(fallbackVersion('7.1')).toBeNull();
    expect(fallbackVersion('7.1-RC1')).toBeNull();
    expect(fallbackVersion('7.1.5-beta2')).toBeNull();
  });
});
