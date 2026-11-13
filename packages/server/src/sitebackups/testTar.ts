// A tar like site-pull's, for the tests.
import { createHash } from 'node:crypto';

export const SITE = 'one.test';
export const DB = Buffer.from('-- MySQL dump\nCREATE TABLE wp_options (x int);\n');
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function manifest(db = DB, site = SITE) {
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

export function tarOf(entries: [string, Buffer | null][], end = true): Buffer {
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

/** A whole pull of `site`, as site-pull writes it. */
export const pullOf = (site = SITE, db = DB) =>
  tarOf([
    ['wp-content/', null],
    ['wp-content/themes/site/style.css', Buffer.from('body{}')],
    ['database.sql', db],
    ['manifest.json', Buffer.from(manifest(db, site))],
  ]);
