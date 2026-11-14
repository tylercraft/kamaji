// Passkeys on writes (TY-170). A local process can fake every header Kamaji's page sends, so the
// only thing it can't fake is an assertion from Tyler's passkey for that exact write. These run
// the real verification against a software authenticator (testing.ts).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasskeysResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import { testDb } from '../testing.js';
import { approvalProblem, issueNonce, NONCE_MS, type PasskeyConfig } from './guard.js';
import { loadPasskeys, parsePasskeys } from './store.js';
import { testAuthenticator, TEST_RP, type Twist } from './testing.js';
import { bodyHash, challengeFor } from './webauthn.js';

const LOGIN = 'tylercraft@github';
const T = Date.UTC(2026, 10, 14, 9, 0);
/** Everything Kamaji's page sends, which anything on the mini can send too. */
const PAGE = {
  'Tailscale-User-Login': LOGIN,
  Host: 'kamaji.test',
  Origin: 'https://kamaji.test',
  'Content-Type': 'application/json',
};

function setup(config?: PasskeyConfig) {
  const db = testDb();
  const tyler = testAuthenticator();
  let at = T;
  const logged: string[] = [];
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
  const app = createApp({
    db,
    login: LOGIN,
    webDist,
    passkeys: config ?? tyler.config,
    now: () => at,
    log: (m) => logged.push(m),
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: at,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
  });
  const raw = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...PAGE, ...headers }, body });
  const count = (table: string) =>
    Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return { db, app, tyler, raw, count, logged, later: (ms: number) => (at += ms) };
}

const APPROVE = JSON.stringify({
  items: [
    { siteId: 'a.test', type: 'plugin', item: 'akismet/akismet.php', from: '5.3', to: '5.7.2' },
  ],
  confirmedBackups: [],
  oneSiteFirst: false,
});

describe('a write from the mini with every header faked', () => {
  it('is refused without a passkey, and nothing is stored', async () => {
    const { raw, count } = setup();
    const res = await raw('/api/batches', APPROVE);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'passkey_required' });
    expect(count('batches')).toBe(0);
  });

  it('is refused with a passkey Kamaji doesn’t accept, even one signed properly for it', async () => {
    const { app, count } = setup();
    const stranger = testAuthenticator();
    expect((await stranger.post(app, '/api/batches', APPROVE, PAGE)).status).toBe(403);
    expect(count('batches')).toBe(0);
  });

  it('gets through with Tyler’s passkey, to the approval’s own checks', async () => {
    const { app, tyler } = setup();
    // No care keys in this app, so the approval itself answers "not set up": past the passkey.
    const res = await tyler.post(app, '/api/batches', APPROVE, PAGE);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_set_up' });
  });

  it('is refused on every write that starts or changes work on a site, and any new one', async () => {
    const { raw } = setup();
    for (const path of [
      '/api/batches',
      '/api/batches/b1/sites/a.test/carry-on',
      '/api/batches/b1/sites/a.test/recheck',
      '/api/sites/a.test/backups',
      '/api/sites/a.test/backups/whole-site',
      '/api/sites/a.test/configure',
      '/api/sites/a.test/remove',
      '/api/something-added-later',
    ])
      expect([path, (await raw(path, '{}')).status]).toEqual([path, 401]);
  });

  it('needs none to propose, ask for a nonce, add a site, or ask a site read-only questions', async () => {
    const { raw } = setup();
    for (const path of [
      '/api/proposals',
      '/api/passkeys/challenge',
      '/api/sites',
      '/api/sites/a.test/mode',
      '/api/sites/a.test/handshake',
      '/api/sites/a.test/report',
    ])
      expect([path, (await raw(path, '{}')).status]).not.toEqual([path, 401]);
  });
});

describe('a passkey proof', () => {
  const refused = async (twist: Twist) => {
    const { app, tyler } = setup();
    const res = await tyler.post(app, '/api/sites/a.test/remove', '{}', PAGE, twist);
    return { status: res.status };
  };

  it('is refused from another page, for another site, as a registration, or without Touch ID', async () => {
    for (const twist of [
      { origin: 'https://evil.example' },
      { origin: 'http://kamaji.test' },
      { rpId: 'evil.example' },
      { type: 'webauthn.create' },
      { flags: 0x01 },
      { flags: 0x04 },
    ])
      expect([twist, (await refused(twist)).status]).toEqual([twist, 403]);
  });

  it('is for exactly one write: another body, path or a second use is refused', async () => {
    const { app, tyler, raw, db } = setup();
    const nonce = issueNonce(db, T);
    const forRemove = tyler.header(
      tyler.assert(nonce, challengeFor(nonce, 'POST', '/api/sites/a.test/remove', bodyHash('{}'))),
    );
    // The same proof on another site's remove, on an approval, or with another body.
    expect(
      (await raw('/api/sites/b.test/remove', '{}', { 'Kamaji-Passkey': forRemove })).status,
    ).toBe(403);
    expect((await raw('/api/batches', '{}', { 'Kamaji-Passkey': forRemove })).status).toBe(403);
    expect(
      (await raw('/api/sites/a.test/remove', '{"x":1}', { 'Kamaji-Passkey': forRemove })).status,
    ).toBe(403);
    // Its own write takes it once (400 from remove itself: past the passkey); a replay doesn't.
    expect(
      (await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': forRemove })).status,
    ).not.toBe(403);
    expect(
      (await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': forRemove })).status,
    ).toBe(403);
    void app;
  });

  it('is refused once its nonce is three minutes old, or one Kamaji never issued', async () => {
    const { tyler, raw, db, later } = setup();
    const nonce = issueNonce(db, T);
    const proof = (n: string) =>
      tyler.header(
        tyler.assert(n, challengeFor(n, 'POST', '/api/sites/a.test/remove', bodyHash('{}'))),
      );
    later(NONCE_MS + 1);
    expect(
      (await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': proof(nonce) })).status,
    ).toBe(403);
    expect(
      (await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': proof('made-up') })).status,
    ).toBe(403);
  });

  it('is refused when the signature or the header has been tampered with', async () => {
    const { tyler, raw, db } = setup();
    const nonce = issueNonce(db, T);
    const p = tyler.assert(
      nonce,
      challengeFor(nonce, 'POST', '/api/sites/a.test/remove', bodyHash('{}')),
    );
    const flipped = Buffer.from(p.signature, 'base64url');
    flipped[flipped.length - 1]! ^= 1;
    const bad = tyler.header({ ...p, signature: flipped.toString('base64url') });
    expect((await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': bad })).status).toBe(
      403,
    );
    expect(
      (await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': 'not base64!' })).status,
    ).toBe(403);
  });

  it('is refused when an authenticator’s counter goes backwards (a cloned key)', async () => {
    const { app, tyler } = setup();
    expect(
      (await tyler.post(app, '/api/sites/a.test/remove', '{}', PAGE, { counter: 5 })).status,
    ).toBe(400);
    expect(
      (await tyler.post(app, '/api/sites/a.test/remove', '{}', PAGE, { counter: 5 })).status,
    ).toBe(403);
    expect(
      (await tyler.post(app, '/api/sites/a.test/remove', '{}', PAGE, { counter: 6 })).status,
    ).toBe(400);
  });

  it('works from Ed25519, P-256 and RSA passkeys', async () => {
    for (const alg of [-7, -8, -257] as const) {
      const key = testAuthenticator(alg);
      const { app } = setup(key.config);
      expect([alg, (await key.post(app, '/api/sites/a.test/remove', '{}', PAGE)).status]).toEqual([
        alg,
        400,
      ]);
    }
  });

  it('can’t be checked without the passkeys file: writes wait, and say why', async () => {
    const { raw, app, tyler } = setup({
      load: () => ({ ok: false, problem: 'no passkeys file' }),
      ...TEST_RP,
    });
    const res = await raw('/api/sites/a.test/remove', '{}', { 'Kamaji-Passkey': 'e30' });
    expect(res.status).toBe(503);
    const page = PasskeysResponse.parse(
      await (await app.request('/api/passkeys', { headers: PAGE })).json(),
    );
    expect(page).toMatchObject({ installed: [], problem: 'no passkeys file', rpId: 'kamaji.test' });
    void tyler;
  });
});

describe('the passkeys file', () => {
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'kamaji-passkeys-')), 'passkeys');
    writeFileSync(path, text);
    return path;
  };
  const line = JSON.stringify({ id: 'abc', alg: -7, publicKey: 'MFkw', label: 'Tyler’s iPhone' });

  it('takes one JSON line per passkey, skipping comments, broken lines and unknown algorithms', () => {
    expect(
      parsePasskeys(
        `# Tyler's passkeys\n${line}\n{broken\n${JSON.stringify({ id: 'x', alg: -999, publicKey: 'y' })}\n`,
      ),
    ).toEqual([{ id: 'abc', alg: -7, publicKey: 'MFkw', label: 'Tyler’s iPhone' }]);
  });

  it('is refused when this user could change it, since an agent runs as this user too', () => {
    const path = file(`${line}\n`);
    expect(loadPasskeys(path)).toEqual({
      ok: false,
      problem: `${path} must be root's, and writable by root only`,
    });
    expect(loadPasskeys(path, { trustOwner: true })).toMatchObject({ ok: true });
  });

  it('says when there is no file, or nothing in it', () => {
    expect(loadPasskeys('/nonexistent/passkeys')).toEqual({
      ok: false,
      problem: 'no passkeys file at /nonexistent/passkeys',
    });
    const empty = file('# none yet\n');
    expect(loadPasskeys(empty, { trustOwner: true })).toEqual({
      ok: false,
      problem: `no passkeys in ${empty}`,
    });
  });
});

describe('an approved batch, as the updater checks it', () => {
  /** A batch as approveBatch stores it, with `approval` as given. */
  function store(db: Db, approval: string | null, item = '5.7.2') {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at) VALUES ('a.test', 'A', 'https://a.test/', 'craftish', 'connected', 'done', ?) ON CONFLICT DO NOTHING",
    ).run(T);
    db.prepare(
      "INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, approval) VALUES (?, ?, 'x', 0, 'approved', ?)",
    ).run(id, T, approval);
    db.prepare(
      "INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, state) VALUES (?, 'a.test', 0, 'kamaji', 'waiting')",
    ).run(id);
    db.prepare(
      "INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version, to_version, state) VALUES (?, ?, 'a.test', 0, 'plugin', 'akismet/akismet.php', 'Akismet', '5.3', ?, 'waiting')",
    ).run(randomUUID(), id, item);
    return id;
  }
  const signed = (tyler: ReturnType<typeof testAuthenticator>, body = APPROVE) => {
    const nonce = randomUUID();
    return JSON.stringify({
      body,
      proof: tyler.assert(nonce, challengeFor(nonce, 'POST', '/api/batches', bodyHash(body))),
    });
  };

  it('holds when its proof checks out and the run is what was approved', () => {
    const db = testDb();
    const tyler = testAuthenticator();
    expect(approvalProblem(db, tyler.config, store(db, signed(tyler)))).toBeNull();
  });

  it('doesn’t hold for a batch written straight into the database', () => {
    const db = testDb();
    const tyler = testAuthenticator();
    expect(approvalProblem(db, tyler.config, store(db, null))).toBe('no passkey approval');
    expect(approvalProblem(db, tyler.config, store(db, signed(testAuthenticator())))).toBe(
      'the approval’s passkey: not a passkey Kamaji accepts',
    );
  });

  it('doesn’t hold when the run was changed after approval, or the approval reused', () => {
    const db = testDb();
    const tyler = testAuthenticator();
    expect(approvalProblem(db, tyler.config, store(db, signed(tyler), '9.9.9'))).toBe(
      'the run isn’t what was approved',
    );
    const approval = signed(tyler);
    const first = store(db, approval);
    store(db, approval);
    expect(approvalProblem(db, tyler.config, first)).toBe('an approval used for more than one run');
  });

  it('doesn’t hold once its passkey is taken out of the file', () => {
    const db = testDb();
    const tyler = testAuthenticator();
    const id = store(db, signed(tyler));
    const removed: PasskeyConfig = { ...tyler.config, load: () => ({ ok: true, passkeys: [] }) };
    expect(approvalProblem(db, removed, id)).toBe(
      'the approval’s passkey: not a passkey Kamaji accepts',
    );
  });
});
