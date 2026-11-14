// Which passkeys Kamaji accepts: a file only root can change (TY-170). Kamaji and every agent on
// the mini run as the same user, so a list Kamaji could write, in its database or its folder, an
// agent could add its own key to. Adding one takes sudo (ops/README.md, "Passkeys"); Kamaji only
// reads the file, and refuses it if this user could change it.
//
// One passkey per line, as JSON: {"id","alg","publicKey","label"} (webauthn.ts). Blank lines and
// lines starting with # are skipped. The Passkeys page makes the line for a new one.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALGORITHMS, type Passkey } from './webauthn.js';

export const PASSKEYS_FILE = '/etc/kamaji/passkeys';

export type Loaded = { ok: true; passkeys: Passkey[] } | { ok: false; problem: string };

/** Who may change a path: root only, or this user too. */
function rootOnly(path: string): boolean {
  const s = statSync(path);
  return s.uid === 0 && (s.mode & 0o022) === 0;
}

export function parsePasskeys(text: string): Passkey[] {
  const out: Passkey[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      const p = JSON.parse(t) as Record<string, unknown>;
      if (
        typeof p.id === 'string' &&
        typeof p.publicKey === 'string' &&
        typeof p.alg === 'number' &&
        (ALGORITHMS as readonly number[]).includes(p.alg)
      )
        out.push({
          id: p.id,
          alg: p.alg,
          publicKey: p.publicKey,
          label: typeof p.label === 'string' ? p.label.slice(0, 60) : 'passkey',
        });
    } catch {
      // A broken line is skipped; the rest still count.
    }
  }
  return out;
}

/**
 * The passkeys in `path`, read fresh each time so a sudo edit takes effect at once. Refused when
 * the file or its folder isn't root's alone, unless `trustOwner` (local development only).
 */
export function loadPasskeys(path = PASSKEYS_FILE, { trustOwner = false } = {}): Loaded {
  let text: string;
  try {
    const real = realpathSync(path);
    if (!trustOwner && !(rootOnly(real) && rootOnly(dirname(real))))
      return { ok: false, problem: `${path} must be root's, and writable by root only` };
    text = readFileSync(real, 'utf8');
  } catch {
    return { ok: false, problem: `no passkeys file at ${path}` };
  }
  const passkeys = parsePasskeys(text);
  if (passkeys.length === 0) return { ok: false, problem: `no passkeys in ${path}` };
  return { ok: true, passkeys };
}
