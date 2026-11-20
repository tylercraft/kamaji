// Rules as Kamaji keeps them (ops/rules-plan.md): saving a version Tyler signed, pausing,
// deleting, and which sites a rule may name. The app's side only: nothing here is trusted by the
// updater, which checks the signed body itself (rules/check.ts).
import { randomBytes } from 'node:crypto';
import type { RuleBody, RuleSiteOption } from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { recordEvent } from '../events.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { eligible } from '../sitebackups/eligible.js';
import { updatableSites } from '../updates/queue.js';

export interface RuleRow {
  id: string;
  createdAt: number;
  pausedAt: number | null;
  pausedBy: string | null;
  pausedReason: string | null;
  version: number;
  /** The latest version's body, as stored. The updater reads it again from the proof. */
  body: RuleBody;
  signedAt: number;
  signedBy: string;
}

/** The rules not deleted, each with its latest version, oldest first. */
export function ruleRows(db: Db): RuleRow[] {
  return db
    .prepare(
      `SELECT r.*, v.version, v.body, v.signed_at, v.signed_by FROM rules r
       JOIN rule_versions v ON v.rule_id = r.id
         AND v.version = (SELECT MAX(version) FROM rule_versions WHERE rule_id = r.id)
       WHERE r.deleted_at IS NULL ORDER BY r.created_at, r.id`,
    )
    .all()
    .map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      pausedAt: r.paused_at === null ? null : Number(r.paused_at),
      pausedBy: r.paused_by === null ? null : String(r.paused_by),
      pausedReason: r.paused_reason === null ? null : String(r.paused_reason),
      version: Number(r.version),
      body: JSON.parse(String(r.body)) as RuleBody,
      signedAt: Number(r.signed_at),
      signedBy: String(r.signed_by),
    }));
}

export const ruleRow = (db: Db, id: string): RuleRow | undefined =>
  ruleRows(db).find((r) => r.id === id);

/**
 * The backup a rule may count on for a site as it stands: Kamaji's, when its whole-site backups
 * are on (each one restore-checked), or the host's. Anything else, why not.
 */
export function ruleBackup(
  db: Db,
  site: { id: string; backupKind: string },
): { ok: true; backup: 'kamaji' | 'host' } | { ok: false; why: string } {
  if (site.backupKind === 'host') return { ok: true, backup: 'host' };
  if (site.backupKind === 'kamaji')
    return eligible(db, site.id)
      ? { ok: true, backup: 'kamaji' }
      : {
          ok: false,
          why: 'Kamaji’s backup here is a database export, not a restore-checked whole-site backup',
        };
  if (site.backupKind === 'client')
    return { ok: false, why: 'the client’s own backup never counts' };
  return { ok: false, why: 'its backup is your word each time, which a rule can’t give' };
}

/** The sites a rule may name, and the ones it may not, with why. */
export function ruleSites(db: Db): {
  sites: RuleSiteOption[];
  notAllowed: { id: string; name: string; why: string }[];
} {
  const sites: RuleSiteOption[] = [];
  const notAllowed: { id: string; name: string; why: string }[] = [];
  for (const s of updatableSites(db)) {
    if (s.blocked) {
      notAllowed.push({ id: s.id, name: s.name, why: s.blocked });
      continue;
    }
    const b = ruleBackup(db, s);
    if (!b.ok) {
      notAllowed.push({ id: s.id, name: s.name, why: b.why });
      continue;
    }
    const auto = db
      .prepare(
        `SELECT slug FROM components WHERE site_id = ? AND gone_at IS NULL AND auto_update = 1
         AND type IN ('plugin', 'theme') AND slug IS NOT NULL ORDER BY slug`,
      )
      .all(s.id)
      .map((r) => String(r.slug));
    sites.push({ id: s.id, name: s.name, url: s.url, backup: b.backup, autoUpdates: auto });
  }
  return { sites, notAllowed };
}

/**
 * Why a body can't be saved as it stands, or null: each site one a rule may name now, with its
 * address and backup as Kamaji has them. The page fills those in; this keeps a stale page from
 * signing something that would never run.
 */
export function bodyProblem(db: Db, body: RuleBody): string | null {
  const { sites, notAllowed } = ruleSites(db);
  for (const s of body.sites) {
    const known = sites.find((x) => x.id === s.id);
    if (!known) {
      const why = notAllowed.find((x) => x.id === s.id)?.why;
      return `${s.id} can’t be in a rule${why ? `: ${why}` : ''}`;
    }
    if (known.url !== s.url) return `${known.name}’s address is ${known.url} now`;
    if (known.backup !== s.backup) return `${known.name}’s backup is ${known.backup} now`;
  }
  if (body.ruleId !== null) {
    const rule = db.prepare('SELECT deleted_at FROM rules WHERE id = ?').get(body.ruleId);
    if (!rule || rule.deleted_at !== null) return 'no such rule';
  }
  return null;
}

/**
 * Saves a version Tyler signed: a new rule, or the next version of one, which also resumes it.
 * `approval` is the signed request and its proof, as the passkey guard hands it over.
 */
export function saveRule(
  db: Db,
  body: RuleBody,
  approval: string,
  by: string,
  at: number,
): { id: string; version: number } {
  let id = body.ruleId ?? '';
  let version = 1;
  transaction(db, () => {
    if (body.ruleId === null) {
      id = randomBytes(8).toString('hex');
      db.prepare('INSERT INTO rules (id, created_at, created_by) VALUES (?, ?, ?)').run(id, at, by);
    } else {
      version =
        Number(
          db.prepare('SELECT MAX(version) AS v FROM rule_versions WHERE rule_id = ?').get(id)?.v ??
            0,
        ) + 1;
    }
    const was = db.prepare('SELECT paused_at FROM rules WHERE id = ?').get(id);
    db.prepare(
      'UPDATE rules SET paused_at = NULL, paused_by = NULL, paused_reason = NULL WHERE id = ?',
    ).run(id);
    db.prepare(
      `INSERT INTO rule_versions (rule_id, version, body, approval, signed_at, signed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, version, JSON.stringify(body), approval, at, by);
    clearIssue(
      db,
      at,
      { resourceType: 'kamaji', resourceId: `rule:${id}`, kind: 'rule-paused' },
      'The rule was signed again',
    );
    recordEvent(db, at, {
      kind: 'rule.saved',
      summary:
        version === 1
          ? `Rule “${body.name}” made`
          : was?.paused_at !== null && was?.paused_at !== undefined
            ? `Rule “${body.name}” signed again and resumed`
            : `Rule “${body.name}” changed`,
      resourceType: 'kamaji',
      resourceId: 'rules',
      detail: { rule: id, version, by },
    });
  });
  return { id, version };
}

/**
 * Pauses a rule: no run it made starts until Tyler signs it again. By Tyler, or by Kamaji after a
 * run went wrong, which also opens an issue so it's seen. Pausing twice keeps the first reason.
 */
export function pauseRule(db: Db, id: string, by: string, reason: string, at: number): boolean {
  const rule = ruleRow(db, id);
  if (!rule) return false;
  if (rule.pausedAt !== null) return true;
  transaction(db, () => {
    db.prepare('UPDATE rules SET paused_at = ?, paused_by = ?, paused_reason = ? WHERE id = ?').run(
      at,
      by,
      reason,
      id,
    );
    recordEvent(db, at, {
      kind: 'rule.paused',
      summary: `Rule “${rule.body.name}” paused: ${reason}`,
      resourceType: 'kamaji',
      resourceId: 'rules',
      detail: { rule: id, by },
    });
    // Discord gets the issue's summary: no rule name, which may name plugins.
    if (by === 'kamaji')
      raiseIssue(db, at, {
        resourceType: 'kamaji',
        resourceId: `rule:${id}`,
        kind: 'rule-paused',
        severity: 'urgent',
        summary: 'A rule paused itself after a run went wrong: look under Rules',
      });
  });
  return true;
}

/** Deletes a rule: it never runs again, and its versions are kept for the record. */
export function deleteRule(db: Db, id: string, by: string, at: number): boolean {
  const rule = ruleRow(db, id);
  if (!rule) return false;
  transaction(db, () => {
    db.prepare('UPDATE rules SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(at, by, id);
    clearIssue(
      db,
      at,
      { resourceType: 'kamaji', resourceId: `rule:${id}`, kind: 'rule-paused' },
      'The rule was deleted',
    );
    recordEvent(db, at, {
      kind: 'rule.deleted',
      summary: `Rule “${rule.body.name}” deleted`,
      resourceType: 'kamaji',
      resourceId: 'rules',
      detail: { rule: id, by },
    });
  });
  return true;
}
