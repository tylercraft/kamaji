// The craftish-care zip Kamaji offers at Add site: the plugin from this repo plus a keys file
// with Kamaji's two public keys for that site's install (docs/protocol.md, "Keys"). Nothing in
// it is secret. A small zip writer (deflate, no extras) so no dependency is needed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { CareKeys } from './keys.js';
import { publicKeyBase64 } from './keys.js';

const SKIP = new Set(['.gitignore', 'craftish-care-keys.php', '.DS_Store']);

function pluginFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !SKIP.has(name))
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? pluginFiles(path) : [path];
    })
    .sort();
}

export function keysFile(keys: CareKeys, site: string, at: Date): string {
  const php = (s: string) => `'${s.replace(/[\\']/g, '')}'`;
  return [
    '<?php',
    `// Built by Kamaji for ${site.replace(/[^a-z0-9.:-]/gi, '')} on ${at.toISOString().slice(0, 10)}.`,
    '// Public keys only: nothing here is secret. The plugin copies them in when it is activated.',
    "defined( 'ABSPATH' ) || exit;",
    `define( 'CRAFTISH_CARE_REPORT_KEY_ID', ${php(keys.report.id)} );`,
    `define( 'CRAFTISH_CARE_REPORT_KEY', ${php(publicKeyBase64(keys.report.privateKey))} );`,
    `define( 'CRAFTISH_CARE_UPDATE_KEY_ID', ${php(keys.updatePublic.id)} );`,
    `define( 'CRAFTISH_CARE_UPDATE_KEY', ${php(keys.updatePublic.publicKey)} );`,
    ...(keys.releasePublic
      ? [
          `define( 'CRAFTISH_CARE_RELEASE_KEY_ID', ${php(keys.releasePublic.id)} );`,
          `define( 'CRAFTISH_CARE_RELEASE_KEY', ${php(keys.releasePublic.publicKey)} );`,
        ]
      : []),
    '',
  ].join('\n');
}

function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** A zip of the given files, each name relative to the zip's root. */
export function zip(entries: { name: string; data: Buffer }[], at: Date): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The plugin, from `pluginDir`, with this site's keys file. */
function pluginEntries(pluginDir: string): { name: string; data: Buffer }[] {
  return pluginFiles(pluginDir).map((path) => ({
    name: `craftish-care/${relative(pluginDir, path).split(sep).join('/')}`,
    data: readFileSync(path),
  }));
}

/** A release for the signed channel: the plugin alone, with no site's keys file. */
export function releaseZip(pluginDir: string, at: Date): Buffer {
  return zip(pluginEntries(pluginDir), at);
}

export function pluginZip(pluginDir: string, keys: CareKeys, site: string, at: Date): Buffer {
  const entries = pluginEntries(pluginDir);
  entries.push({
    name: 'craftish-care/craftish-care-keys.php',
    data: Buffer.from(keysFile(keys, site, at), 'utf8'),
  });
  return zip(entries, at);
}
