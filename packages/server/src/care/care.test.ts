import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { careRequest } from './client.js';
import { loadCareKeys, newKeyPair, privateKeyFromSeed, publicKeyBase64 } from './keys.js';
import { signedString, signRequest } from './sign.js';
import { keysFile, pluginZip } from './zip.js';

const report = newKeyPair();
const update = newKeyPair();
const keys = loadCareKeys({
  KAMAJI_CARE_REPORT_KEY: report.seed,
  KAMAJI_CARE_UPDATE_PUBLIC_KEY: update.publicKey,
})!;
const SITE = new URL('https://Example.test/');
const T = Date.UTC(2026, 10, 9, 0, 0, 0);

describe('keys', () => {
  it('loads the report key, and the update key’s public half without its private one', () => {
    expect(keys.report.id).toBe('r1');
    expect(publicKeyBase64(keys.report.privateKey)).toBe(report.publicKey);
    expect(keys.update).toBeUndefined();
    expect(keys.updatePublic).toEqual({ id: 'u1', publicKey: update.publicKey });
  });

  it('isn’t set up without a report key, or with one id for both', () => {
    expect(loadCareKeys({})).toBeUndefined();
    expect(
      loadCareKeys({
        KAMAJI_CARE_REPORT_KEY: report.seed,
        KAMAJI_CARE_UPDATE_KEY: update.seed,
        KAMAJI_CARE_UPDATE_KEY_ID: 'r1',
      }),
    ).toBeUndefined();
  });
});

describe('signing', () => {
  it('signs exactly the protocol’s string', () => {
    const headers = signRequest(keys.report, SITE, 'hello', '{}', {
      now: T,
      nonce: 'n'.repeat(22),
    });
    const message = signedString({
      method: 'POST',
      host: 'example.test',
      route: '/craftish-care/v1/hello',
      keyId: 'r1',
      time: T / 1000,
      nonce: 'n'.repeat(22),
      body: '{}',
    });
    expect(message).toBe(
      [
        'craftish-care-v1',
        'POST',
        'example.test',
        '/craftish-care/v1/hello',
        'r1',
        String(T / 1000),
        'n'.repeat(22),
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      ].join('\n'),
    );
    const publicKey = createPublicKey(privateKeyFromSeed(report.seed));
    const signature = Buffer.from(headers['X-Care-Signature']!, 'base64url');
    expect(signature).toHaveLength(64);
    expect(headers['X-Care-Signature']).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verify(null, Buffer.from(message), publicKey, signature)).toBe(true);
  });

  it('keeps a non-default port in the host', () => {
    const headers = signRequest(keys.report, new URL('https://example.test:8443'), 'hello', '{}');
    expect(headers['X-Care-Nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new URL('https://example.test:443').host).toBe('example.test');
    expect(new URL('https://example.test:8443').host).toBe('example.test:8443');
  });
});

describe('the zip', () => {
  it('holds the plugin and this site’s public keys, and nothing private', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamaji-zip-'));
    const pluginDir = new URL('../../../../plugin/craftish-care', import.meta.url).pathname;
    const path = join(dir, 'craftish-care.zip');
    writeFileSync(path, pluginZip(pluginDir, keys, 'example.test', new Date(T)));
    execFileSync('/usr/bin/unzip', ['-tq', path]);
    const list = execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8' });
    expect(list.split('\n')).toEqual(
      expect.arrayContaining([
        'craftish-care/craftish-care.php',
        'craftish-care/includes/Auth.php',
        'craftish-care/craftish-care-keys.php',
      ]),
    );
    const file = keysFile(keys, 'example.test', new Date(T));
    expect(file).toContain(`'${report.publicKey}'`);
    expect(file).toContain(`'${update.publicKey}'`);
    expect(file).not.toContain(report.seed);
  });
});

describe('the client', () => {
  const reply = (status: number, body: unknown, seen: string[]) =>
    (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;

  it('tries ?rest_route= when something else answers /wp-json/', async () => {
    const seen: string[] = [];
    const result = await careRequest(
      SITE,
      keys.report,
      'hello',
      {},
      {
        fetch: reply(404, '<html>nope</html>', seen),
      },
    );
    expect(seen).toEqual([
      'https://example.test/wp-json/craftish-care/v1/hello',
      'https://example.test/?rest_route=%2Fcraftish-care%2Fv1%2Fhello',
    ]);
    expect(result).toMatchObject({
      ok: false,
      problem: expect.stringContaining('isn’t answering'),
    });
  });

  it('takes the plugin’s own refusal as the answer, in plain words', async () => {
    const seen: string[] = [];
    const result = await careRequest(
      SITE,
      keys.report,
      'hello',
      {},
      {
        fetch: reply(401, { error: 'wrong_host' }, seen),
      },
    );
    expect(seen).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      status: 401,
      code: 'wrong_host',
      problem: 'The site’s address in WordPress doesn’t match this URL (HTTP 401)',
    });
  });

  it('never quotes what the site sent', async () => {
    const result = await careRequest(
      SITE,
      keys.report,
      'hello',
      {},
      {
        fetch: reply(500, { error: '<script>secret</script>' }, []),
      },
    );
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
