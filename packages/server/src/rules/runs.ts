// A rule's runs, from the app's side (ops/rules-plan.md, "Where it runs"): what a rule would take
// from the queue, the run it makes at its update time (waiting an hour for Tyler to pause it),
// pausing that run, and the Rules page. Everything here goes by Kamaji's own records, which is
// fine for showing and proposing: the updater checks each run again from the signed rule, the
// site and wordpress.org before it sends anything (rules/check.ts).
import { randomUUID } from 'node:crypto';
import type { BatchRule, QueueItem, RuleBody, RuleCandidate, RuleView } from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { recordEvent } from '../events.js';
import { READY_WINDOW } from '../ready.js';
import { readUpdateTime } from '../settings.js';
import { updateTimes } from '../sitebackups/schedule.js';
import { readState, writeState } from '../state.js';
import { queue } from '../updates/queue.js';
import { matchItem, ruleSite, ruleWords, type Candidate } from './match.js';
import type { OrgLookup } from './org.js';
import { ruleRows, ruleSites, type RuleRow } from './store.js';

const HOUR = 60 * 60_000;
/** How long a rule's run waits after "Ready to update", for Tyler to pause it. */
export const VETO_MS = HOUR;
/** The updater never starts a rule's run later than this after its update time. */
export const LATE_MS = 6 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const ORDER = { core: 0, plugin: 1, theme: 2 } as const;

/** Why a signed site won't run as signed, going by Kamaji's records now; null when it will. */
export function siteWarning(db: Db, body: RuleBody, siteId: string): string | null {
  const signed = ruleSite(body, siteId)!;
  const { sites, notAllowed } = ruleSites(db);
  const now = sites.find((s) => s.id === siteId);
  const name =
    now?.name ??
    notAllowed.find((s) => s.id === siteId)?.name ??
    String(db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId)?.name ?? siteId);
  if (!now) {
    const why = notAllowed.find((s) => s.id === siteId)?.why ?? 'it isn’t a site Kamaji updates';
    return `${name} won’t run: ${why}`;
  }
  if (now.url !== signed.url)
    return `${name} won’t run: its address changed since the rule was signed`;
  if (now.backup !== signed.backup)
    return `${name} won’t run: its backup changed since the rule was signed`;
  return null;
}

type Item = QueueItem & { slug: string };

/** The queue on the rule's sites, with each item's slug. */
function itemsFor(db: Db, body: RuleBody): Item[] {
  const ids = new Set(body.sites.map((s) => s.id));
  return queue(db)
    .items.filter((i) => ids.has(i.siteId))
    .map((i) => ({
      ...i,
      slug:
        i.type === 'core'
          ? 'core'
          : String(
              db
                .prepare(
                  'SELECT slug FROM components WHERE site_id = ? AND type = ? AND item = ? AND gone_at IS NULL',
                )
                .get(i.siteId, i.type, i.item)?.slug ?? '',
            ),
    }));
}

/**
 * What a rule would take at `at`, and what it wouldn't, with why. wordpress.org is asked only
 * about what passes everything else. Over the rule's limits, the rest are misses too.
 */
export async function candidates(
  db: Db,
  body: RuleBody,
  at: number,
  org: OrgLookup,
): Promise<{ takes: (RuleCandidate & { item: Item })[]; misses: RuleCandidate[] }> {
  const takes: (RuleCandidate & { item: Item })[] = [];
  const misses: RuleCandidate[] = [];
  const warned = new Map(body.sites.map((s) => [s.id, siteWarning(db, body, s.id)]));
  for (const item of itemsFor(db, body)) {
    const words = {
      siteId: item.siteId,
      siteName: item.siteName,
      name: item.name,
      from: item.from,
      to: item.to,
    };
    const warning = warned.get(item.siteId);
    if (warning) {
      misses.push({ ...words, why: warning.replace(/^.*? won’t run: /, '') });
      continue;
    }
    const facts: Candidate = {
      siteId: item.siteId,
      type: item.type,
      slug: item.slug,
      from: item.from,
      to: item.to,
      package: true,
      security: item.security,
      // Everything but the wait first, so wordpress.org is asked only when it matters.
      release: { version: item.to, at: 0 },
      rolledBack: item.rolledBackAt !== null && item.rolledBackAt !== undefined,
    };
    let verdict = matchItem(body, facts, at);
    if (verdict.ok && item.type !== 'core')
      verdict = matchItem(body, { ...facts, release: await org(item.type, item.slug) }, at);
    if (verdict.ok) takes.push({ ...words, why: null, item });
    else misses.push({ ...words, why: verdict.why });
  }
  // The rule's limits, in its own order of sites.
  const kept: typeof takes = [];
  const siteOrder = body.sites.map((s) => s.id);
  let sites = 0;
  for (const id of siteOrder) {
    const here = takes.filter((t) => t.siteId === id);
    if (here.length === 0) continue;
    if (sites >= body.most.sites) {
      for (const t of here)
        misses.push({ ...plain(t), why: `over the rule’s ${body.most.sites} sites a run` });
      continue;
    }
    sites += 1;
    here.forEach((t, n) => {
      if (n < body.most.perSite) kept.push(t);
      else misses.push({ ...plain(t), why: `over the rule’s ${body.most.perSite} a site` });
    });
  }
  return { takes: kept, misses };
}

/** A candidate as the page shows it, without the queue item behind it. */
const plain = (t: RuleCandidate): RuleCandidate => ({
  siteId: t.siteId,
  siteName: t.siteName,
  name: t.name,
  from: t.from,
  to: t.to,
  why: t.why,
});

const stateKey = (ruleId: string) => `rule-run:${ruleId}`;

/**
 * The cycle's part, at each rule's update time and up to 3 hours after it (Kamaji down then):
 * once per rule and update time, the run it takes, waiting an hour. A paused rule makes none, and
 * one resumed within those 3 hours still does. Returns how many runs it made.
 */
export async function makeRuleRuns(db: Db, now: number, org: OrgLookup): Promise<number> {
  let made = 0;
  for (const rule of ruleRows(db)) {
    if (rule.pausedAt !== null) continue;
    const update = updateTimes(now, rule.body.when).last;
    if (now - update > READY_WINDOW) continue;
    if (readState<number>(db, stateKey(rule.id)) === update) continue;
    const { takes } = await candidates(db, rule.body, Math.max(now, update) + VETO_MS, org);
    if (takes.length > 0) {
      makeRun(
        db,
        rule,
        update,
        now,
        takes.map((t) => t.item),
      );
      made += 1;
    } else
      recordEvent(db, now, {
        kind: 'rule.nothing',
        summary: `Rule “${rule.body.name}” found nothing to take this week`,
        resourceType: 'kamaji',
        resourceId: 'rules',
        detail: { rule: rule.id, version: rule.version },
      });
    writeState(db, stateKey(rule.id), update, now);
  }
  return made;
}

function makeRun(db: Db, rule: RuleRow, update: number, now: number, items: Item[]): void {
  const id = randomUUID();
  const startsAt = Math.max(now, update) + VETO_MS;
  const siteIds = rule.body.sites.map((s) => s.id).filter((s) => items.some((i) => i.siteId === s));
  transaction(db, () => {
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, approval,
         rule_id, rule_version, update_at, starts_at)
       VALUES (?, ?, 'rule', 1, 'approved', NULL, ?, ?, ?, ?)`,
    ).run(id, now, rule.id, rule.version, update, startsAt);
    siteIds.forEach((siteId, position) => {
      db.prepare(
        `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state)
         VALUES (?, ?, ?, ?, NULL, 'waiting')`,
      ).run(id, siteId, position, ruleSite(rule.body, siteId)!.backup);
      items
        .filter((i) => i.siteId === siteId)
        .sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.item.localeCompare(b.item))
        .forEach((i, n) => {
          db.prepare(
            `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name,
               from_version, to_version, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`,
          ).run(randomUUID(), id, siteId, n, i.type, i.item, i.name, i.from, i.to);
        });
    });
    recordEvent(db, now, {
      kind: 'batch.ruled',
      summary: `Rule “${rule.body.name}” set out ${items.length} ${items.length === 1 ? 'update' : 'updates'} on ${siteIds.length} ${siteIds.length === 1 ? 'site' : 'sites'}, to run at ${iso(startsAt)} unless paused`,
      resourceType: 'kamaji',
      resourceId: 'updates',
      detail: { batch: id, rule: rule.id, version: rule.version },
    });
  });
}

/** The runs rules made for an update time, for "Ready to update". */
export function ruleRunsFor(
  db: Db,
  update: number,
): { name: string; updates: number; sites: number; startsAt: string }[] {
  return db
    .prepare(
      `SELECT b.id, b.starts_at, v.body,
         (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.id) AS updates,
         (SELECT COUNT(*) FROM batch_sites s WHERE s.batch_id = b.id) AS sites
       FROM batches b JOIN rule_versions v ON v.rule_id = b.rule_id AND v.version = b.rule_version
       WHERE b.update_at = ? ORDER BY b.approved_at`,
    )
    .all(update)
    .map((r) => ({
      name: (JSON.parse(String(r.body)) as RuleBody).name,
      updates: Number(r.updates),
      sites: Number(r.sites),
      startsAt: iso(Number(r.starts_at)),
    }));
}

/** Whether a rule's run is due to start now, so the cycle starts the updater. */
export function ruleRunDue(db: Db, now: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM batches b WHERE b.rule_id IS NOT NULL AND b.state = 'approved'
         AND b.starts_at <= ? AND EXISTS (SELECT 1 FROM batch_sites s WHERE s.batch_id = b.id
           AND s.state = 'waiting') LIMIT 1`,
      )
      .get(now) !== undefined
  );
}

/** A run's rule, for its views. */
export function batchRule(db: Db, batchId: string): BatchRule | null {
  const r = db
    .prepare(
      `SELECT b.rule_id, b.rule_version, b.starts_at, v.body FROM batches b
       JOIN rule_versions v ON v.rule_id = b.rule_id AND v.version = b.rule_version WHERE b.id = ?`,
    )
    .get(batchId);
  if (!r) return null;
  return {
    id: String(r.rule_id),
    name: (JSON.parse(String(r.body)) as RuleBody).name,
    version: Number(r.rule_version),
    startsAt: iso(Number(r.starts_at)),
  };
}

/**
 * Pause this run: a rule's run that hasn't started is held, every site of it, and its updates go
 * back to the queue. No passkey: it only stops something. The rule itself carries on next week.
 */
export function pauseRun(db: Db, batchId: string, by: string, at: number): boolean {
  const batch = db.prepare('SELECT rule_id FROM batches WHERE id = ?').get(batchId);
  if (!batch || batch.rule_id === null) return false;
  const waiting = db
    .prepare("SELECT site_id FROM batch_sites WHERE batch_id = ? AND state = 'waiting'")
    .all(batchId);
  if (waiting.length === 0) return false;
  transaction(db, () => {
    for (const s of waiting)
      releaseSite(db, batchId, String(s.site_id), 'Paused by Tyler before it ran', at);
    // Tyler did it: no message about it.
    db.prepare('UPDATE batches SET announced_at = finished_at WHERE id = ?').run(batchId);
    recordEvent(db, at, {
      kind: 'batch.paused',
      summary: `A rule’s run was paused before it started, on ${waiting.length} ${waiting.length === 1 ? 'site' : 'sites'}`,
      resourceType: 'kamaji',
      resourceId: 'updates',
      detail: { batch: batchId, by },
    });
  });
  return true;
}

/**
 * A site of a rule's run that won't run now: held with the reason, and its updates that hadn't
 * started go back to the queue as not run, since nothing carries a rule's run on later.
 */
export function releaseSite(
  db: Db,
  batchId: string,
  siteId: string,
  reason: string,
  at: number,
): void {
  db.prepare(
    `UPDATE batch_sites SET state = 'held', held_reason = ?, finished_at = ?
     WHERE batch_id = ? AND site_id = ? AND state IN ('waiting', 'running')`,
  ).run(reason, at, batchId, siteId);
  db.prepare(
    `UPDATE batch_items SET state = 'done', detail = COALESCE(detail, ?), finished_at = ?
     WHERE batch_id = ? AND site_id = ? AND state IN ('waiting', 'held')`,
  ).run(`Not run: ${reason}`, at, batchId, siteId);
  const open = db
    .prepare("SELECT 1 FROM batch_sites WHERE batch_id = ? AND state IN ('waiting', 'running')")
    .get(batchId);
  if (!open)
    db.prepare("UPDATE batches SET state = 'finished', finished_at = ? WHERE id = ?").run(
      at,
      batchId,
    );
}

/** Queue items a rule would take at its next run, labelled with it. */
export async function labelQueue(
  db: Db,
  items: QueueItem[],
  now: number,
  org: OrgLookup,
): Promise<QueueItem[]> {
  const labels = new Map<string, QueueItem['rule']>();
  const key = (i: { siteId: string; type: string; item: string }) =>
    `${i.siteId}\u0000${i.type}\u0000${i.item}`;
  for (const rule of ruleRows(db)) {
    if (rule.pausedAt !== null) continue;
    const next = updateTimes(now, rule.body.when).next;
    const { takes } = await candidates(db, rule.body, next + VETO_MS, org);
    for (const t of takes)
      if (!labels.has(key(t.item)))
        labels.set(key(t.item), { id: rule.id, name: rule.body.name, at: iso(next + VETO_MS) });
  }
  return items.map((i) => ({ ...i, rule: labels.get(key(i)) ?? null }));
}

/** The Rules page: each rule as a sentence, what it would take next, and what's wrong with it. */
export async function ruleViews(db: Db, now: number, org: OrgLookup): Promise<RuleView[]> {
  const names = new Map(
    db
      .prepare('SELECT id, name FROM sites')
      .all()
      .map((r) => [String(r.id), String(r.name)] as const),
  );
  const time = readUpdateTime(db);
  const views: RuleView[] = [];
  for (const rule of ruleRows(db)) {
    const b = rule.body;
    const next = updateTimes(now, b.when).next;
    const { takes, misses } = await candidates(db, b, next + VETO_MS, org);
    const warnings = b.sites
      .map((s) => siteWarning(db, b, s.id))
      .filter((w): w is string => w !== null);
    if (time.weekday !== b.when.weekday || time.hour !== b.when.hour)
      warnings.push(
        'It was signed for another update time than Kamaji’s now, so its backups won’t line up: sign it again',
      );
    const last = db
      .prepare(
        'SELECT id, approved_at FROM batches WHERE rule_id = ? ORDER BY approved_at DESC LIMIT 1',
      )
      .get(rule.id);
    const autoUpdates = b.sites.flatMap((s) =>
      db
        .prepare(
          `SELECT name, type, slug FROM components WHERE site_id = ? AND gone_at IS NULL
           AND auto_update = 1 AND type IN ('plugin', 'theme') ORDER BY name`,
        )
        .all(s.id)
        .filter(
          (c) =>
            b.types.includes(String(c.type) as 'plugin' | 'theme') &&
            (b.only.length === 0 || b.only.includes(String(c.slug))) &&
            !b.leaveOut.includes(String(c.slug)),
        )
        .map((c) => ({ siteName: names.get(s.id) ?? s.id, name: String(c.name) })),
    );
    views.push({
      id: rule.id,
      version: rule.version,
      body: b,
      words: ruleWords(b, names),
      signedAt: iso(rule.signedAt),
      signedBy: rule.signedBy,
      paused:
        rule.pausedAt === null
          ? null
          : { at: iso(rule.pausedAt), by: rule.pausedBy ?? '', reason: rule.pausedReason ?? '' },
      takes: takes.map(plain),
      misses,
      warnings,
      nextAt: rule.pausedAt === null ? iso(next + VETO_MS) : null,
      lastRun: last
        ? {
            batchId: String(last.id),
            at: iso(Number(last.approved_at)),
            words: runWords(db, String(last.id)),
          }
        : null,
      autoUpdates,
    });
  }
  return views;
}

/** A rule's run in a line: "6 updates on 4 sites: all passed", or where it stopped. */
export function runWords(db: Db, batchId: string): string {
  const items = db
    .prepare('SELECT state, outcome FROM batch_items WHERE batch_id = ?')
    .all(batchId)
    .map((r) => ({
      state: String(r.state),
      outcome: r.outcome === null ? null : String(r.outcome),
    }));
  const sites = db
    .prepare('SELECT state, held_reason FROM batch_sites WHERE batch_id = ?')
    .all(batchId)
    .map((r) => ({
      state: String(r.state),
      reason: r.held_reason === null ? null : String(r.held_reason),
    }));
  const n = items.length;
  const head = `${n} ${n === 1 ? 'update' : 'updates'} on ${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`;
  if (sites.some((s) => s.state === 'waiting' || s.state === 'running'))
    return `${head}: waiting or running`;
  const passed = items.filter((i) => i.outcome === 'passed').length;
  const held = sites.filter((s) => s.state === 'held');
  if (held.length === 0)
    return passed === n ? `${head}: all passed` : `${head}: ${passed} passed, the rest left out`;
  return `${head}: ${passed} passed, held on ${held.length} ${held.length === 1 ? 'site' : 'sites'}`;
}
