// Writes that start or change work on a site need a passkey (TY-170). The page asks for a nonce,
// has the passkey sign that nonce with the write's method, path and body (webauthn.ts), and sends
// the proof in the Kamaji-Passkey header. Kamaji checks it against the root-owned list (store.ts)
// and spends the nonce. An approval keeps its proof, and the updater checks it again before it
// runs anything (approvalProblem), so a batch written straight into the database doesn't run.
// A rollback or undo keeps its proof the same way, checked by the backups process before it
// pushes (rollbackApprovalProblem), and a rule each of its versions, checked by the updater
// before a run the rule made (ruleApprovalProblem, rules/check.ts).
import { randomBytes } from 'node:crypto';
import { ApproveRequest, RollbackRequest, RuleBody, UndoRequest } from '@kamaji/shared';
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
/**
 * A stored approval's body, once its proof checks out for a POST to `path` with that body and
 * its nonce signed nothing else: in none of batches, rollbacks or rule versions more than this
 * once.
 */
function signedBody(
  db: Db,
  config: PasskeyConfig,
  stored: unknown,
  path: string,
): { ok: true; body: string } | { ok: false; problem: string } {
  if (stored === null || stored === undefined) return { ok: false, problem: 'no passkey approval' };
  let approval: Approval;
  try {
    approval = JSON.parse(String(stored)) as Approval;
  } catch {
    return { ok: false, problem: 'an unreadable approval' };
  }
  const loaded = config.load();
  if (!loaded.ok) return { ok: false, problem: loaded.problem };
  const proof = readProof(Buffer.from(JSON.stringify(approval.proof)).toString('base64url'));
  if (!proof || typeof approval.body !== 'string')
    return { ok: false, problem: 'an unreadable approval' };
  const verdict = verifyProof(proof, loaded.passkeys, {
    challenge: challengeFor(proof.nonce, 'POST', path, bodyHash(approval.body)),
    rpId: config.rpId,
    origin: config.origin,
  });
  if (!verdict.ok) return { ok: false, problem: `the approval’s passkey: ${verdict.problem}` };
  const uses = db
    .prepare(
      `SELECT (SELECT count(*) FROM batches WHERE json_extract(approval, '$.proof.nonce') = ?1)
         + (SELECT count(*) FROM rollbacks WHERE json_extract(approval, '$.proof.nonce') = ?1)
         + (SELECT count(*) FROM rule_versions WHERE json_extract(approval, '$.proof.nonce') = ?1) AS n`,
    )
    .get(proof.nonce);
  if (Number(uses?.n) !== 1) return { ok: false, problem: 'an approval used more than once' };
  return { ok: true, body: approval.body };
}

export function approvalProblem(db: Db, config: PasskeyConfig, batchId: string): string | null {
  const row = db.prepare('SELECT approval, one_site_first FROM batches WHERE id = ?').get(batchId);
  if (!row) return 'no such batch';
  const signed = signedBody(db, config, row.approval, '/api/batches');
  if (!signed.ok) return signed.problem;

  let request: ApproveRequest;
  try {
    request = ApproveRequest.parse(JSON.parse(signed.body));
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

/**
 * Why the backups process mustn't push this rollback or undo, or null when its approval holds: a
 * proof that checks out for exactly its own POST (the site's rollback, or its undo) with the
 * stored body, and the row as that body says: the run (or the rollback undone) and the database
 * box. What it puts back isn't in the body: the push works that out again from the run before it
 * sends anything (push.ts), and refuses when it differs from the row.
 */
export function rollbackApprovalProblem(db: Db, config: PasskeyConfig, id: string): string | null {
  const row = db
    .prepare(
      'SELECT kind, site_id, batch_id, undoes, with_database, approval FROM rollbacks WHERE id = ?',
    )
    .get(id);
  if (!row) return 'no such rollback';
  const undo = row.kind === 'undo';
  const path = `/api/sites/${encodeURIComponent(String(row.site_id))}/rollback${undo ? '/undo' : ''}`;
  const signed = signedBody(db, config, row.approval, path);
  if (!signed.ok) return signed.problem;
  let json: unknown;
  try {
    json = JSON.parse(signed.body);
  } catch {
    return 'an unreadable approval';
  }
  const withDatabase = Number(row.with_database) === 1;
  if (undo) {
    const request = UndoRequest.safeParse(json);
    if (!request.success) return 'an unreadable approval';
    if (
      request.data.rollbackId !== String(row.undoes) ||
      request.data.withDatabase !== withDatabase
    )
      return 'the undo isn’t what was approved';
  } else {
    const request = RollbackRequest.safeParse(json);
    if (!request.success) return 'an unreadable approval';
    if (request.data.batchId !== String(row.batch_id) || request.data.withDatabase !== withDatabase)
      return 'the rollback isn’t what was approved';
  }
  return null;
}

/**
 * A rule version's signed body, or why it doesn't hold (ops/rules-plan.md, "The approval"): a
 * proof that checks out for POST /api/rules with the stored body, a body that reads as a rule,
 * and one that's for this rule (a new rule's first version names none). Whether it's the latest,
 * paused or deleted is rules/check.ts's to say.
 */
export function ruleApprovalProblem(
  db: Db,
  config: PasskeyConfig,
  ruleId: string,
  version: number,
): { ok: true; body: RuleBody } | { ok: false; problem: string } {
  const row = db
    .prepare('SELECT approval FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, version);
  if (!row) return { ok: false, problem: 'no such rule version' };
  const signed = signedBody(db, config, row.approval, '/api/rules');
  if (!signed.ok) return signed;
  let body: RuleBody;
  try {
    body = RuleBody.parse(JSON.parse(signed.body));
  } catch {
    return { ok: false, problem: 'an unreadable rule' };
  }
  if (body.ruleId !== (version === 1 ? null : ruleId))
    return { ok: false, problem: 'the signed rule is another rule’s' };
  return { ok: true, body };
}
