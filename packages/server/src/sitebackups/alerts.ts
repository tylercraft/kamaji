// Whole-site backups as issues (issues.ts), so they reach Tyler the way every other problem does
// (notify.ts): a failed backup, a snapshot that didn't read back and a failed restore check are
// urgent, sent to Discord at once and cleared by the next one that works; a backup overdue by 2
// days is normal, for the morning digest. The backups process raises the first two; the app's
// cycle looks for overdue ones, so a process that never runs at all is noticed too.
import type { Db } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { eligible } from './eligible.js';

const DAY = 24 * 60 * 60_000;
export const BACKUP_FAILED = 'backup-failed';
export const RESTORE_FAILED = 'restore-check-failed';
export const BACKUP_OVERDUE = 'backup-overdue';
/** A week or a fortnight from the last good backup, then 2 days' grace. */
export const SCHEDULE_DAYS = { weekly: 7, fortnightly: 14 } as const;
export const OVERDUE_GRACE = 2 * DAY;

const key = (siteId: string, kind: string) => ({
  resourceType: 'site' as const,
  resourceId: siteId,
  kind,
});

export function backupFailed(db: Db, now: number, siteId: string, summary: string): void {
  raiseIssue(db, now, { ...key(siteId, BACKUP_FAILED), severity: 'urgent', summary });
}

export function backupWorked(db: Db, now: number, siteId: string, name: string): void {
  clearIssue(db, now, key(siteId, BACKUP_FAILED), `Whole-site backups of ${name} work again`);
  clearIssue(db, now, key(siteId, BACKUP_OVERDUE), `${name} has a fresh whole-site backup`);
}

export function restoreFailed(db: Db, now: number, siteId: string, summary: string): void {
  raiseIssue(db, now, { ...key(siteId, RESTORE_FAILED), severity: 'urgent', summary });
}

export function restoreWorked(db: Db, now: number, siteId: string, name: string): void {
  clearIssue(db, now, key(siteId, RESTORE_FAILED), `${name} restores again`);
}

/**
 * Each cycle: a site with whole-site backups on, past its week or fortnight by 2 days, is
 * overdue; one never backed up counts from when its schedule was last set. A site whose backups
 * are off (or that left craftish) has its backup issues cleared.
 */
export function checkBackupsOverdue(db: Db, now: number): void {
  const sites = db
    .prepare(
      `SELECT s.id, s.name, s.site_backup_schedule AS schedule,
         (SELECT MAX(started_at) FROM site_snapshots WHERE site_id = s.id AND ok = 1) AS last,
         (SELECT MAX(at) FROM events WHERE resource_type = 'site' AND resource_id = s.id
            AND kind = 'site.backup-schedule') AS set_at
       FROM sites s WHERE s.removed_at IS NULL`,
    )
    .all();
  for (const s of sites) {
    const id = String(s.id);
    const name = String(s.name);
    if (!eligible(db, id)) {
      for (const kind of [BACKUP_FAILED, RESTORE_FAILED, BACKUP_OVERDUE])
        clearIssue(db, now, key(id, kind), `Whole-site backups of ${name} are off`);
      continue;
    }
    const since = s.last !== null ? Number(s.last) : s.set_at !== null ? Number(s.set_at) : null;
    if (since === null) continue;
    const days = SCHEDULE_DAYS[String(s.schedule) as keyof typeof SCHEDULE_DAYS];
    const late = now - (since + days * DAY);
    if (late <= OVERDUE_GRACE) {
      clearIssue(db, now, key(id, BACKUP_OVERDUE), `${name}’s whole-site backup is back on time`);
      continue;
    }
    const ago = Math.floor((now - since) / DAY);
    raiseIssue(db, now, {
      ...key(id, BACKUP_OVERDUE),
      severity: 'normal',
      summary:
        s.last !== null
          ? `${name}’s whole-site backup is overdue: the last good one was ${ago} days ago`
          : `${name} has no whole-site backup yet, ${ago} days after they were turned on`,
    });
  }
}
