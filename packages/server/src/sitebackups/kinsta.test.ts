import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { testDb } from '../testing.js';
import {
  blocked,
  kinstaCommand,
  kinstaView,
  okSize,
  readScript,
  readTest,
  recordTest,
  remoteCommand,
  saveAccess,
} from './kinsta.js';
import { problem } from './restic.js';

const T = Date.UTC(2026, 10, 18, 7, 0);
const ACCESS = { host: '203.0.113.7', port: 12345, user: 'photogravure' };
const SSH = { key: '/Users/tylercraft/.ssh/kamaji-kinsta', knownHosts: '/k/known_hosts' };

function kinsta(db: Db, id = 'photogravure.com', host = 'kinsta') {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, 'Photogravure', ?, ?, 'connected', 'done', 0)`,
  ).run(id, `https://${id}/`, host);
}

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({
    format: 1,
    ok: true,
    path: '/www/photogravure_123/public',
    wordpress: '6.8.3',
    home: 'https://www.photogravure.com',
    wpContentBytes: 2_147_483_648,
    databaseBytes: 52_428_800,
    wpCli: '2.11.0',
    ...fields,
  });

describe('the SSH command', () => {
  it('ssh with Kamaji’s Kinsta key, its own known_hosts, Kinsta’s port and user', () => {
    const db = testDb();
    kinsta(db);
    expect(kinstaCommand(db, SSH, 'photogravure.com', 'pull')).toBeNull();
    saveAccess(db, 'photogravure.com', ACCESS, 'tylercraft@github', T);
    const argv = kinstaCommand(db, SSH, 'photogravure.com', 'pull', 'echo hi')!;
    expect(argv.slice(0, -1)).toEqual([
      '/usr/bin/ssh',
      '-i',
      SSH.key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'UserKnownHostsFile=/k/known_hosts',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=30',
      '-T',
      '-p',
      '12345',
      '-l',
      'photogravure',
      '--',
      '203.0.113.7',
    ]);
    expect(argv.at(-1)).toBe(`bash -c 'echo hi' kamaji-pull 'photogravure.com'`);
  });

  it('the login shell gets the script and the site exactly, quotes and all', () => {
    // As sshd runs it: the user's shell, with the command as one string.
    const body = `printf '%s|' "$0" "$@"; echo " it's"`;
    const out = execFileSync('/bin/sh', ['-c', remoteCommand(body, 'test', 'photogravure.com')], {
      encoding: 'utf8',
    });
    expect(out).toBe(`kamaji-test|photogravure.com| it's\n`);
  });

  it('sends the repo’s own scripts', () => {
    for (const script of ['pull', 'test'] as const) {
      const body = readScript(script);
      expect(body.startsWith('#!/bin/bash\n')).toBe(true);
      expect(body).not.toContain('wp-config.php"\n');
    }
    // The same exclusions as craftish's site-pull, word for word.
    const excludes = (text: string) => text.match(/--exclude=\S+/g);
    expect(excludes(readScript('pull'))).toEqual(
      excludes(readFileSync(new URL('../../../../server-pull/site-pull', import.meta.url), 'utf8')),
    );
  });
});

describe('Test connection’s answer', () => {
  it('where WordPress is and its sizes', () => {
    expect(readTest('photogravure.com', { code: 0, stdout: `${line({})}\n` })).toEqual({
      ok: true,
      path: '/www/photogravure_123/public',
      wordpress: '6.8.3',
      wpCli: '2.11.0',
      wpContentBytes: 2_147_483_648,
      databaseBytes: 52_428_800,
    });
  });

  it('another site’s login is refused, as the pull refuses it', () => {
    expect(
      readTest('photogravure.com', { code: 0, stdout: line({ home: 'https://sweetleisure.com' }) }),
    ).toEqual({
      ok: false,
      problem: 'this SSH login is another site (its WordPress is sweetleisure.com)',
    });
  });

  it('the script’s own refusal, SSH not getting in, and anything else, in Kamaji’s words', () => {
    expect(
      readTest('photogravure.com', {
        code: 2,
        stdout: '{"format":1,"ok":false,"problem":"no WordPress in ~/public"}\n',
      }),
    ).toEqual({ ok: false, problem: 'Kinsta: no WordPress in ~/public' });
    expect(readTest('photogravure.com', { code: 255, stdout: '' })).toMatchObject({
      problem: expect.stringMatching(/^SSH couldn’t connect or log in/),
    });
    expect(readTest('photogravure.com', { code: null, stdout: '' })).toMatchObject({
      problem: 'SSH didn’t finish in time',
    });
    expect(readTest('photogravure.com', { code: 0, stdout: 'Warning: x\n' })).toMatchObject({
      problem: 'the test’s answer wasn’t readable',
    });
  });

  it('a pull’s refusal reads as Kinsta’s', () => {
    expect(
      problem(1, '{"format":1,"ok":false,"problem":"the database export failed"}', 'kinsta'),
    ).toBe('Kinsta: the database export failed');
  });
});

describe('access, tests and the 20 GB okay', () => {
  it('saved only on a Kinsta site; a change clears the last test and the okay', () => {
    const db = testDb();
    kinsta(db);
    kinsta(db, 'craftish.test', 'craftish');
    expect(saveAccess(db, 'craftish.test', ACCESS, 'tylercraft@github', T)).toBe('not-kinsta');
    saveAccess(db, 'photogravure.com', ACCESS, 'tylercraft@github', T);
    expect(kinstaView(db, 'photogravure.com')!.blocked).toBe('Test connection first');
    recordTest(
      db,
      'photogravure.com',
      readTest('photogravure.com', { code: 0, stdout: line({ wpContentBytes: 25 * 1024 ** 3 }) }),
      T,
    );
    expect(kinstaView(db, 'photogravure.com')!.blocked).toBe(
      'it measured 25.0 GB, over 20 GB: okay that size first',
    );
    expect(okSize(db, 'photogravure.com', 'tylercraft@github', T)).toBe('okayed');
    expect(kinstaView(db, 'photogravure.com')).toMatchObject({
      blocked: null,
      sizeOk: { by: 'tylercraft@github' },
    });
    // The same again changes nothing; a new port starts over.
    saveAccess(db, 'photogravure.com', ACCESS, 'tylercraft@github', T + 1);
    expect(kinstaView(db, 'photogravure.com')!.test).not.toBeNull();
    saveAccess(db, 'photogravure.com', { ...ACCESS, port: 23456 }, 'tylercraft@github', T + 2);
    expect(kinstaView(db, 'photogravure.com')).toMatchObject({ test: null, sizeOk: null });
  });

  it('under 20 GB needs no okay', () => {
    expect(
      blocked({
        tested_at: 1,
        test_ok: 1,
        wp_content_bytes: 1024,
        database_bytes: 1024,
        size_ok_at: null,
      }),
    ).toBeNull();
  });
});
