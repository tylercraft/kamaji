// One meaning per count: what a site's summary says is "to approve" is exactly what the Updates
// queue lists, offers already in a held or running run are counted apart, and Overview's number
// is the sum of "to approve".
import { readFileSync } from 'node:fs';
import { CareReport } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { storeReport } from './inventory/report.js';
import { recordObservation } from './observations.js';
import { overview, siteSummaries } from './queries.js';
import { testDb } from './testing.js';
import { queue } from './updates/queue.js';

const T = Date.UTC(2026, 10, 13, 0, 0);
const SITE = { id: 'kamaji-wp.ddev.site', name: 'Kamaji test' };
const BASE = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('./inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);
const plugin = (slug: string, offer: { version: string; package: boolean }) => ({
  file: `${slug}/${slug}.php`,
  slug,
  name: slug,
  version: '1.0',
  active: true,
  auto_update: false,
  offer,
});

function site(runState: 'held' | 'running') {
  const db = testDb();
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, 'https://kamaji-wp.ddev.site/', 'craftish', 'connected', 'done', ?)`,
  ).run(SITE.id, SITE.name, T);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: SITE.id,
    check: 'hello',
    source: 'plugin',
    at: T,
    ok: true,
    value: {
      ok: true,
      hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
    },
  });
  // The fixture's own offer (Akismet), plus one in a run and one without a download.
  const r = structuredClone(BASE);
  r.plugins.push(plugin('forms', { version: '1.1', package: true }));
  r.plugins.push(plugin('pro', { version: '2.0', package: false }));
  storeReport(db, SITE, r, T);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: SITE.id,
    check: 'report',
    source: 'plugin',
    at: T,
    ok: true,
    value: { ok: true, refreshed: true },
  });
  db.prepare(
    "INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES ('b', ?, 't', 0, 'running')",
  ).run(T);
  db.prepare(
    `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, state)
     VALUES ('b', ?, 0, 'kamaji', ?)`,
  ).run(SITE.id, runState);
  db.prepare(
    `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version,
       to_version, state) VALUES ('i', 'b', ?, 0, 'plugin', 'forms/forms.php', 'forms', '1.0', '1.1', ?)`,
  ).run(SITE.id, runState === 'held' ? 'held' : 'running');
  return db;
}

describe('update counts', () => {
  it('keeps to approve, held and download-less apart, and to approve matches the queue', () => {
    const db = site('held');
    const s = siteSummaries(db).find((x) => x.id === SITE.id)!;
    expect(s.updates).toEqual({ known: true, value: 3 });
    expect(s.updateWork).toEqual({ toApprove: 1, held: 1, running: 0, noDownload: 1 });
    expect(queue(db, SITE.id).items.map((i) => i.name)).toHaveLength(s.updateWork.toApprove);
    expect(overview(db).updatesWaiting).toEqual({ known: true, value: 1 });
  });

  it('counts an item of a run still going as running, not held', () => {
    const s = siteSummaries(site('running')).find((x) => x.id === SITE.id)!;
    expect(s.updateWork).toMatchObject({ held: 0, running: 1 });
  });
});
