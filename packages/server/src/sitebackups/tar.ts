// Reading back a whole-site pull (server-pull/site-pull) as it streams: the tar's entries, with
// database.sql hashed and manifest.json kept, without ever holding more than one header in
// memory. Enough of tar for what GNU tar writes: ustar headers, GNU long names ('L') and pax
// headers ('x', 'g'), sizes in octal or base-256.
import { createHash, type Hash } from 'node:crypto';
import { z } from 'zod';

const BLOCK = 512;
const MANIFEST_MAX = 1024 * 1024;

export interface PullRead {
  /** The two zero blocks that end a tar arrived. */
  ended: boolean;
  files: number;
  bytes: number;
  /** The last regular file's name. manifest.json must be it. */
  last: string | null;
  database: { bytes: number; sha256: string } | null;
  manifest: string | null;
  /** Anything under wp-content/. */
  wpContent: boolean;
}

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

function size(block: Buffer): number {
  const field = block.subarray(124, 136);
  if ((field[0]! & 0x80) !== 0) {
    // Base-256, for files of 8 GB or more.
    let n = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const octal = text(block, 124, 12).trim();
  return octal === '' ? 0 : parseInt(octal, 8);
}

/** A pax header's path, if it sets one: records are "<length> <key>=<value>\n". */
function paxPath(data: Buffer): string | null {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) return null;
    const length = parseInt(data.subarray(at, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') return record.slice(eq + 1);
    at += length;
  }
  return null;
}

export class TarReader {
  private header = Buffer.alloc(0);
  /** Bytes of the current entry's data still to come, then its padding. */
  private remaining = 0;
  private padding = 0;
  private zeroBlocks = 0;
  private entry: {
    name: string;
    type: string;
    size: number;
    hash: Hash | null;
    keep: Buffer[] | null;
  } | null = null;
  private nextName: string | null = null;
  private readonly result: PullRead = {
    ended: false,
    files: 0,
    bytes: 0,
    last: null,
    database: null,
    manifest: null,
    wpContent: false,
  };

  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length && !this.result.ended) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - at);
        this.data(chunk.subarray(at, at + take));
        at += take;
        this.remaining -= take;
        if (this.remaining === 0) this.finishEntry();
        continue;
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, chunk.length - at);
        at += take;
        this.padding -= take;
        continue;
      }
      const take = Math.min(BLOCK - this.header.length, chunk.length - at);
      this.header = Buffer.concat([this.header, chunk.subarray(at, at + take)]);
      at += take;
      if (this.header.length === BLOCK) {
        const block = this.header;
        this.header = Buffer.alloc(0);
        this.readHeader(block);
      }
    }
  }

  end(): PullRead {
    return this.result;
  }

  private readHeader(block: Buffer): void {
    if (block.every((b) => b === 0)) {
      if (++this.zeroBlocks === 2) this.result.ended = true;
      return;
    }
    this.zeroBlocks = 0;
    const type = String.fromCharCode(block[156] || 0x30);
    const magic = block.subarray(257, 263).toString('latin1');
    let name = text(block, 0, 100);
    // POSIX ustar splits long names into prefix/name; GNU uses that space for other things.
    if (magic === 'ustar\0') {
      const prefix = text(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (this.nextName !== null && type !== 'L' && type !== 'x') {
      name = this.nextName;
      this.nextName = null;
    }
    const length = size(block);
    const regular = type === '0' || type === '7';
    const meta = type === 'L' || type === 'x';
    name = name.replace(/^\.\//, '');
    this.entry = {
      name,
      type,
      size: length,
      hash: regular && name === 'database.sql' ? createHash('sha256') : null,
      keep: meta || (regular && name === 'manifest.json') ? [] : null,
    };
    if (regular) {
      this.result.files += 1;
      this.result.bytes += length;
      this.result.last = name;
      if (name.startsWith('wp-content/')) this.result.wpContent = true;
    }
    if (!regular && type === '5' && name.startsWith('wp-content')) this.result.wpContent = true;
    this.remaining = length;
    this.padding = (BLOCK - (length % BLOCK)) % BLOCK;
    if (length === 0) this.finishEntry();
  }

  private data(part: Buffer): void {
    const entry = this.entry;
    if (!entry) return;
    entry.hash?.update(part);
    if (entry.keep && entry.keep.reduce((n, b) => n + b.length, 0) < MANIFEST_MAX) {
      entry.keep.push(Buffer.from(part));
    }
  }

  private finishEntry(): void {
    const entry = this.entry;
    this.entry = null;
    if (!entry) return;
    const kept = entry.keep ? Buffer.concat(entry.keep) : null;
    if (entry.type === 'L' && kept) this.nextName = text(kept, 0, kept.length);
    if (entry.type === 'x' && kept) this.nextName = paxPath(kept);
    if (entry.hash) {
      this.result.database = { bytes: entry.size, sha256: entry.hash.digest('hex') };
    }
    if (entry.name === 'manifest.json' && kept) this.result.manifest = kept.toString('utf8');
  }
}

export const Manifest = z.object({
  format: z.literal(1),
  site: z.string(),
  at: z.string(),
  wordpress: z.string().regex(/^[0-9][0-9.a-zA-Z-]*$/),
  tablePrefix: z.string().regex(/^[A-Za-z0-9_]+$/),
  config: z.array(z.object({ name: z.string() })),
  database: z.object({ bytes: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
});
export type Manifest = z.infer<typeof Manifest>;

/** What's wrong with a pull as read back, in plain words, or its manifest when nothing is. */
export function checkPull(
  read: PullRead,
  site: string,
): { ok: true; manifest: Manifest } | { ok: false; problem: string } {
  if (!read.ended) return { ok: false, problem: 'the backup stops before the end of its tar' };
  if (read.last !== 'manifest.json' || read.manifest === null)
    return { ok: false, problem: 'the backup’s manifest isn’t its last file' };
  let manifest: Manifest;
  try {
    manifest = Manifest.parse(JSON.parse(read.manifest));
  } catch {
    return { ok: false, problem: 'the backup’s manifest isn’t readable' };
  }
  if (manifest.site !== site) return { ok: false, problem: 'the backup is of another site' };
  if (
    !read.database ||
    read.database.sha256 !== manifest.database.sha256 ||
    read.database.bytes !== manifest.database.bytes
  ) {
    return { ok: false, problem: 'database.sql doesn’t match the manifest' };
  }
  if (!read.wpContent) return { ok: false, problem: 'the backup has no wp-content' };
  return { ok: true, manifest };
}

/** Reads a whole stream through a TarReader. */
export async function readTar(stream: AsyncIterable<Buffer>): Promise<PullRead> {
  const reader = new TarReader();
  for await (const chunk of stream) reader.push(chunk);
  return reader.end();
}
