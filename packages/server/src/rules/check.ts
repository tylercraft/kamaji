// The updater's check of a rule's run (ops/rules-plan.md, "The approval"), in place of the
// passkey check on a batch Tyler approved. Tyler (2026-11-19): every fact about a site the updater
// reads is untrusted except what's in the signed rule. So what decides what a run may do comes
// from the signed body (the sites, their addresses and backups, the kinds of change, the wait,
// the time), from the site itself (a report the updater asks for), and from wordpress.org (when a
// version was released). Kamaji's records can only narrow a run: a site whose row no longer
// matches what was signed isn't run, but nothing in a row can add a site, an update or a day.
import type { CareReport, RuleBody } from '@kamaji/shared';
import type { Db } from '../db.js';
import { wholeSite } from '../ready.js';
import { updateTimes } from '../sitebackups/schedule.js';
import { matches } from '../wordfence/feed.js';
import { compareVersions } from '../wordfence/version.js';
import { matchItem, ruleSite, type Candidate } from './match.js';
import type { OrgLookup } from './org.js';
import { LATE_MS, VETO_MS } from './runs.js';

export type RuleApproval = (
  ruleId: string,
  version: number,
) => { ok: true; body: RuleBody } | { ok: false; problem: string };

export interface RuleRun {
  ruleId: string;
  version: number;
  body: RuleBody;
  /** The update time it's for, worked out from the signed rule and the updater's own clock. */
  update: number;
}

/**
 * Whether a rule's run may start, from the signed rule: its proof, that it's the latest version
 * and not paused or deleted, the time, and that its sites and updates are within what was signed.
 */
export function ruleRunProblem(
  db: Db,
  batchId: string,
  approval: RuleApproval,
  now: number,
): { ok: true; run: RuleRun } | { ok: false; problem: string; ruleId: string | null } {
  const batch = db
    .prepare('SELECT rule_id, rule_version, update_at FROM batches WHERE id = ?')
    .get(batchId);
  if (!batch || batch.rule_id === null)
    return { ok: false, problem: 'not a rule’s run', ruleId: null };
  const ruleId = String(batch.rule_id);
  const fail = (problem: string) => ({ ok: false as const, problem, ruleId });
  const version = Number(batch.rule_version);
  const signed = approval(ruleId, version);
  if (!signed.ok) return fail(signed.problem);
  const rule = db.prepare('SELECT paused_at, deleted_at FROM rules WHERE id = ?').get(ruleId);
  if (!rule || rule.deleted_at !== null) return fail('the rule was deleted');
  if (rule.paused_at !== null) return fail('the rule is paused');
  const latest = Number(
    db.prepare('SELECT MAX(version) AS v FROM rule_versions WHERE rule_id = ?').get(ruleId)?.v,
  );
  if (latest !== version) return fail('the rule was changed after this run was set out');

  const body = signed.body;
  const update = updateTimes(now, body.when).last;
  if (Number(batch.update_at) !== update) return fail('the run isn’t for the rule’s update time');
  if (now < update + VETO_MS) return fail('it’s too early: the hour to pause it isn’t over');
  if (now > update + LATE_MS) return fail('it’s too late: over 6 hours after the update time');

  const sites = db
    .prepare('SELECT site_id FROM batch_sites WHERE batch_id = ?')
    .all(batchId)
    .map((r) => String(r.site_id));
  if (sites.length > body.most.sites) return fail('more sites than the rule allows');
  for (const site of sites) {
    if (!ruleSite(body, site)) return fail(`${site} isn’t one of the rule’s sites`);
    const items = db
      .prepare('SELECT type FROM batch_items WHERE batch_id = ? AND site_id = ?')
      .all(batchId, site);
    if (items.length > body.most.perSite)
      return fail('more updates on a site than the rule allows');
    if (items.some((i) => !body.types.includes(String(i.type) as 'plugin' | 'theme')))
      return fail('an update of a kind the rule doesn’t cover');
  }
  return { ok: true, run: { ruleId, version, body, update } };
}

/**
 * Why a site of a rule's run mustn't run, or null. The address and backup are the signed ones;
 * the site's row only has to agree with them (a row that changed since narrows, never widens).
 * Kamaji's backup must be this update's whole-site snapshot with its restore check passed.
 */
export function ruleSiteProblem(db: Db, run: RuleRun, siteId: string, now: number): string | null {
  const signed = ruleSite(run.body, siteId);
  if (!signed) return 'it isn’t one of the rule’s sites';
  const row = db
    .prepare('SELECT url, backup_expectation, mode, paused_at, removed_at FROM sites WHERE id = ?')
    .get(siteId);
  if (!row || row.removed_at !== null) return 'the site was removed';
  if (row.mode !== 'connected' || row.paused_at !== null) return 'the site isn’t being updated now';
  if (String(row.url) !== signed.url) return 'its address changed since the rule was signed';
  if (String(row.backup_expectation) !== signed.backup)
    return 'its backup changed since the rule was signed';
  if (signed.backup === 'kamaji') {
    const backup = wholeSite(db, siteId, run.update, now);
    if (backup.state !== 'fresh') return 'this week’s whole-site backup isn’t there';
    if (backup.restoredAt === null)
      return 'this week’s whole-site backup hasn’t been restore-checked';
  }
  return null;
}

/** One waiting update of a rule's run, as the updater has it. */
export interface RunItem {
  type: 'core' | 'plugin' | 'theme';
  item: string;
  from: string;
  to: string;
}

/**
 * Whether the rule takes this update, by the report the updater just got from the site: what's
 * installed and what WordPress offers, there and then. When wordpress.org released it is asked
 * of wordpress.org. Whether it fixes a known vulnerability, and whether Kamaji rolled it back, are
 * Kamaji's records: the first only shortens the wait to the rule's own for security fixes, within
 * everything else the rule says.
 */
export async function ruleItemVerdict(
  db: Db,
  run: RuleRun,
  siteId: string,
  item: RunItem,
  report: CareReport,
  org: OrgLookup,
  now: number,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const found =
    item.type === 'plugin'
      ? report.plugins.find((p) => p.file === item.item)
      : item.type === 'theme'
        ? report.themes.find((t) => t.stylesheet === item.item)
        : undefined;
  if (!found) return { ok: false, why: 'the site no longer has it' };
  const slug = 'slug' in found ? found.slug : found.stylesheet;
  if (found.version !== item.from)
    return { ok: false, why: `${found.version} is installed now, not ${item.from}` };
  if (!found.offer || found.offer.version !== item.to)
    return { ok: false, why: 'WordPress no longer offers this version' };
  const security = matches(db, siteId).some(
    (m) =>
      !m.vulnerability.informational &&
      m.type === item.type &&
      m.item === item.item &&
      m.fixedIn !== null &&
      compareVersions(item.to, m.fixedIn) >= 0,
  );
  const facts: Candidate = {
    siteId,
    type: item.type,
    slug,
    from: found.version,
    to: found.offer.version,
    package: found.offer.package,
    security,
    release: { version: item.to, at: 0 },
    rolledBack: rolledBackFrom(db, siteId, item),
  };
  const first = matchItem(run.body, facts, now);
  if (!first.ok || item.type === 'core') return first;
  return matchItem(run.body, { ...facts, release: await org(item.type, slug) }, now);
}

/** Whether the item's latest rollback, not undone, put it back from exactly this version. */
function rolledBackFrom(db: Db, siteId: string, item: RunItem): boolean {
  const row = db
    .prepare(
      `SELECT i.now_version,
         EXISTS (SELECT 1 FROM rollbacks u WHERE u.kind = 'undo' AND u.undoes = r.id
           AND u.changed IN ('files', 'all')) AS undone
       FROM rollback_items i JOIN rollbacks r ON r.id = i.rollback_id
       WHERE r.site_id = ? AND r.kind = 'rollback' AND r.changed IN ('files', 'all')
         AND i.type = ? AND i.item = ?
       ORDER BY r.requested_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(siteId, item.type, item.item);
  return !!row && Number(row.undone) === 0 && String(row.now_version) === item.to;
}
