// A site's backup evidence (calcifer explore/kamaji.md, "Backup evidence"): what Kamaji recorded,
// and only that. The exports themselves stay on craftish; this never lists or reads them.
import type { BackupEntry, SiteBackupsResponse } from '@kamaji/shared';
import type { Db } from '../db.js';

const iso = (ms: number) => new Date(ms).toISOString();

/** What the export answered (updater/backup.ts), when it did. */
export interface ExportAnswer {
  at: string;
  bytes: number;
  sha256: string;
}

export function recordEvidence(
  db: Db,
  evidence: {
    siteId: string;
    batchId: string | null;
    requestedBy: string | null;
    at: number;
    ok: boolean;
    words: string;
    answer?: ExportAnswer | undefined;
  },
): void {
  db.prepare(
    `INSERT INTO backup_evidence
       (site_id, batch_id, requested_by, recorded_at, ok, exported_at, bytes, sha256, words)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidence.siteId,
    evidence.batchId,
    evidence.requestedBy,
    evidence.at,
    evidence.ok ? 1 : 0,
    evidence.answer?.at ?? null,
    evidence.answer?.bytes ?? null,
    evidence.answer?.sha256 ?? null,
    evidence.words,
  );
}

/**
 * Newest first: every export attempt, and each run's recorded words where no export of that run
 * succeeded (a host's or client's backup, Tyler's word, a carry-on, or a run from before exports
 * were kept apart).
 */
export function backupHistory(db: Db, siteId: string): BackupEntry[] {
  const exports: BackupEntry[] = db
    .prepare(
      `SELECT e.*, b.approved_at FROM backup_evidence e LEFT JOIN batches b ON b.id = e.batch_id
       WHERE e.site_id = ? ORDER BY e.recorded_at DESC, e.id DESC`,
    )
    .all(siteId)
    .map((r) => ({
      recordedAt: iso(Number(r.recorded_at)),
      state: Number(r.ok) === 1 ? 'exported' : 'failed',
      batchId: r.batch_id === null ? null : String(r.batch_id),
      runApprovedAt: r.approved_at === null ? null : iso(Number(r.approved_at)),
      exportedAt: r.exported_at === null ? null : new Date(String(r.exported_at)).toISOString(),
      bytes: r.bytes === null ? null : Number(r.bytes),
      sha256: r.sha256 === null ? null : String(r.sha256),
      words: String(r.words),
    }));
  const runs: BackupEntry[] = db
    .prepare(
      `SELECT bs.batch_id, bs.backup, b.approved_at, COALESCE(bs.started_at, b.approved_at) AS at
       FROM batch_sites bs JOIN batches b ON b.id = bs.batch_id
       WHERE bs.site_id = ? AND bs.backup IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM backup_evidence e
         WHERE e.batch_id = bs.batch_id AND e.site_id = bs.site_id AND e.ok = 1)`,
    )
    .all(siteId)
    .map((r) => ({
      recordedAt: iso(Number(r.at)),
      state: 'recorded',
      batchId: String(r.batch_id),
      runApprovedAt: iso(Number(r.approved_at)),
      exportedAt: null,
      bytes: null,
      sha256: null,
      words: String(r.backup),
    }));
  return [...exports, ...runs].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function siteBackups(
  db: Db,
  site: {
    id: string;
    hostKind: string;
    backupExpectation: SiteBackupsResponse['backupExpectation'];
  },
  exportingSince: number | undefined,
): SiteBackupsResponse {
  const history = backupHistory(db, site.id);
  return {
    backupExpectation: site.backupExpectation,
    canExport: site.hostKind === 'craftish',
    exporting: exportingSince === undefined ? null : iso(exportingSince),
    latest:
      history.find((e) => e.state === 'exported') ??
      history.find((e) => e.state === 'recorded') ??
      null,
    history,
  };
}
