// Kamaji's two Ed25519 keys for craftish-care (docs/protocol.md, "Keys"). Private keys arrive as
// environment variables, each the base64 of its 32-byte seed. The checker holds only the report
// key; the update key's public half is enough to build a site's zip. The update private key is
// only ever set on the laptop (until M4's updater): it signs disconnect.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

// PKCS#8 wrapping for a raw Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_ID = /^[a-z][0-9]{1,3}$/;

export interface SigningKey {
  id: string;
  privateKey: KeyObject;
}

export interface CareKeys {
  report: SigningKey;
  /** The update key's public half, base64: always known, for the zip. */
  updatePublic: { id: string; publicKey: string };
  /** Only where disconnect may be signed: the laptop now, the updater from M4. */
  update: SigningKey | undefined;
}

export function privateKeyFromSeed(seedBase64: string): KeyObject {
  const seed = Buffer.from(seedBase64, 'base64');
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The raw 32-byte public key, base64, as the plugin's keys file holds it. */
export function publicKeyBase64(key: KeyObject): string {
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

/** A new key pair as the two values an environment file holds. */
export function newKeyPair(): { seed: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    seed: pkcs8.subarray(pkcs8.length - 32).toString('base64'),
    publicKey: publicKeyBase64(privateKey),
  };
}

/** The keys from the environment, or undefined when connecting sites isn't set up here. */
export function loadCareKeys(env: NodeJS.ProcessEnv): CareKeys | undefined {
  const reportId = env.KAMAJI_CARE_REPORT_KEY_ID ?? 'r1';
  const updateId = env.KAMAJI_CARE_UPDATE_KEY_ID ?? 'u1';
  const reportSeed = env.KAMAJI_CARE_REPORT_KEY;
  if (!reportSeed || !KEY_ID.test(reportId) || !KEY_ID.test(updateId) || reportId === updateId) {
    return undefined;
  }
  const report = { id: reportId, privateKey: privateKeyFromSeed(reportSeed) };
  const updateSeed = env.KAMAJI_CARE_UPDATE_KEY;
  const update = updateSeed
    ? { id: updateId, privateKey: privateKeyFromSeed(updateSeed) }
    : undefined;
  const updatePublicKey = update
    ? publicKeyBase64(update.privateKey)
    : env.KAMAJI_CARE_UPDATE_PUBLIC_KEY;
  if (!updatePublicKey || Buffer.from(updatePublicKey, 'base64').length !== 32) return undefined;
  return { report, update, updatePublic: { id: updateId, publicKey: updatePublicKey } };
}
