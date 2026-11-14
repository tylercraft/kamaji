// A software authenticator, for tests only: it makes passkey assertions the way a phone or a
// laptop does, so the app's guard and the updater's check run against real signatures. Nothing in
// Kamaji accepts it unless a test hands its passkey over in a PasskeyConfig.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { PasskeyChallenge } from '@kamaji/shared';
import type { PasskeyConfig } from './guard.js';
import { bodyHash, type Passkey, type Proof } from './webauthn.js';

export const TEST_RP = { rpId: 'kamaji.test', origin: 'https://kamaji.test' };

interface Fetches {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}

/** What to get wrong on purpose, for the refusals. */
export interface Twist {
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  counter?: number;
  challenge?: string;
}

export function testAuthenticator(alg: -7 | -8 | -257 = -7, label = 'Test passkey') {
  const pair =
    alg === -7
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : alg === -8
        ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey: KeyObject = pair.privateKey;
  const passkey: Passkey = {
    id: randomBytes(16).toString('base64url'),
    alg,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    label,
  };
  const config: PasskeyConfig = { load: () => ({ ok: true, passkeys: [passkey] }), ...TEST_RP };

  /** An assertion over `challenge` (base64url), with the nonce it was made from. */
  function assert(nonce: string, challenge: string, twist: Twist = {}): Proof {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: twist.type ?? 'webauthn.get',
        challenge: twist.challenge ?? challenge,
        origin: twist.origin ?? TEST_RP.origin,
        crossOrigin: false,
      }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(twist.counter ?? 0);
    const authenticatorData = Buffer.concat([
      createHash('sha256')
        .update(twist.rpId ?? TEST_RP.rpId)
        .digest(),
      Buffer.from([twist.flags ?? 0x05]),
      counter,
    ]);
    const signed = Buffer.concat([
      authenticatorData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const signature =
      alg === -8 ? sign(null, signed, privateKey) : sign('sha256', signed, privateKey);
    return {
      nonce,
      id: passkey.id,
      authenticatorData: authenticatorData.toString('base64url'),
      clientDataJSON: clientDataJSON.toString('base64url'),
      signature: signature.toString('base64url'),
    };
  }

  const header = (proof: Proof) => Buffer.from(JSON.stringify(proof)).toString('base64url');

  /**
   * A POST the way the page makes one: ask Kamaji for a nonce for this exact write, sign it, and
   * send the write with the proof. `headers` are the page's own (login, Origin, Content-Type).
   */
  async function post(
    app: Fetches,
    path: string,
    body: string,
    headers: Record<string, string>,
    twist: Twist = {},
  ): Promise<Response> {
    const res = await app.request('/api/passkeys/challenge', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'POST', path, bodySha256: bodyHash(body) }),
    });
    // No nonce (a foreign page, say): the write goes without a proof, as the page's would.
    if (!res.ok) return app.request(path, { method: 'POST', headers, body });
    const c = PasskeyChallenge.parse(await res.json());
    return app.request(path, {
      method: 'POST',
      headers: { ...headers, 'Kamaji-Passkey': header(assert(c.nonce, c.challenge, twist)) },
      body,
    });
  }

  return { passkey, config, assert, header, post };
}
