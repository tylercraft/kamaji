// The Updates queue: what each connected site's WordPress offers, from its last good report,
// for the sites Kamaji can update. Security fixes first, then by site and name.
import type { BackupKind, ComponentType, QueueItem, QueueSite } from '@kamaji/shared';
import type { Db } from '../db.js';
import { latestObservations } from '../observations.js';
import { compareVersions } from '../wordfence/version.js';
import { matches } from '../wordfence/feed.js';

/** The first Craftish Care that can run update jobs. */
export const UPDATES_FROM = '0.2.0';

interface HelloValue {
  ok: boolean;
  hello?: { plugin: string; capabilities: { can_update: boolean; update_blockers: string[] } };
  problem?: string;
}

export interface UpdatableSite {
  id: string;
  name: string;
  url: string;
  hostKind: string;
  backupKind: BackupKind;
  blocked: string | null;
}

/** Connected, set-up sites, and whether Kamaji can update each one now. */
export function updatableSites(db: Db): UpdatableSite[] {
  const rows = db
    .prepare(
      `SELECT id, name, url, host_kind, backup_expectation FROM sites
       WHERE mode = 'connected' AND setup = 'done' AND removed_at IS NULL AND paused_at IS NULL
       ORDER BY name COLLATE NOCASE`,
    )
    .all();
  return rows.map((r) => {
    const id = String(r.id);
    const [hello] = latestObservations<HelloValue>(db, 'site', id, 'hello', 'plugin', 1);
    const h = hello?.value.ok ? hello.value.hello : undefined;
    const blocked = !h
      ? 'No good handshake yet: check the connection on the site’s page'
      : compareVersions(h.plugin, UPDATES_FROM) < 0
        ? `Craftish Care ${h.plugin} can’t update; ${UPDATES_FROM} can`
        : !h.capabilities.can_update
          ? 'The site doesn’t let the plugin update: see the site’s page'
          : null;
    return {
      id,
      name: String(r.name),
      url: String(r.url),
      hostKind: String(r.host_kind),
      backupKind: (r.backup_expectation === null
        ? 'tyler'
        : String(r.backup_expectation)) as BackupKind,
      blocked,
    };
  });
}

/** WordPress's numbering: a change in the first two parts is a major core release. */
export function isMajor(type: ComponentType, from: string, to: string): boolean {
  const parts = (v: string) => v.split(/[.-]/);
  const [a, b] = [parts(from), parts(to)];
  return type === 'core' ? a[0] !== b[0] || a[1] !== b[1] : a[0] !== b[0];
}

/** What's waiting, on every site Kamaji can update or, with `siteId`, on that one only. */
export function queue(
  db: Db,
  siteId?: string,
): { items: QueueItem[]; sites: QueueSite[]; unknown: number } {
  const sites = updatableSites(db).filter((s) => siteId === undefined || s.id === siteId);
  const busy = new Set(
    db
      .prepare("SELECT site_id, type, item FROM batch_items WHERE state != 'done'")
      .all()
      .map((r) => `${String(r.site_id)}\u0000${String(r.type)}\u0000${String(r.item)}`),
  );
  const items: QueueItem[] = [];
  let unknown = 0;
  for (const site of sites) {
    const reported =
      db.prepare('SELECT 1 FROM components WHERE site_id = ? LIMIT 1').get(site.id) !== undefined;
    if (!reported) {
      unknown += 1;
      continue;
    }
    if (site.blocked) continue;
    const fixes = matches(db, site.id).filter((m) => m.fixedIn && !m.vulnerability.informational);
    const offers = db
      .prepare(
        `SELECT type, item, name, version, offer_version FROM components
         WHERE site_id = ? AND gone_at IS NULL AND offer_version IS NOT NULL
         AND offer_package = 1 AND type IN ('core', 'plugin', 'theme')`,
      )
      .all(site.id);
    for (const o of offers) {
      const type = String(o.type) as ComponentType;
      const item = String(o.item);
      if (busy.has(`${site.id}\u0000${type}\u0000${item}`)) continue;
      const from = String(o.version);
      const to = String(o.offer_version);
      items.push({
        siteId: site.id,
        siteName: site.name,
        type,
        item,
        name: String(o.name),
        from,
        to,
        security: fixes.some(
          (m) => m.type === type && m.item === item && compareVersions(to, m.fixedIn!) >= 0,
        ),
        major: isMajor(type, from, to),
      });
    }
  }
  items.sort(
    (a, b) =>
      Number(b.security) - Number(a.security) ||
      a.siteName.localeCompare(b.siteName) ||
      (a.type === 'core' ? -1 : b.type === 'core' ? 1 : 0) ||
      a.name.localeCompare(b.name),
  );
  return {
    items,
    sites: sites.map((s) => ({
      siteId: s.id,
      siteName: s.name,
      backupKind: s.backupKind,
      blocked: s.blocked,
    })),
    unknown,
  };
}
