// Which sites' whole-site backups are on: shared by the process, the app and its alerts.
import type { Db } from '../db.js';

/**
 * Sites whose whole-site backups are on: on craftish, or on Kinsta with its SSH access saved
 * (kinsta.ts), and Tyler's own or the client agreed. A Kinsta site's first pull also waits on a
 * good test and, over 20 GB, Tyler's okay (run.ts).
 */
export const ELIGIBLE = `removed_at IS NULL AND site_backup_schedule != 'off'
  AND (host_kind = 'craftish' OR (host_kind = 'kinsta' AND id IN (SELECT site_id FROM kinsta_access)))
  AND (own = 1 OR site_backup_consent_at IS NOT NULL)`;

/** Hosts whole-site backups can pull from. */
export const PULL_HOSTS = ['craftish', 'kinsta'] as const;
export type PullHost = (typeof PULL_HOSTS)[number];

export function eligible(db: Db, siteId: string): boolean {
  return db.prepare(`SELECT 1 FROM sites WHERE id = ? AND ${ELIGIBLE}`).get(siteId) !== undefined;
}

/** Where a site's whole-site backups pull from, if anywhere. */
export function pullHost(db: Db, siteId: string): PullHost | null {
  const kind = db.prepare('SELECT host_kind FROM sites WHERE id = ?').get(siteId)?.host_kind;
  return (PULL_HOSTS as readonly unknown[]).includes(kind) ? (kind as PullHost) : null;
}
