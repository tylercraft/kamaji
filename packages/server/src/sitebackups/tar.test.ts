import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPull, readTar, TarReader } from './tar.js';

const SITE = 'one.test';
const DB = Buffer.from('-- MySQL dump\nCREATE TABLE wp_options (x int);\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function manifest(db = DB, site = SITE) {
  return JSON.stringify({
    format: 1,
    site,
    at: '20261113T004147Z',
    wordpress: '6.8.3',
    tablePrefix: 'wp_',
    config: [{ name: 'DB_NAME' }, { name: 'table_prefix' }],
    database: { bytes: db.length, sha256: sha(db) },
  });
}

/** A GNU-style tar: one header per entry, an 'L' entry first for names over 100 bytes. */
function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(type, 156);
  h.write('ustar  \0', 257, 'latin1');
  h.write('        ', 148);
  const sum = h.reduce((n, b) => n + b, 0);
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function tarOf(entries: [string, Buffer | null][], end = true): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of entries) {
    if (name.length > 100) {
      const long = Buffer.from(`${name}\0`);
      parts.push(header('././@LongLink', long.length, 'L'), pad(long));
    }
    if (data === null) parts.push(header(name, 0, '5'));
    else parts.push(header(name, data.length, '0'), pad(data));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

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
