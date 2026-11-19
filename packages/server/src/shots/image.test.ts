import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../sitebackups/restore.js';
import { ensureImage, imageTag } from './image.js';

const DIR = fileURLToPath(new URL('../../../../shots', import.meta.url));

function docker(answers: Record<string, { code: number | null; stdout?: string }>) {
  const calls: string[] = [];
  const exec: Exec = async (_bin, args) => {
    const key = args.slice(0, 2).join(' ');
    calls.push(args.join(' '));
    const a = answers[key] ?? { code: 0 };
    return { code: a.code, stdout: a.stdout ?? '' };
  };
  return { exec, calls };
}

describe('the browser image', () => {
  it('is tagged by the files it’s built from', () => {
    expect(imageTag(DIR)).toMatch(/^kamaji-shots:[0-9a-f]{12}$/);
  });

  it('is used when it’s there', async () => {
    const d = docker({});
    expect(await ensureImage(d.exec, 'docker', DIR, () => {})).toEqual({
      ok: true,
      tag: imageTag(DIR),
    });
    expect(d.calls.some((c) => c.startsWith('build'))).toBe(false);
  });

  it('is built when it isn’t, from shots/, and older tags go', async () => {
    const tag = imageTag(DIR);
    const d = docker({
      'image inspect': { code: 1 },
      'image ls': { code: 0, stdout: `${tag.split(':')[1]}\n0123456789ab\n` },
    });
    expect(await ensureImage(d.exec, 'docker', DIR, () => {})).toEqual({ ok: true, tag });
    expect(d.calls).toContain(`build --pull=false -t ${tag} ${DIR}`);
    expect(d.calls).toContain('image rm kamaji-shots:0123456789ab');
    expect(d.calls).not.toContain(`image rm ${tag}`);
  });

  it('says when Docker isn’t answering, or the build fails', async () => {
    expect(
      await ensureImage(docker({ 'info --format': { code: 1 } }).exec, 'docker', DIR, () => {}),
    ).toEqual({ ok: false, problem: 'Docker isn’t answering' });
    expect(
      await ensureImage(
        docker({ 'image inspect': { code: 1 }, 'build --pull=false': { code: 1 } }).exec,
        'docker',
        DIR,
        () => {},
      ),
    ).toEqual({ ok: false, problem: 'the browser image couldn’t be built (exit 1)' });
  });
});
