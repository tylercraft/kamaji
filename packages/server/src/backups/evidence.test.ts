import { SiteBackupsResponse } from '@kamaji/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import { testDb } from '../testing.js';
import type { BackupResult } from '../updater/run.js';
import { backupHistory, recordEvidence } from './evidence.js';

const LOGIN = 'tylercraft@github';
const T = Date.UTC(2026, 10, 12, 1, 0);
const HASH = 'a'.repeat(64);

function site(db: Db, id: string, hostKind = 'craftish', backup: string | null = 'kamaji') {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, created_at)
     VALUES (?, ?, ?, ?, 'connected', 'done', ?, 0)`,
  ).run(id, id, `https://${id}/`, hostKind, backup);
}

function run(db: Db, batchId: string, siteId: string, at: number, backup: string | null) {
  db.prepare(
    `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state)
     VALUES (?, ?, 'tyler', 0, 'finished')`,
  ).run(batchId, at);
  db.prepare(
    `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state, started_at)
     VALUES (?, ?, 0, 'kamaji', ?, 'done', ?)`,
  ).run(batchId, siteId, backup, at);
}

describe('a site’s backup history', () => {
  it('lists exports and runs’ recorded words, newest first, each run once', () => {
    const db = testDb();
    site(db, 'one.test');
    run(
      db,
      'old',
      'one.test',
      T - 3_000,
      'Kamaji exported the database on craftish at … (words only)',
    );
    run(db, 'new', 'one.test', T - 1_000, 'Kamaji exported the database on craftish at …');
    recordEvidence(db, {
      siteId: 'one.test',
      batchId: 'new',
      requestedBy: null,
      at: T - 1_000,
      ok: true,
      words: 'exported',
      answer: { at: '20261112T005959Z', bytes: 1234, sha256: HASH },
    });
    recordEvidence(db, {
      siteId: 'one.test',
      batchId: null,
      requestedBy: LOGIN,
      at: T,
      ok: false,
      words: 'The export on craftish failed: not on the list',
    });
    expect(
      backupHistory(db, 'one.test').map((e) => [e.state, e.batchId, e.bytes, e.exportedAt]),
    ).toEqual([
      ['failed', null, null, null],
      ['exported', 'new', 1234, '2026-11-12T00:59:59.000Z'],
      ['recorded', 'old', null, null],
    ]);
  });

  it('keeps a time it can’t read in the words, without breaking the rest', () => {
    const db = testDb();
    site(db, 'one.test');
    for (const [at, when] of [
      ['not a time', T - 1_000],
      ['20261113T004147Z', T],
    ] as const)
      recordEvidence(db, {
        siteId: 'one.test',
        batchId: null,
        requestedBy: LOGIN,
        at: when,
        ok: true,
        words: 'exported',
        answer: { at, bytes: 1, sha256: HASH },
      });
    expect(backupHistory(db, 'one.test').map((e) => [e.exportedAt, e.words])).toEqual([
      ['2026-11-13T00:41:47.000Z', 'exported'],
      [null, 'exported (the export gave its time as “not a time”)'],
    ]);
  });
});

function app(backup?: (site: { id: string }) => Promise<BackupResult>) {
  const db = testDb();
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
  const a = createApp({
    db,
    login: LOGIN,
    webDist,
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: T,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
    ...(backup ? { backup } : {}),
    now: () => T,
  });
  const headers = { 'Tailscale-User-Login': LOGIN, Host: 'kamaji.test' };
  const get = async (id: string) =>
    SiteBackupsResponse.parse(
      await (await a.request(`/api/sites/${id}/backups`, { headers })).json(),
    );
  const post = (id: string) =>
    a.request(`/api/sites/${id}/backups`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://kamaji.test', 'Content-Type': 'application/json' },
      body: '{}',
    });
  return { db, get, post };
}

describe('Back up now', () => {
  it('runs the export in the background, one at a time, and records what it answered', async () => {
    let finish: (r: BackupResult) => void = () => {};
    const asked: string[] = [];
    const { db, get, post } = app((s) => {
      asked.push(s.id);
      return new Promise((resolve) => (finish = resolve));
    });
    site(db, 'one.test');
    expect((await post('one.test')).status).toBe(202);
    expect((await get('one.test')).exporting).toBe(new Date(T).toISOString());
    expect((await post('one.test')).status).toBe(409);
    finish({
      ok: true,
      words: 'Kamaji exported the database on craftish',
      answer: { at: '20261112T010000Z', bytes: 99, sha256: HASH },
    });
    await new Promise((r) => setImmediate(r));
    const after = await get('one.test');
    expect(after.exporting).toBeNull();
    expect(after.latest).toMatchObject({
      state: 'exported',
      exportedAt: '2026-11-12T01:00:00.000Z',
      batchId: null,
      bytes: 99,
      sha256: HASH,
    });
    expect(asked).toEqual(['one.test']);
    expect(db.prepare('SELECT requested_by FROM backup_evidence').get()?.requested_by).toBe(LOGIN);
  });

  it('is only for sites on craftish, with the export set up, and not mid-update', async () => {
    const { db, post } = app(async () => ({ ok: true, words: 'x' }));
    site(db, 'kinsta.test', 'kinsta', 'host');
    expect((await post('kinsta.test')).status).toBe(400);
    site(db, 'one.test');
    run(db, 'b1', 'one.test', T, null);
    db.prepare("UPDATE batch_sites SET state = 'running'").run();
    expect(await (await post('one.test')).json()).toEqual({ error: 'updating' });
    expect((await app().post('nowhere.test')).status).toBe(404);
  });

  it('says it isn’t set up without the export', async () => {
    const { db, post } = app();
    site(db, 'one.test');
    expect(await (await post('one.test')).json()).toEqual({ error: 'not_set_up' });
  });
});
