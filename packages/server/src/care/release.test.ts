import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadCareKeys, newKeyPair, privateKeyFromSeed } from './keys.js';
import { buildRelease, pluginVersion, releaseMessage } from './release.js';
import { keysFile } from './zip.js';

const PLUGIN = new URL('../../../../plugin/craftish-care', import.meta.url).pathname;
const CHANNEL = 'https://care.craftish.dev/craftish-care/';

describe('a release for the signed channel', () => {
  const key = newKeyPair();
  const release = buildRelease(PLUGIN, { id: 'p1', seed: key.seed }, CHANNEL, new Date());

  it('signs the version and the zip’s SHA-256 with the release key', () => {
    const sha256 = createHash('sha256').update(release.zip).digest('hex');
    expect(release.info).toMatchObject({
      version: pluginVersion(PLUGIN),
      package: `${CHANNEL}craftish-care-${pluginVersion(PLUGIN)}.zip`,
      sha256,
      key: 'p1',
    });
    const publicKey = createPublicKey(privateKeyFromSeed(key.seed));
    const message = Buffer.from(releaseMessage(release.info.version, sha256));
    expect(verify(null, message, publicKey, Buffer.from(release.info.signature, 'base64'))).toBe(
      true,
    );
  });

  it('carries no site’s keys file', () => {
    expect(release.zip.includes(Buffer.from('craftish-care-keys.php'))).toBe(false);
    expect(release.zip.includes(Buffer.from('craftish-care/craftish-care.php'))).toBe(true);
  });

  it('only for an https channel', () => {
    expect(() =>
      buildRelease(PLUGIN, { id: 'p1', seed: key.seed }, 'http://x.test/', new Date()),
    ).toThrow();
  });
});

describe('the keys file', () => {
  const report = newKeyPair();
  const update = newKeyPair();
  const release = newKeyPair();

  it('carries the release key’s public half when Kamaji has it, under its own id', () => {
    const keys = loadCareKeys({
      KAMAJI_CARE_REPORT_KEY: report.seed,
      KAMAJI_CARE_UPDATE_PUBLIC_KEY: update.publicKey,
      KAMAJI_CARE_RELEASE_PUBLIC_KEY: release.publicKey,
    })!;
    const file = keysFile(keys, 'example.test', new Date());
    expect(file).toContain(`define( 'CRAFTISH_CARE_RELEASE_KEY_ID', 'p1' );`);
    expect(file).toContain(`define( 'CRAFTISH_CARE_RELEASE_KEY', '${release.publicKey}' );`);
    expect(file).not.toContain(release.seed);
  });

  it('leaves it out without one, or when its id clashes with a request key', () => {
    const base = {
      KAMAJI_CARE_REPORT_KEY: report.seed,
      KAMAJI_CARE_UPDATE_PUBLIC_KEY: update.publicKey,
    };
    expect(loadCareKeys(base)!.releasePublic).toBeUndefined();
    expect(
      loadCareKeys({
        ...base,
        KAMAJI_CARE_RELEASE_PUBLIC_KEY: release.publicKey,
        KAMAJI_CARE_RELEASE_KEY_ID: 'u1',
      })!.releasePublic,
    ).toBeUndefined();
  });
});
