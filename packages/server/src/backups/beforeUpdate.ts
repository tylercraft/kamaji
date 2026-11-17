// Which backup runs before an update (Tyler, 2026-11-17). A site with whole-site backups on gets a
// whole-site snapshot when its latest good one is more than a day old; otherwise the database
// export alone, as before, since a snapshot that recent already holds the files. A site without
// whole-site backups keeps the export.
//
// The rule is the host's as much as ours: when Kamaji takes Kinsta's backups itself (its API, not
// built yet: Kinsta's own daily backups are recorded as the host's), the same call decides
// whether that site needs a fresh one before an update, from the time of Kinsta's latest.

export const FRESH_FOR = 24 * 60 * 60_000;

/** True when the latest good full backup is missing or more than a day old. */
export function needsFreshBackup(latestGoodAt: number | null, now: number): boolean {
  return latestGoodAt === null || now - latestGoodAt > FRESH_FOR;
}

/** The words that start an update's backup record, and the Backups panel's label for it. */
export const BEFORE_UPDATE = {
  snapshot: 'Whole-site backup before update',
  export: 'Database export before update',
} as const;
