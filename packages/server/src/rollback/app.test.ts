import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteRollbackResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { testDb } from '../testing.js';
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
  return { db, a, headers, view, post, started: () => started };
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
});
