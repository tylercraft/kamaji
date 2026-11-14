// Passkeys in the browser (TY-170). A write that starts or changes work on a site is signed with
// Tyler's passkey: Kamaji hands out a nonce for that exact write (method, path, body), Touch ID or
// Face ID signs it, and the proof goes with the write in the Kamaji-Passkey header. Creating a
// passkey only makes the line Tyler installs on the mini with sudo; Kamaji never stores one itself.
import { PasskeyChallenge } from '@kamaji/shared';

const toB64url = (bytes: ArrayBuffer | Uint8Array) => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (text: string) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export type SignResult =
  | { ok: true; header: string }
  | { ok: false; error: 'passkey_cancelled' | 'passkeys_unavailable' | 'passkey_unsupported' };

/** Signs one POST: its path and exact body text. */
export async function signWrite(path: string, body: string): Promise<SignResult> {
  if (!window.PublicKeyCredential || !navigator.credentials)
    return { ok: false, error: 'passkey_unsupported' };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  let res: Response;
  try {
    res = await fetch('/api/passkeys/challenge', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'POST', path, bodySha256: hex(digest) }),
    });
  } catch {
    return { ok: false, error: 'passkeys_unavailable' };
  }
  const parsed = PasskeyChallenge.safeParse(await res.json().catch(() => undefined));
  if (!res.ok || !parsed.success) return { ok: false, error: 'passkeys_unavailable' };
  const c = parsed.data;
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64url(c.challenge),
        rpId: c.rpId,
        allowCredentials: c.ids.map((id) => ({ type: 'public-key', id: fromB64url(id) })),
        userVerification: 'required',
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch {
    return { ok: false, error: 'passkey_cancelled' };
  }
  if (!credential) return { ok: false, error: 'passkey_cancelled' };
  const r = credential.response as AuthenticatorAssertionResponse;
  const proof = {
    nonce: c.nonce,
    id: toB64url(credential.rawId),
    authenticatorData: toB64url(r.authenticatorData),
    clientDataJSON: toB64url(r.clientDataJSON),
    signature: toB64url(r.signature),
  };
  return { ok: true, header: toB64url(new TextEncoder().encode(JSON.stringify(proof))) };
}

/**
 * A new passkey on this device, as the line for /etc/kamaji/passkeys. The user id is the same for
 * every passkey, so a device that already has one replaces it rather than adding a second.
 */
export async function createPasskey(
  rpId: string,
  label: string,
): Promise<{ ok: true; line: string; id: string } | { ok: false; problem: string }> {
  if (!window.PublicKeyCredential || !navigator.credentials)
    return { ok: false, problem: 'This browser can’t make passkeys.' };
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: 'Kamaji' },
        user: {
          id: new TextEncoder().encode('kamaji-tyler'),
          name: 'Kamaji',
          displayName: 'Kamaji',
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key' as const, alg })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch {
    return { ok: false, problem: 'No passkey was made.' };
  }
  const r = credential?.response as AuthenticatorAttestationResponse | undefined;
  const publicKey = r?.getPublicKey?.();
  const alg = r?.getPublicKeyAlgorithm?.();
  if (!credential || !publicKey || alg === undefined)
    return { ok: false, problem: 'This browser didn’t give the passkey’s public key.' };
  const id = toB64url(credential.rawId);
  return {
    ok: true,
    id,
    line: JSON.stringify({ id, alg, publicKey: toB64url(publicKey), label }),
  };
}
