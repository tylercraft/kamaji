// The checks after a rollback or undo, run by the updater, which holds the Care keys: the same
// checks as after an update (updater/run.ts, runChecks), against the Site Health the run started
// from, plus a fresh report that each item is at the version it should now be. Then the uptime
// pause ends and the site is checked from the mini and from outside at once.
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import {
  freshReport,
  installedVersion,
  resume,
  runChecks,
  siteRow,
  type UpdaterDeps,
} from '../updater/run.js';
import { rollbackItems } from './offer.js';

const count = (n: number) => `${n} ${n === 1 ? 'update' : 'updates'}`;

/** Site Health's critical items before the run, which aren't counted against the rollback. */
function healthBefore(db: Db, batchId: string, siteId: string): string[] {
  const raw = db
    .prepare('SELECT baseline FROM batch_sites WHERE batch_id = ? AND site_id = ?')
    .get(batchId, siteId)?.baseline;
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(String(raw)) as { siteHealth?: unknown };
    return Array.isArray(parsed.siteHealth) ? parsed.siteHealth.map(String) : [];
  } catch {
    return [];
  }
}

export async function checkRollbacks(deps: UpdaterDeps): Promise<void> {
  const { db } = deps;
  const rows = db
    .prepare(
      `SELECT * FROM rollbacks WHERE state IN ('done', 'failed') AND checked_at IS NULL
       ORDER BY finished_at`,
    )
    .all();
  for (const r of rows) {
    if (deps.signal.aborted) return;
    const id = String(r.id);
    const siteId = String(r.site_id);
    const site = siteRow(db, siteId);
    const items = rollbackItems(db, id);
    const problems: string[] = [];
    let ok: boolean;
    try {
      const report = await freshReport(deps, site);
      const health = report?.site_health.map((h) => h.label) ?? [];
      const checks = await runChecks(
        deps,
        site,
        health,
        healthBefore(db, String(r.batch_id), siteId),
      );
      problems.push(...checks.problems);
      if (!report) problems.push('the plugin didn’t report, so the versions aren’t confirmed');
      // The swap may have stopped part way, so each item is checked, whatever the push said.
      else if (r.changed === 'files' || r.changed === 'all')
        for (const i of items) {
          const installed = installedVersion(report, i);
          if (installed !== i.back)
            problems.push(`${i.name} is at ${installed ?? 'nothing'}, not ${i.back}`);
        }
      ok = problems.length === 0;
    } finally {
      await resume(deps, site);
    }
    const at = deps.now();
    db.prepare(
      'UPDATE rollbacks SET checked_at = ?, checks_ok = ?, checks_problem = ? WHERE id = ?',
    ).run(at, ok ? 1 : 0, ok ? null : problems.join('; '), id);
    const what = r.kind === 'undo' ? 'Undid the rollback of' : 'Rolled back';
    const finished =
      r.changed === 'all' || (r.changed === 'files' && Number(r.with_database) === 0);
    recordEvent(db, at, {
      kind: finished && ok ? 'site.rollback' : 'site.rollback-failed',
      summary: finished
        ? `${what} ${site.name}: ${items.map((i) => `${i.name} ${i.now} → ${i.back}`).join(', ')}${Number(r.with_database) === 1 ? ', with the database' : ''}; ${ok ? 'checks passed' : `checks failed (${problems.join('; ')})`}`
        : `${r.kind === 'undo' ? 'The undo of the rollback of' : 'The rollback of'} ${site.name} stopped at “${String(r.step)}”: ${String(r.problem ?? 'it failed')}. Checks ${ok ? 'passed' : `failed (${problems.join('; ')})`}`,
      resourceType: 'site',
      resourceId: siteId,
      detail: { rollback: id, items: count(items.length) },
    });
    deps.log(`updater: ${site.name}: ${String(r.kind)} checked, ${ok ? 'passed' : 'failed'}`);
  }
}
