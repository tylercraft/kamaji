// Which sites' whole-site backups are on: shared by the process, the app and its alerts.
import type { Db } from '../db.js';

/** Sites whose whole-site backups are on: on craftish, and Tyler's own or the client agreed. */
export const ELIGIBLE = `removed_at IS NULL AND host_kind = 'craftish' AND site_backup_schedule != 'off'
  AND (own = 1 OR site_backup_consent_at IS NOT NULL)`;

export function eligible(db: Db, siteId: string): boolean {
  return db.prepare(`SELECT 1 FROM sites WHERE id = ? AND ${ELIGIBLE}`).get(siteId) !== undefined;
}
