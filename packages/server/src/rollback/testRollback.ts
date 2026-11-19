// A site that's had an update run, for the rollback tests: its run, items, snapshot and export,
// and what its latest report says now.
import type { Db } from '../db.js';

export const T = Date.UTC(2026, 10, 19, 3, 0);
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
export const SNAPSHOT = 'a'.repeat(64);

export function site(db: Db, id = 'one.test', host = 'craftish') {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule,
       expected_text, created_at)
     VALUES (?, ?, ?, ?, 'connected', 'done', 1, 'weekly', 'Hello', 0)`,
  ).run(id, id === 'one.test' ? 'One' : id, `https://${id}/`, host);
  if (host === 'kinsta')
    db.prepare(
      `INSERT INTO kinsta_access (site_id, host, port, user, updated_at, updated_by, tested_at, test_ok)
       VALUES (?, '1.2.3.4', 12345, 'one', 0, 'tyler', 0, 1)`,
    ).run(id);
}

/** What the site's latest report has: one row per component. */
export function installed(db: Db, siteId: string, type: string, item: string, version: string) {
  db.prepare(
    `INSERT INTO components (site_id, type, item, name, version, active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0)
     ON CONFLICT (site_id, type, item) DO UPDATE SET version = excluded.version, gone_at = NULL`,
  ).run(siteId, type, item, item === 'core' ? 'WordPress' : item.split('/')[0]!, version);
}

export interface RunItem {
  type: 'core' | 'plugin' | 'theme';
  item: string;
  name?: string;
  from: string;
  to: string;
  outcome?: string;
}

export const AKISMET: RunItem = {
  type: 'plugin',
  item: 'akismet/akismet.php',
  name: 'Akismet',
  from: '5.3',
  to: '5.3.1',
};
export const THEME: RunItem = {
  type: 'theme',
  item: 'twentyx',
  name: 'Twenty X',
  from: '1.6',
  to: '1.6.1',
};
export const CORE: RunItem = {
  type: 'core',
  item: 'core',
  name: 'WordPress',
  from: '7.1.4',
  to: '7.1.5',
};

/** A finished run on the site, its items installed as it left them. */
export function run(
  db: Db,
  o: {
    id?: string;
    siteId?: string;
    at?: number;
    items?: RunItem[];
    state?: 'done' | 'held' | 'waiting' | 'running';
    snapshot?: 'before' | 'relied' | 'old' | 'none' | 'forgotten';
    exportAt?: string | null;
    installs?: boolean;
  } = {},
) {
  const id = o.id ?? 'batch1';
  const siteId = o.siteId ?? 'one.test';
  const at = o.at ?? T;
  const items = o.items ?? [AKISMET, THEME];
  const state = o.state ?? 'done';
  db.prepare(
    `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, finished_at)
     VALUES (?, ?, 'tyler', 0, ?, ?)`,
  ).run(id, at, state === 'waiting' || state === 'running' ? 'running' : 'finished', at + HOUR);
  db.prepare(
    `INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state, started_at, finished_at, baseline)
     VALUES (?, ?, 0, 'kamaji', 'words', ?, ?, ?, ?)`,
  ).run(
    id,
    siteId,
    state,
    at,
    at + HOUR,
    JSON.stringify({ ok: true, problems: [], siteHealth: [] }),
  );
  items.forEach((i, n) => {
    db.prepare(
      `INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version,
         to_version, state, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
    ).run(
      `${id}-${n}`,
      id,
      siteId,
      n,
      i.type,
      i.item,
      i.name ?? i.item,
      i.from,
      i.to,
      i.outcome ?? 'passed',
    );
    if (o.installs !== false)
      installed(db, siteId, i.type, i.item, i.outcome === 'update_failed' ? i.from : i.to);
  });
  const snapshot = o.snapshot ?? 'before';
  if (snapshot !== 'none') {
    const started =
      snapshot === 'old' ? at - 3 * DAY : at - (snapshot === 'relied' ? 5 * HOUR : 10 * 60_000);
    db.prepare(
      `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id, bytes, batch_id, forgotten_at)
       VALUES (?, ?, ?, 1, ?, 1000, ?, ?)`,
    ).run(
      siteId,
      started,
      started + 60_000,
      SNAPSHOT,
      snapshot === 'before' || snapshot === 'forgotten' ? id : null,
      snapshot === 'forgotten' ? T + DAY : null,
    );
  }
  if (o.exportAt)
    db.prepare(
      `INSERT INTO backup_evidence (site_id, batch_id, recorded_at, ok, exported_at, words, kind)
       VALUES (?, ?, ?, 1, ?, 'exported', 'export')`,
    ).run(siteId, id, at, o.exportAt);
  return id;
}
