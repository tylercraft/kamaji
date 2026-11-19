// For the screenshot tests: a site with check pages, and a stand-in for `docker run kamaji-shots`
// that writes real PNGs into the set's folder and prints the shot script's lines.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Db } from '../db.js';
import type { Exec, Ran } from '../sitebackups/restore.js';

export const T = Date.UTC(2026, 10, 19, 3, 0);

export function site(db: Db, id = 'one.test') {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, important_pages, created_at)
     VALUES (?, 'One', ?, 'craftish', 'connected', 'done', ?, 0)`,
  ).run(id, `https://${id}/`, JSON.stringify([{ url: `https://${id}/shop/`, expectedText: null }]));
}

export function batch(db: Db, id = 'b1') {
  db.prepare(
    `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES (?, ?, 'tyler', 0, 'running')`,
  ).run(id, T);
}

/** A white page with a grey band at `band` px from the top. */
export function png(height: number, band = 0): Buffer {
  const p = new PNG({ width: 40, height });
  p.data.fill(255);
  for (let y = band; y < Math.min(height, band + 10); y += 1)
    for (let x = 0; x < 40; x += 1) p.data.writeUInt32BE(0x404040ff, (y * 40 + x) * 4);
  return PNG.sync.write(p);
}

export interface FakeShot {
  ok?: boolean;
  height?: number;
  band?: number;
  problem?: string;
  blocked?: boolean;
  jsKeys?: string[];
  failedKeys?: string[];
}

/**
 * A docker that runs the job as the script would: each round, page and size, with what `shot`
 * says for it. `code` and `stdout` stand in for a container that fails or is killed.
 */
export function fakeDocker(
  shot: (round: number, position: number, viewport: string) => FakeShot = () => ({}),
  over: Partial<Ran> & { skipRun?: boolean } = {},
) {
  const calls: string[][] = [];
  const exec: Exec = async (_command, args) => {
    calls.push(args);
    if (args[0] !== 'run') return { code: 0, stdout: '' };
    if (over.skipRun) return { code: over.code ?? 1, stdout: over.stdout ?? '' };
    const out = args[args.indexOf('--volume') + 1]!.replace(/:\/out:rw$/, '');
    const job = JSON.parse(args.at(-1)!) as {
      rounds: number;
      pages: string[];
      viewports: { name: string }[];
    };
    const lines: string[] = [];
    for (let round = 1; round <= job.rounds; round += 1)
      job.pages.forEach((_url, position) => {
        for (const { name: viewport } of job.viewports) {
          const s = shot(round, position, viewport);
          const base = `r${round}-p${position}-${viewport}`;
          if (s.ok === false) {
            lines.push(
              JSON.stringify({
                format: 1,
                kind: 'shot',
                round,
                position,
                viewport,
                ok: false,
                blocked: s.blocked ?? false,
                problem: s.problem ?? 'the page answered HTTP 500',
              }),
            );
            continue;
          }
          const height = s.height ?? 100;
          writeFileSync(join(out, `${base}.png`), png(height, s.band ?? 0));
          // A PNG under the thumbnail's name: browsers draw it whatever it's called.
          writeFileSync(join(out, `${base}.jpg`), png(Math.min(height, 60), s.band ?? 0));
          lines.push(
            JSON.stringify({
              format: 1,
              kind: 'shot',
              round,
              position,
              viewport,
              ok: true,
              file: `${base}.png`,
              thumb: `${base}.jpg`,
              width: 40,
              height,
              cut: false,
              quiet: true,
              status: 200,
              masks: [],
              jsErrors: s.jsKeys?.length ?? 0,
              jsKeys: s.jsKeys ?? [],
              failedRequests: s.failedKeys?.length ?? 0,
              failedKeys: s.failedKeys ?? [],
            }),
          );
        }
      });
    lines.push(JSON.stringify({ format: 1, kind: 'done' }));
    return { code: over.code ?? 0, stdout: over.stdout ?? lines.join('\n') };
  };
  return { exec, calls };
}
