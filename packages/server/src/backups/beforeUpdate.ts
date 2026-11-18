// Which backup runs before an update (Tyler, 2026-11-17). A site with whole-site backups on gets a
// whole-site snapshot when its latest good one is more than a day old; otherwise the database
// export alone, as before, since a snapshot that recent already holds the files. A site without
// whole-site backups keeps the export.
//
// Kinsta sites (2026-11-18) follow the same rule with their own whole-site backups, pulled over
// SSH (sitebackups/kinsta.ts), not Kinsta's API: a snapshot when the latest is over a day old,
// otherwise that latest snapshot, since Kinsta has no export of Kamaji's to fall back on
// (updater/run.ts).

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
