import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realExec } from './exec.js';
import { fakeRestic } from './fakeRestic.js';
import { restoreCheck, type Exec, type RestoreDeps } from './restore.js';
import { pullOf, SITE } from './testTar.js';

/** Docker as a list of what it was asked, answering from `answer`; tar runs for real. */
function setup(tar: Buffer, answer: (args: string[]) => { code: number; stdout?: string }) {
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
    return { code: a.code, stdout: a.stdout ?? '' };
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
});
