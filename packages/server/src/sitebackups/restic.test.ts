import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBackup, parseSnapshots, parseStats, problem, realRestic } from './restic.js';

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

describe('restic’s answers (fixtures/README.md)', () => {
  it('reads backup’s summary line past its status lines', () => {
    expect(parseBackup(fixture('backup.jsonl'))).toMatchObject({
      snapshot_id: '4bba301e2b4c0b1d4f0a3e8a8d5e9c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d',
      total_bytes_processed: 73400320,
      data_added: 5242880,
    });
    expect(parseBackup('{"message_type":"status"}\n')).toBeNull();
  });

  it('reads the snapshot list and the repository’s size', () => {
    expect(parseSnapshots(fixture('snapshots.json'))).toEqual([
      'c5122c366e2702955734950e42d6eb4d83af7c9213e793f3e5639e94f28c3207',
    ]);
    expect(parseStats(fixture('stats.json'))).toBe(333607448);
    expect(parseSnapshots('not json')).toBeNull();
  });

  it('says what went wrong without keeping stderr', () => {
    expect(problem(1, 'Fatal: …\n{"format":1,"ok":false,"problem":"not on the allowlist"}\n')).toBe(
      'craftish: not on the allowlist',
    );
    expect(problem(12, 'Fatal: wrong password or no key found\n')).toBe(
      'the restic repository’s password is wrong',
    );
    expect(problem(1, 'ssh: connect to host … port 22: Connection refused')).toBe(
      'restic failed (exit 1)',
    );
  });
});

/** A stand-in restic: records its arguments and environment, answers from the fixtures. */
function fake(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kamaji-restic-'));
  const bin = join(dir, 'restic');
  writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/args"\n${script}\n`);
  chmodSync(bin, 0o755);
  return {
    restic: realRestic(bin),
    args: () => readFileSync(join(dir, 'args'), 'utf8').trim().split('\n'),
  };
}

describe('running restic', () => {
  it('backs up the pull command’s output as <site>.tar, tagged, with the password never on argv', async () => {
    const { restic, args } = fake(
      `cat '${new URL('fixtures/backup.jsonl', import.meta.url).pathname}'`,
    );
    const result = await restic.backup('one.test', [
      '/usr/bin/ssh',
      'kamaji-pull@craftish',
      'one.test',
    ]);
    expect(result).toEqual({
      ok: true,
      snapshotId: '4bba301e2b4c0b1d4f0a3e8a8d5e9c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d',
      bytes: 73400320,
      added: 5242880,
    });
    expect(args()).toEqual([
      'backup',
      '--json',
      '--host',
      'craftish',
      '--tag',
      'site:one.test',
      '--stdin-filename',
      'one.test.tar',
      '--stdin-from-command',
      '--',
      '/usr/bin/ssh',
      'kamaji-pull@craftish',
      'one.test',
    ]);
  });

  it('passes the pull’s refusal through, and streams a dump to its reader', async () => {
    const refused = fake(
      `echo '{"format":1,"ok":false,"problem":"not on the allowlist"}' >&2; exit 1`,
    );
    expect(await refused.restic.backup('one.test', ['/usr/bin/ssh'])).toEqual({
      ok: false,
      problem: 'craftish: not on the allowlist',
    });
    const dump = fake(`printf 'hello'`);
    const read = async (s: AsyncIterable<Buffer>) => {
      let all = '';
      for await (const chunk of s) all += chunk.toString();
      return all;
    };
    expect(await dump.restic.dump('abc', 'one.test', read)).toEqual({ ok: true, value: 'hello' });
    expect(dump.args()).toEqual(['dump', 'abc', '/one.test.tar']);
  });
});
