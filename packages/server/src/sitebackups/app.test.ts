import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { SiteBackupsResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { testAuthenticator } from '../passkeys/testing.js';
import type { FetchExport } from '../backups/download.js';
import { recordEvidence } from '../backups/evidence.js';
import type { Db } from '../db.js';
import { testDb } from '../testing.js';

const LOGIN = 'tylercraft@github';
const T = Date.UTC(2026, 10, 13, 1, 0);
const DUMP = gzipSync(Buffer.from('-- MySQL dump\n'.repeat(1000)));
const HASH = createHash('sha256').update(DUMP).digest('hex');

function site(db: Db, id: string, host = 'craftish', schedule = 'weekly') {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule, created_at)
     VALUES (?, ?, ?, ?, 'connected', 'done', 1, ?, 0)`,
  ).run(id, id, `https://${id}/`, host, schedule);
}

function app(fetchExport?: FetchExport) {
  const db = testDb();
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
  let started = 0;
  const logged: string[] = [];
  const passkey = testAuthenticator();
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
    ...(fetchExport ? { fetchExport } : {}),
    startBackups: () => void started++,
    log: (m) => logged.push(m),
    passkeys: passkey.config,
    now: () => T,
  });
  const headers = { 'Tailscale-User-Login': LOGIN, Host: 'kamaji.test' };
  const get = (path: string) => a.request(path, { headers });
  const backups = async (id: string) =>
    SiteBackupsResponse.parse(await (await get(`/api/sites/${id}/backups`)).json());
  const ask = (id: string, kind: string) =>
    passkey.post(a, `/api/sites/${id}/backups/whole-site`, JSON.stringify({ kind }), {
      ...headers,
      Origin: 'https://kamaji.test',
      'Content-Type': 'application/json',
    });
  return { db, get, backups, ask, started: () => started, logged };
}

const exported = (db: Db, siteId: string, at: string) =>
  recordEvidence(db, {
    siteId,
    batchId: null,
    requestedBy: LOGIN,
    at: T - 1000,
    ok: true,
    words: 'exported',
    answer: { at, bytes: DUMP.length, sha256: HASH },
  });

const streamOf = (data: Buffer, code = 0) => ({
  stdout: Readable.from([data.subarray(0, 10), data.subarray(10)]),
  exit: Promise.resolve(code),
  stop: () => {},
});

describe('whole-site backups in a site’s Backups', () => {
  it('shows them only on craftish sites, and the latest export to download', async () => {
    const { db, backups } = app();
    site(db, 'one.test');
    site(db, 'kinsta.test', 'kinsta', 'off');
    expect((await backups('kinsta.test')).wholeSite).toBeNull();
    const one = await backups('one.test');
    expect(one.wholeSite).toMatchObject({ schedule: 'weekly', own: true, active: true });
    expect(one.download).toBeNull();
    exported(db, 'one.test', '20261113T004147Z');
    expect((await backups('one.test')).download).toEqual({
      exportedAt: '2026-11-13T00:41:47.000Z',
    });
  });

  it('queues a request and wakes the process, once, and only when they’re switched on', async () => {
    const { db, ask, backups, started } = app();
    site(db, 'one.test');
    site(db, 'off.test', 'craftish', 'off');
    expect((await ask('off.test', 'backup')).status).toBe(409);
    expect((await ask('one.test', 'backup')).status).toBe(202);
    expect((await ask('one.test', 'backup')).status).toBe(409);
    expect((await ask('one.test', 'restore')).status).toBe(202);
    expect(started()).toBe(2);
    expect((await backups('one.test')).wholeSite?.pending).toEqual({
      backup: new Date(T).toISOString(),
      restore: new Date(T).toISOString(),
    });
    // Answered once the process records a result after the request.
    db.prepare(
      `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id)
       VALUES ('one.test', ?, ?, 1, ?)`,
    ).run(T, T + 1, 'a'.repeat(64));
    expect((await backups('one.test')).wholeSite).toMatchObject({
      pending: { backup: null },
      lastGoodAt: new Date(T).toISOString(),
      nextDueAt: new Date(T + 6.5 * 24 * 60 * 60_000).toISOString(),
    });
  });
});

describe('Download latest export', () => {
  it('streams the export from craftish, named for it, and checks its hash', async () => {
    const asked: string[] = [];
    const { db, get, logged } = app((id, at) => {
      asked.push(`${id} ${at}`);
      return streamOf(DUMP);
    });
    site(db, 'one.test');
    exported(db, 'one.test', '20261113T004147Z');
    const response = await get('/api/sites/one.test/backups/download');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="one.test-20261113T004147Z.sql.gz"',
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(DUMP)).toBe(true);
    expect(asked).toEqual(['one.test 20261113T004147Z']);
    expect(logged).toContain('download: one.test sent');
  });

  it('says why when craftish has pruned it, and 404s with no export at all', async () => {
    const { db, get } = app(() =>
      streamOf(
        Buffer.from(
          '{"format":1,"ok":false,"problem":"that export is gone: craftish keeps them 14 days"}\n',
        ),
        3,
      ),
    );
    site(db, 'one.test');
    expect((await get('/api/sites/one.test/backups/download')).status).toBe(404);
    exported(db, 'one.test', '20261113T004147Z');
    const gone = await get('/api/sites/one.test/backups/download');
    expect(gone.status).toBe(502);
    expect(await gone.json()).toEqual({
      error: 'export_unavailable',
      problem: 'that export is gone: craftish keeps them 14 days',
    });
  });
});
