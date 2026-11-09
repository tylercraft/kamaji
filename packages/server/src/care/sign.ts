// Signing a craftish-care request (docs/protocol.md, "Requests"). The plugin rebuilds the same
// string from the request as it arrived and checks it, so every field here is exact.
import { createHash, randomBytes, sign } from 'node:crypto';
import type { SigningKey } from './keys.js';

export const ENDPOINT_ROUTE = (endpoint: string) => `/craftish-care/v1/${endpoint}`;

export interface SignedParts {
  method: 'POST';
  /** Lowercase, with the port only when it isn't the default: URL.host already is. */
  host: string;
  route: string;
  keyId: string;
  time: number;
  nonce: string;
  body: string;
}

export function signedString(p: SignedParts): string {
  return [
    'craftish-care-v1',
    p.method,
    p.host.toLowerCase(),
    p.route,
    p.keyId,
    String(p.time),
    p.nonce,
    createHash('sha256').update(p.body, 'utf8').digest('hex'),
  ].join('\n');
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** The four X-Care headers for one request. */
export function signRequest(
  key: SigningKey,
  site: URL,
  endpoint: string,
  body: string,
  options: { now?: number; nonce?: string } = {},
): Record<string, string> {
  const time = Math.floor((options.now ?? Date.now()) / 1000);
  const nonce = options.nonce ?? newNonce();
  const message = signedString({
    method: 'POST',
    host: site.host,
    route: ENDPOINT_ROUTE(endpoint),
    keyId: key.id,
    time,
    nonce,
    body,
  });
  return {
    'X-Care-Key': key.id,
    'X-Care-Time': String(time),
    'X-Care-Nonce': nonce,
    'X-Care-Signature': sign(null, Buffer.from(message, 'utf8'), key.privateKey).toString(
      'base64url',
    ),
  };
}
