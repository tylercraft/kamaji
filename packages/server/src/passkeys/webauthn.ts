// Passkey assertions (WebAuthn, TY-170): the proof that Tyler, at that moment, on his phone or
// laptop, agreed to one exact write. Nothing on the mini can make one: the private key never
// leaves his device, and Touch ID or Face ID has to say yes.
//
// The challenge commits to the write itself: a single-use nonce, the method and path, and the
// SHA-256 of the exact body. So an assertion for one approval can't be spent on another.
// Verification follows WebAuthn level 2, section 7.2, for the parts that matter here: the
// client data's type, challenge and origin; the authenticator data's RP ID hash and its user
// present and user verified flags; and the signature over authenticatorData ‖ SHA-256(clientDataJSON).
import { createHash, createPublicKey, verify } from 'node:crypto';

/** A passkey Kamaji accepts: one line of the passkeys file (store.ts). */
export interface Passkey {
  /** The credential id, base64url. */
  id: string;
  /** COSE algorithm: -7 ES256, -8 EdDSA, -257 RS256. */
  alg: number;
  /** The public key as SubjectPublicKeyInfo DER, base64url (what PublicKeyCredential.getPublicKey() gives). */
  publicKey: string;
  label: string;
}

/** What the page sends with a write, in the Kamaji-Passkey header (base64url JSON). */
export interface Proof {
  nonce: string;
  id: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export const ALGORITHMS = [-8, -7, -257] as const;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();

export const bodyHash = (body: string) => sha256(body).toString('hex');

/** The challenge for one write: what the passkey signs. */
export function challengeFor(nonce: string, method: string, path: string, bodySha256: string) {
  return sha256(
    `kamaji-write-v1\n${nonce}\n${method.toUpperCase()} ${path}\n${bodySha256}`,
  ).toString('base64url');
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** The header's proof, or null when it isn't one. */
export function readProof(header: string | undefined): Proof | null {
  if (!header || header.length > 8192 || !B64URL.test(header)) return null;
  try {
    const p = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const fields = ['nonce', 'id', 'authenticatorData', 'clientDataJSON', 'signature'] as const;
    if (!fields.every((f) => typeof p[f] === 'string' && B64URL.test(p[f]))) return null;
    return Object.fromEntries(fields.map((f) => [f, p[f]])) as unknown as Proof;
  } catch {
    return null;
  }
}

export type Verdict =
  { ok: true; passkey: Passkey; signCount: number } | { ok: false; problem: string };

/**
 * Checks a proof against the passkeys Kamaji accepts, for the challenge this write expects.
 * `rpId` is the host the passkeys belong to; `origin` the page's exact origin.
 */
export function verifyProof(
  proof: Proof,
  passkeys: Passkey[],
  expected: { challenge: string; rpId: string; origin: string },
): Verdict {
  const passkey = passkeys.find((p) => p.id === proof.id);
  if (!passkey) return { ok: false, problem: 'not a passkey Kamaji accepts' };

  const clientDataJSON = Buffer.from(proof.clientDataJSON, 'base64url');
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    client = JSON.parse(clientDataJSON.toString('utf8')) as typeof client;
  } catch {
    return { ok: false, problem: 'unreadable client data' };
  }
  if (client.type !== 'webauthn.get') return { ok: false, problem: 'not an assertion' };
  if (client.challenge !== expected.challenge)
    return { ok: false, problem: 'signed for a different write' };
  if (client.origin !== expected.origin) return { ok: false, problem: 'signed on another page' };
  if (client.crossOrigin === true) return { ok: false, problem: 'signed inside another page' };

  const auth = Buffer.from(proof.authenticatorData, 'base64url');
  if (auth.length < 37) return { ok: false, problem: 'unreadable authenticator data' };
  if (!auth.subarray(0, 32).equals(sha256(expected.rpId)))
    return { ok: false, problem: 'a passkey for another site' };
  const flags = auth[32]!;
  if (!(flags & 0x01)) return { ok: false, problem: 'no one was present' };
  if (!(flags & 0x04))
    return { ok: false, problem: 'not verified with Touch ID, Face ID or a PIN' };

  const signed = Buffer.concat([auth, sha256(clientDataJSON)]);
  const signature = Buffer.from(proof.signature, 'base64url');
  let good = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(passkey.publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    if (passkey.alg === -7) good = verify('sha256', signed, { key, dsaEncoding: 'der' }, signature);
    else if (passkey.alg === -8) good = verify(null, signed, key, signature);
    else if (passkey.alg === -257) good = verify('sha256', signed, key, signature);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, problem: 'the signature doesn’t check out' };
  return { ok: true, passkey, signCount: auth.readUInt32BE(33) };
}
