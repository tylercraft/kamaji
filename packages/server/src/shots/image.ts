// The browser image (shots/Dockerfile): built by the screenshots process on the mini when the
// folder's files change (Tyler, 2026-11-19: not by deploy.sh). Its tag is a hash of those files,
// so a change makes a new tag and the old ones are removed once the new one is built.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '../sitebackups/restore.js';

export const IMAGE = 'kamaji-shots';
const FILES = ['Dockerfile', '.dockerignore', 'shoot.mjs', 'guard.mjs'];
const BUILD_MS = 30 * 60_000;

/** kamaji-shots:<12 hex>, from the files the image is built from. */
export function imageTag(dir: string): string {
  const hash = createHash('sha256');
  for (const f of FILES)
    hash
      .update(f)
      .update('\0')
      .update(readFileSync(join(dir, f)));
  return `${IMAGE}:${hash.digest('hex').slice(0, 12)}`;
}

export type ImageReady = { ok: true; tag: string } | { ok: false; problem: string };

export async function ensureImage(
  exec: Exec,
  docker: string,
  dir: string,
  log: (message: string) => void,
): Promise<ImageReady> {
  const tag = imageTag(dir);
  const info = await exec(docker, ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 30_000,
  });
  if (info.code !== 0) return { ok: false, problem: 'Docker isn’t answering' };
  const there = await exec(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], {
    timeoutMs: 30_000,
  });
  if (there.code === 0) return { ok: true, tag };
  log(`shots: building ${tag}`);
  const built = await exec(docker, ['build', '--pull=false', '-t', tag, dir], {
    timeoutMs: BUILD_MS,
  });
  if (built.code !== 0)
    return {
      ok: false,
      problem: `the browser image couldn’t be built (${built.code === null ? 'it took too long' : `exit ${built.code}`})`,
    };
  log(`shots: built ${tag}`);
  // The old tags, by the tag alone (our own --format).
  const listed = await exec(docker, ['image', 'ls', IMAGE, '--format', '{{.Tag}}'], {
    timeoutMs: 30_000,
  });
  for (const old of listed.stdout.split('\n').map((t) => t.trim())) {
    if (/^[0-9a-f]{12}$/.test(old) && `${IMAGE}:${old}` !== tag)
      await exec(docker, ['image', 'rm', `${IMAGE}:${old}`], { timeoutMs: 60_000 });
  }
  return { ok: true, tag };
}
