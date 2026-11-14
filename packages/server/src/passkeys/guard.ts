// Writes that start or change work on a site need a passkey (TY-170). The page asks for a nonce,
// has the passkey sign that nonce with the write's method, path and body (webauthn.ts), and sends
// the proof in the Kamaji-Passkey header. Kamaji checks it against the root-owned list (store.ts)
// and spends the nonce. An approval keeps its proof, and the updater checks it again before it
// runs anything (approvalProblem), so a batch written straight into the database doesn't run.
import { randomBytes } from 'node:crypto';
import { ApproveRequest } from '@kamaji/shared';
import type { Db } from '../db.js';
import type { Loaded } from './store.js';
import { bodyHash, challengeFor, readProof, verifyProof, type Proof } from './webauthn.js';

export interface PasskeyConfig {
  /** The accepted passkeys, read fresh on each check. */
  load: () => Loaded;
  /** The relying party: Kamaji's host, and the page's exact origin. */
  rpId: string;
  origin: string;
}

export const NONCE_MS = 3 * 60_000;

/** Kamaji's address as WebAuthn needs it. */
export function relyingParty(kamajiUrl: string): { rpId: string; origin: string } {
  const url = new URL(kamajiUrl);
  return { rpId: url.hostname, origin: url.origin };
}

export function issueNonce(db: Db, now: number): string {
  const nonce = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM passkey_nonces WHERE created_at < ?').run(now - 24 * 3_600_000);
  db.prepare('INSERT INTO passkey_nonces (nonce, created_at) VALUES (?, ?)').run(nonce, now);
  return nonce;
}

export type WriteCheck =
  | { ok: true; proof: Proof; label: string }
  | {
      ok: false;
      error: 'passkey_required' | 'passkey_refused' | 'passkeys_unavailable';
      problem: string;
    };

/** Whether this write carries a good, unspent passkey proof for exactly itself. */
export function checkWrite(
  db: Db,
  config: PasskeyConfig,
  write: { header: string | undefined; method: string; path: string; body: string },
  now: number,
): WriteCheck {
  if (!write.header) return { ok: false, error: 'passkey_required', problem: 'no passkey' };
  const loaded = config.load();
  if (!loaded.ok) return { ok: false, error: 'passkeys_unavailable', problem: loaded.problem };
  const proof = readProof(write.header);
  if (!proof) return { ok: false, error: 'passkey_refused', problem: 'unreadable proof' };
  const verdict = verifyProof(proof, loaded.passkeys, {
    challenge: challengeFor(proof.nonce, write.method, write.path, bodyHash(write.body)),
    rpId: config.rpId,
    origin: config.origin,
  });
  if (!verdict.ok) return { ok: false, error: 'passkey_refused', problem: verdict.problem };

  // A signature counter that doesn't move on is a cloned authenticator; synced passkeys always
  // say 0, which says nothing either way.
  const last = Number(
    db.prepare('SELECT sign_count FROM passkey_counters WHERE id = ?').get(proof.id)?.sign_count ??
      0,
  );
  if ((verdict.signCount > 0 || last > 0) && verdict.signCount <= last)
    return { ok: false, error: 'passkey_refused', problem: 'signature counter went backwards' };

  const spent = db
    .prepare(
      'UPDATE passkey_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL AND created_at > ?',
    )
    .run(now, proof.nonce, now - NONCE_MS);
  if (Number(spent.changes) !== 1)
    return {
      ok: false,
      error: 'passkey_refused',
      problem: 'the nonce is spent, expired or unknown',
    };
  db.prepare(
    `INSERT INTO passkey_counters (id, sign_count) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET sign_count = excluded.sign_count`,
  ).run(proof.id, verdict.signCount);
  return { ok: true, proof, label: verdict.passkey.label };
}

/** What an approved batch keeps: the request exactly as signed, and the proof. */
export interface Approval {
  body: string;
  proof: Proof;
}

/**
 * Why the updater mustn't run this batch, or null when its approval holds: a proof that checks
 * out for POST /api/batches with the stored body, and the batch's items, sites and one-site-first
 * exactly as that body says. Nonces and counters aren't checked again: they were spent at approval.
 */
export function approvalProblem(db: Db, config: PasskeyConfig, batchId: string): string | null {
  const row = db.prepare('SELECT approval, one_site_first FROM batches WHERE id = ?').get(batchId);
  if (!row) return 'no such batch';
  if (row.approval === null) return 'no passkey approval';
  let approval: Approval;
  try {
    approval = JSON.parse(String(row.approval)) as Approval;
  } catch {
    return 'an unreadable approval';
  }
  const loaded = config.load();
  if (!loaded.ok) return loaded.problem;
  const proof = readProof(Buffer.from(JSON.stringify(approval.proof)).toString('base64url'));
  if (!proof || typeof approval.body !== 'string') return 'an unreadable approval';
  const verdict = verifyProof(proof, loaded.passkeys, {
    challenge: challengeFor(proof.nonce, 'POST', '/api/batches', bodyHash(approval.body)),
    rpId: config.rpId,
    origin: config.origin,
  });
  if (!verdict.ok) return `the approval’s passkey: ${verdict.problem}`;
  const uses = db
    .prepare("SELECT count(*) AS n FROM batches WHERE json_extract(approval, '$.proof.nonce') = ?")
    .get(proof.nonce);
  if (Number(uses?.n) !== 1) return 'an approval used for more than one run';

  let request: ApproveRequest;
  try {
    request = ApproveRequest.parse(JSON.parse(approval.body));
  } catch {
    return 'an unreadable approval';
  }
  const key = (i: { siteId: string; type: string; item: string; from: string; to: string }) =>
    [i.siteId, i.type, i.item, i.from, i.to].join('\u0000');
  const approved = request.items.map(key).sort();
  const stored = db
    .prepare(
      `SELECT site_id AS siteId, type, item, from_version AS "from", to_version AS "to"
       FROM batch_items WHERE batch_id = ?`,
    )
    .all(batchId)
    .map((r) =>
      key({
        siteId: String(r.siteId),
        type: String(r.type),
        item: String(r.item),
        from: String(r.from),
        to: String(r.to),
      }),
    )
    .sort();
  const sites = db
    .prepare('SELECT site_id FROM batch_sites WHERE batch_id = ? ORDER BY position')
    .all(batchId)
    .map((r) => String(r.site_id));
  if (
    approved.join('\n') !== stored.join('\n') ||
    sites.join('\n') !== [...new Set(request.items.map((i) => i.siteId))].join('\n') ||
    Number(row.one_site_first) !== (request.oneSiteFirst ? 1 : 0)
  )
    return 'the run isn’t what was approved';
  return null;
}
