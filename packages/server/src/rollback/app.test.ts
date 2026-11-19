import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RollbackCountView, SiteRollbackResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { rollbackApprovalProblem } from '../passkeys/guard.js';
import { testAuthenticator } from '../passkeys/testing.js';
import type { Exec } from '../sitebackups/restore.js';
import { testDb } from '../testing.js';
import { runCount } from './count.js';
import { DAY, run, site, T } from './testRollback.js';

const LOGIN = 'tylercraft@github';
const NOW = T + 2 * DAY;

function app() {
  const db = testDb();
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
  let started = 0;
  const passkey = testAuthenticator();
  const a = createApp({
    db,
    login: LOGIN,
    webDist,
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: NOW,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
    startBackups: () => void started++,
    log: () => {},
    passkeys: passkey.config,
    now: () => NOW,
  });
  const headers = { 'Tailscale-User-Login': LOGIN, Host: 'kamaji.test' };
  const view = async (id: string) =>
    SiteRollbackResponse.parse(
      await (await a.request(`/api/sites/${id}/rollback`, { headers })).json(),
    );
  const post = (path: string, body: unknown, signed = true) =>
    signed
      ? passkey.post(a, path, JSON.stringify(body), {
          ...headers,
          Origin: 'https://kamaji.test',
          'Content-Type': 'application/json',
        })
      : a.request(path, {
          method: 'POST',
          headers: {
            ...headers,
            Origin: 'https://kamaji.test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
  return { db, a, headers, view, post, passkey, started: () => started };
}

describe('rollback over the API', () => {
  it('shows the offer, and asks for it only with the passkey, waking the backups process', async () => {
    const { db, view, post, started } = app();
    site(db);
    run(db);
    expect((await view('one.test')).offer).toMatchObject({
      batchId: 'batch1',
      databaseFrom: 'snapshot',
    });
    const unsigned = await post(
      '/api/sites/one.test/rollback',
      { batchId: 'batch1', withDatabase: false },
      false,
    );
    expect(unsigned.status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rollbacks').get()!.n).toBe(0);
    const asked = await post('/api/sites/one.test/rollback', {
      batchId: 'batch1',
      withDatabase: false,
    });
    expect(asked.status).toBe(202);
    expect(started()).toBe(1);
    expect((await view('one.test')).latest).toMatchObject({
      kind: 'rollback',
      state: 'waiting',
      requestedBy: LOGIN,
    });
    const again = await post('/api/sites/one.test/rollback', {
      batchId: 'batch1',
      withDatabase: false,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: 'not_offered',
      problem: 'A rollback is already waiting or running for this site',
    });
  });

  it('refuses a body it doesn’t know, a site it doesn’t, and an undo with nothing to undo', async () => {
    const { db, a, headers, post } = app();
    site(db);
    run(db);
    expect((await post('/api/sites/one.test/rollback', { batchId: 'batch1' })).status).toBe(400);
    expect((await a.request('/api/sites/nope.test/rollback', { headers })).status).toBe(404);
    const undo = await post('/api/sites/one.test/rollback/undo', {
      rollbackId: '0123456789abcdef',
      withDatabase: false,
    });
    expect(undo.status).toBe(409);
  });

  it('signs each time: the passkey window doesn’t cover a rollback or its undo', async () => {
    const { db, a, headers, post } = app();
    site(db);
    run(db);
    const asked = await post('/api/sites/one.test/rollback', {
      batchId: 'batch1',
      withDatabase: false,
    });
    expect(asked.status).toBe(202);
    const cookie = (asked.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^kamaji_passkey=/);
    const underWindow = (path: string, body: unknown) =>
      a.request(path, {
        method: 'POST',
        headers: {
          ...headers,
          Origin: 'https://kamaji.test',
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      });
    // The window is open for other writes…
    expect((await underWindow('/api/issues/nope/dismiss', {})).status).toBe(404);
    // …but not these.
    expect(
      (await underWindow('/api/sites/one.test/rollback', { batchId: 'batch1', withDatabase: true }))
        .status,
    ).toBe(401);
    expect(
      (
        await underWindow('/api/sites/one.test/rollback/undo', {
          rollbackId: '0123456789abcdef',
          withDatabase: false,
        })
      ).status,
    ).toBe(401);
  });

  it('keeps the signature, which the backups process checks again before it pushes', async () => {
    const { db, post, passkey } = app();
    site(db);
    run(db);
    await post('/api/sites/one.test/rollback', { batchId: 'batch1', withDatabase: false });
    const id = String(db.prepare('SELECT id FROM rollbacks').get()!.id);
    expect(rollbackApprovalProblem(db, passkey.config, id)).toBeNull();
    // Changed after it was signed.
    db.prepare('UPDATE rollbacks SET with_database = 1').run();
    expect(rollbackApprovalProblem(db, passkey.config, id)).toBe(
      'the rollback isn’t what was approved',
    );
    db.prepare('UPDATE rollbacks SET with_database = 0').run();
    // Its signature copied onto a second row: one approval, one push.
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by,
         with_database, state, approval)
       SELECT 'fedcba9876543210', kind, site_id, batch_id, host, requested_at, requested_by,
         with_database, 'waiting', approval FROM rollbacks WHERE id = ?`,
    ).run(id);
    expect(rollbackApprovalProblem(db, passkey.config, 'fedcba9876543210')).toBe(
      'an approval used more than once',
    );
    db.prepare("DELETE FROM rollbacks WHERE id = 'fedcba9876543210'").run();
    // Signed by a passkey Kamaji doesn’t accept, or written straight into the database.
    expect(rollbackApprovalProblem(db, testAuthenticator().config, id)).toBe(
      'the approval’s passkey: not a passkey Kamaji accepts',
    );
    db.prepare('UPDATE rollbacks SET approval = NULL').run();
    expect(rollbackApprovalProblem(db, passkey.config, id)).toBe('no passkey approval');
  });

  it('counts before the passkey: asked without one, answered by the backups process', async () => {
    const { db, a, headers, post, started } = app();
    site(db);
    run(db);
    const asked = await post('/api/sites/one.test/rollback/count', { batchId: 'batch1' }, false);
    expect(asked.status).toBe(202);
    expect(started()).toBe(1);
    const { id } = (await asked.json()) as { id: string };
    // Asked again while it waits: the same count.
    const again = await post('/api/sites/one.test/rollback/count', { batchId: 'batch1' }, false);
    expect(((await again.json()) as { id: string }).id).toBe(id);
    expect(
      (await post('/api/sites/one.test/rollback/count', { batchId: 'other' }, false)).status,
    ).toBe(409);
    const view = async () =>
      RollbackCountView.parse(
        await (await a.request(`/api/sites/one.test/rollback/count/${id}`, { headers })).json(),
      );
    expect(await view()).toMatchObject({ state: 'waiting', counts: null });
    expect((await a.request(`/api/sites/two.test/rollback/count/${id}`, { headers })).status).toBe(
      404,
    );

    const words: string[][] = [];
    const exec: Exec = async (_bin, args) => {
      words.push(args);
      return {
        code: 0,
        stdout: '{"format":1,"step":"count","ok":true,"orders":null,"comments":3,"users":1}\n',
        stderr: '',
      };
    };
    await runCount(
      {
        db,
        exec,
        pushCommand: (_s, _h, w) => ['/usr/bin/ssh', ...w],
        now: () => NOW,
        log: () => {},
      },
      id,
    );
    // From the restore point the rollback would use: here, the run's snapshot.
    const since = String(db.prepare('SELECT since FROM rollback_counts').get()!.since);
    expect(words).toEqual([
      [
        'count',
        'one.test',
        id,
        new Date(Number(since))
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}Z$/, 'Z'),
      ],
    ]);
    expect(await view()).toMatchObject({
      state: 'done',
      counts: { orders: null, comments: 3, users: 1 },
      problem: null,
    });
  });

  it('says why a count failed', async () => {
    const { db, post } = app();
    site(db);
    run(db);
    const { id } = (await (
      await post('/api/sites/one.test/rollback/count', { batchId: 'batch1' }, false)
    ).json()) as { id: string };
    await runCount(
      {
        db,
        exec: async () => ({
          code: 1,
          stdout:
            '{"format":1,"ok":false,"step":"count","problem":"the orders couldn’t be counted","changed":"none"}\n',
          stderr: '',
        }),
        pushCommand: (_s, _h, w) => ['/usr/bin/ssh', ...w],
        now: () => NOW,
        log: () => {},
      },
      id,
    );
    expect(db.prepare('SELECT state, problem FROM rollback_counts').get()).toEqual({
      state: 'failed',
      problem: 'the orders couldn’t be counted',
    });
  });
});
