// Ready to update's header, from the sites still waiting only (Tyler, 2026-11-18): a site updated
// since the update time with nothing left shows only when, so an old failure there doesn't count.
import type { ReadySite, ReadyToUpdate } from '@kamaji/shared';

/** Updated since the update time with nothing left: its backup no longer matters here. */
export const doneSite = (site: ReadySite): site is ReadySite & { updatedAt: string } =>
  site.updates.length === 0 && site.updatedAt !== null;

/** How many failed and what, in words ("A whole-site backup"), and how many updates wait. */
export function readyHeader(ready: ReadyToUpdate): {
  failed: number;
  what: string;
  waiting: number;
} {
  const sites = ready.sites.filter((s) => !doneSite(s));
  const failedSites = sites.filter((s) => s.backup.state === 'failed');
  const failed = failedSites.length;
  const restores = failedSites.filter(
    (s) => s.backup.state === 'failed' && s.backup.step === 'restore',
  ).length;
  const what =
    restores === failed
      ? failed === 1
        ? 'A restore check'
        : `${failed} restore checks`
      : restores === 0
        ? failed === 1
          ? 'A whole-site backup'
          : `${failed} whole-site backups`
        : `${failed} backups or restore checks`;
  return { failed, what, waiting: sites.reduce((n, s) => n + s.updates.length, 0) };
}
