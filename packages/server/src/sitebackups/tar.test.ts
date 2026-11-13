import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPull, readTar, TarReader } from './tar.js';
import { DB, manifest, sha, SITE, tarOf } from './testTar.js';

const good = () =>
  tarOf([
    ['wp-content/', null],
    [`wp-content/uploads/${'deep/'.repeat(30)}photo.jpg`, Buffer.alloc(1500, 7)],
    ['wp-content/themes/site/style.css', Buffer.from('body{}')],
    ['.htaccess', Buffer.from('# BEGIN WordPress')],
    ['database.sql', DB],
    ['manifest.json', Buffer.from(manifest())],
  ]);

/** Fed in awkward pieces, the way a pipe delivers it. */
function read(tar: Buffer, piece = 77) {
  const reader = new TarReader();
  for (let at = 0; at < tar.length; at += piece) reader.push(tar.subarray(at, at + piece));
  return reader.end();
}

describe('reading a pull back', () => {
  it('hashes database.sql, keeps the manifest and passes a whole pull, in any chunking', () => {
    for (const piece of [1, 77, 512, 4096, 1 << 20]) {
      const result = read(good(), piece);
      expect(result).toMatchObject({
        ended: true,
        files: 5,
        last: 'manifest.json',
        wpContent: true,
        database: { bytes: DB.length, sha256: sha(DB) },
      });
      expect(checkPull(result, SITE)).toMatchObject({ ok: true, manifest: { tablePrefix: 'wp_' } });
    }
  });

  it('refuses a pull cut short, out of order, of another site or with a changed database', () => {
    const cut = good().subarray(0, good().length - 1024 - 512);
    expect(checkPull(read(cut), SITE)).toEqual({
      ok: false,
      problem: 'the backup stops before the end of its tar',
    });
    const late = tarOf([
      ['wp-content/a', Buffer.from('a')],
      ['manifest.json', Buffer.from(manifest())],
      ['database.sql', DB],
    ]);
    expect(checkPull(read(late), SITE)).toMatchObject({ problem: /manifest isn’t its last/ });
    expect(checkPull(read(good()), 'two.test')).toMatchObject({ problem: /another site/ });
    const changed = tarOf([
      ['wp-content/a', Buffer.from('a')],
      ['database.sql', Buffer.from('something else')],
      ['manifest.json', Buffer.from(manifest())],
    ]);
    expect(checkPull(read(changed), SITE)).toMatchObject({ problem: /database.sql doesn’t/ });
    const empty = tarOf([
      ['database.sql', DB],
      ['manifest.json', Buffer.from(manifest())],
    ]);
    expect(checkPull(read(empty), SITE)).toMatchObject({ problem: /no wp-content/ });
    const junk = tarOf([
      ['wp-content/a', Buffer.from('a')],
      ['database.sql', DB],
      ['manifest.json', Buffer.from('{"format":2}')],
    ]);
    expect(checkPull(read(junk), SITE)).toMatchObject({ problem: /manifest isn’t readable/ });
  });

  it('reads what this machine’s own tar writes in GNU format', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-tar-'));
    mkdirSync(join(dir, 'wp-content', 'uploads', 'a'.repeat(120)), { recursive: true });
    writeFileSync(join(dir, 'wp-content', 'uploads', 'a'.repeat(120), 'b.txt'), 'b');
    writeFileSync(join(dir, 'database.sql'), DB);
    writeFileSync(join(dir, 'manifest.json'), manifest());
    const made = spawnSync(
      '/usr/bin/tar',
      ['--format', 'gnutar', '-cf', '-', '-C', dir, 'wp-content', 'database.sql', 'manifest.json'],
      { maxBuffer: 1 << 24 },
    );
    expect(made.status).toBe(0);
    const result = await readTar(
      (async function* () {
        yield made.stdout;
      })(),
    );
    expect(checkPull(result, SITE)).toMatchObject({ ok: true });
  });
});
