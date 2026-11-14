import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecheckAllResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { CareResult } from '../care/client.js';
import { loadCareKeys, newKeyPair } from '../care/keys.js';
import type { Db } from '../db.js';
import { testAuthenticator } from '../passkeys/testing.js';
import type { CareSend } from '../sites/setup.js';
import { testDb } from '../testing.js';

const LOGIN = 'tylercraft@github';
const ORIGIN = 'https://kamaji.test';
const T = Date.UTC(2026, 10, 15, 0, 0);
const REPORT: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/care-report.json', import.meta.url), 'utf8'),
);
const keys = loadCareKeys({
  KAMAJI_CARE_REPORT_KEY: newKeyPair().seed,
  KAMAJI_CARE_UPDATE_PUBLIC_KEY: newKeyPair().publicKey,
})!;

function site(
  db: Db,
  id: string,
  { mode = 'connected', setup = 'done', paused = false, removed = false } = {},
) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, paused_at, removed_at, created_at)
     VALUES (?, ?, ?, 'other', ?, ?, ?, ?, ?)`,
  ).run(id, `Site ${id}`, `https://${id}/`, mode, setup, paused ? T : null, removed ? T : null, T);
}

/** An app whose plugin answers per site: a report, a failure, or a throw. */
function setup(answer: (host: string) => Promise<CareResult>) {
  const db = testDb();
  const asked: string[] = [];
  const send: CareSend = async (home, _key, endpoint, body) => {
    asked.push(`${home.hostname} ${endpoint} refresh=${String(body.refresh)}`);
    return answer(home.hostname);
  };
  const app = createApp({
    db,
    login: LOGIN,
    webDist: mkdtempSync(join(tmpdir(), 'kamaji-web-')),
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: T,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
    care: {
      keys,
      pluginDir: new URL('../../../../plugin/craftish-care', import.meta.url).pathname,
      send,
    },
    passkeys: testAuthenticator().config,
    now: () => T,
  });
  // No Kamaji-Passkey header: Recheck all goes without one, as the page sends it.
  const recheck = (headers: Record<string, string> = {}) =>
    app.request('/api/sites/report', {
      method: 'POST',
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: '{}',
    });
  return { db, asked, recheck };
}

const report = async (): Promise<CareResult> => ({ ok: true, status: 200, data: REPORT });

describe('Recheck all', () => {
  it('asks every connected site, and only those, for a fresh report, without a passkey', async () => {
    const { db, asked, recheck } = setup(report);
    site(db, 'a.test');
    site(db, 'b.test');
    site(db, 'watched.test', { mode: 'monitoring' });
    site(db, 'paused.test', { paused: true });
    site(db, 'half-set-up.test', { setup: 'connect' });
    site(db, 'removed.test', { removed: true });
    const res = await recheck();
    expect(res.status).toBe(200);
    expect(RecheckAllResponse.parse(await res.json()).sites).toEqual([
      { id: 'a.test', name: 'Site a.test', ok: true, problem: null },
      { id: 'b.test', name: 'Site b.test', ok: true, problem: null },
    ]);
    expect(asked.sort()).toEqual(['a.test report refresh=true', 'b.test report refresh=true']);
  });

  it('keeps going when a site fails or the ask throws, and says why for each', async () => {
    const { db, recheck } = setup(async (host) => {
      if (host === 'down.test')
        return { ok: false, status: null, code: null, problem: 'Couldn’t reach the site' };
      if (host === 'broken.test') throw new Error('/secret/path exploded');
      return report();
    });
    for (const id of ['a.test', 'broken.test', 'down.test', 'z.test']) site(db, id);
    const { sites } = RecheckAllResponse.parse(await (await recheck()).json());
    expect(sites.map(({ id, ok, problem }) => ({ id, ok, problem }))).toEqual([
      { id: 'a.test', ok: true, problem: null },
      { id: 'broken.test', ok: false, problem: 'Kamaji couldn’t ask it' },
      { id: 'down.test', ok: false, problem: 'Couldn’t reach the site' },
      { id: 'z.test', ok: true, problem: null },
    ]);
  });

  it('asks at most three sites at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const { db, recheck } = setup(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return report();
    });
    for (let i = 0; i < 7; i++) site(db, `s${i}.test`);
    const { sites } = RecheckAllResponse.parse(await (await recheck()).json());
    expect(sites).toHaveLength(7);
    expect(most).toBe(3);
  });

  it('keeps the page’s Origin check: another site, or none, is refused', async () => {
    const { db, asked, recheck } = setup(report);
    site(db, 'a.test');
    expect((await recheck({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await recheck({ Origin: '' })).status).toBe(403);
    expect(asked).toEqual([]);
  });
});
