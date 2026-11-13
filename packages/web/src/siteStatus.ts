// What a site's Status tab says, one line per question, from data the page already has. Kept
// apart from the components so the distinctions it draws are tested:
//   - reachable is only that the home page answered; it isn't the site's health;
//   - "none known" needs vulnerability data and a current report, else it says not checked;
//   - an export is Kamaji's database copy, a whole-site backup is files and database;
//   - a backup Tyler, the host or the client vouches for is recorded, not made or checked by Kamaji;
//   - a check that passed long ago reads as out of date, never as a current pass.
import type {
  Inventory,
  SiteBackupsResponse,
  SiteDetailResponse,
  SiteSummary,
  VulnerabilityMatch,
} from '@kamaji/shared';
import type { Tone } from './components/ui';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * How old a check can be and still count as current: three of its intervals. The home page
 * checks (the mini's cycle and the Worker's cron) run every 5 minutes, reports hourly, server
 * reads each cycle. A restore check runs once a month per site, one site a night.
 */
export const CURRENT_FOR = {
  pageCheck: 15 * MIN,
  report: 3 * 60 * MIN,
  serverRead: 15 * MIN,
  restoreCheck: 45 * DAY,
} as const;

export const isOutOfDate = (iso: string, limitMs: number, now: number): boolean =>
  now - Date.parse(iso) > limitMs;

export interface StatusLine {
  /** What the line answers: "Home page", "Security". */
  label: string;
  tone: Tone;
  /** The answer, short: "Reachable", "None known". */
  state: string;
  detail: string;
  /** When it was last checked or happened, shown as a time. */
  at: string | null;
  /** The check behind it is older than it should be: shown beside the time. */
  outOfDate: boolean;
}

const line = (
  label: string,
  tone: Tone,
  state: string,
  detail: string,
  at: string | null = null,
  outOfDate = false,
): StatusLine => ({ label, tone, state, detail, at, outOfDate });

/** The mini's home page check. Passing means it answered (with the expected text, if set). */
export function homePage(site: SiteSummary, now: number): StatusLine {
  const label = 'Home page';
  if (site.pausedAt) return line(label, 'neutral', 'Paused', 'Checks are paused.', site.pausedAt);
  const a = site.availability;
  if (!a.known) return line(label, 'neutral', 'Not checked yet', a.reason);
  const v = a.value;
  const old = isOutOfDate(v.checkedAt, CURRENT_FOR.pageCheck, now);
  if (v.state === 'up') {
    const content = site.expectedText
      ? `It contained “${site.expectedText}”.`
      : 'No expected text is set, so its content isn’t checked.';
    const speed = v.responseMs === null ? 'It answered.' : `It answered in ${v.responseMs} ms.`;
    return line(
      label,
      old ? 'neutral' : 'green',
      old ? 'Last reachable' : 'Reachable',
      `${speed} ${content}`,
      v.checkedAt,
      old,
    );
  }
  return line(
    label,
    v.state === 'down' ? 'red' : 'amber',
    v.state === 'down' ? 'Down' : 'Failed once',
    v.problem ?? 'The check failed.',
    v.checkedAt,
    old,
  );
}

/** The Worker's check of the same page, from Cloudflare's network. */
export function fromOutside(site: SiteSummary, now: number): StatusLine {
  const label = 'From outside';
  const o = site.outside;
  if (!o.known) return line(label, 'neutral', 'Not checked', o.reason);
  const old = isOutOfDate(o.value.checkedAt, CURRENT_FOR.pageCheck, now);
  if (o.value.ok)
    return line(
      label,
      old ? 'neutral' : 'green',
      old ? 'Last reachable' : 'Reachable',
      'Cloudflare’s network reached the home page too.',
      o.value.checkedAt,
      old,
    );
  return line(
    label,
    'red',
    'Failing',
    o.value.problem ?? 'The check failed.',
    o.value.checkedAt,
    old,
  );
}

export function certificate(site: SiteSummary): StatusLine {
  const label = 'Certificate';
  const c = site.certificate;
  // A check that failed says how; a timeout doesn't mean the certificate is bad.
  if (!c.known)
    return c.reason === 'Not read yet'
      ? line(label, 'neutral', 'Not checked yet', 'The first check is pending.')
      : line(
          label,
          'amber',
          /^No answer within/.test(c.reason) ? 'Check timed out' : 'Check failed',
          `${c.reason}. That alone doesn’t mean the certificate is bad.`,
        );
  const days = c.value.daysLeft;
  const left = `${days} ${days === 1 ? 'day' : 'days'} left.`;
  if (days < 0) return line(label, 'red', 'Expired', 'Visitors see a warning.', c.value.checkedAt);
  if (c.value.problem)
    return line(
      label,
      'red',
      c.value.problem,
      `${left} Visitors may see a warning.`,
      c.value.checkedAt,
    );
  if (days <= 7) return line(label, 'red', 'Expiring', left, c.value.checkedAt);
  if (days <= 14) return line(label, 'amber', 'Expiring soon', left, c.value.checkedAt);
  return line(label, 'green', 'Valid', left, c.value.checkedAt);
}

/** Known, non-informational vulnerabilities in core, plugins and themes, with what they're in. */
export function findings(inventory: Inventory): { name: string; v: VulnerabilityMatch }[] {
  const all = [
    ...inventory.core.vulnerabilities.map((v) => ({ name: 'WordPress', v })),
    ...inventory.plugins.flatMap((p) => p.vulnerabilities.map((v) => ({ name: p.name, v }))),
    ...inventory.themes.flatMap((t) => t.vulnerabilities.map((v) => ({ name: t.name, v }))),
  ];
  return all.filter((f) => !f.v.informational);
}

/** Wordfence's general notes ("all known versions"): shown, never counted as a finding. */
export function informationalCount(inventory: Inventory): number {
  return [
    ...inventory.core.vulnerabilities,
    ...inventory.plugins.flatMap((p) => p.vulnerabilities),
    ...inventory.themes.flatMap((t) => t.vulnerabilities),
  ].filter((v) => v.informational).length;
}

/** Security findings. "None known" only with vulnerability data and a report that's current. */
export function security(detail: SiteDetailResponse, now: number): StatusLine {
  const label = 'Security';
  if (detail.site.mode !== 'connected')
    return line(
      label,
      'neutral',
      'Not checked',
      'Monitoring only: Kamaji can’t see this site’s plugins or themes.',
    );
  if (!detail.inventory.known)
    return line(label, 'neutral', 'Not checked', detail.inventory.reason);
  const inv = detail.inventory.value;
  if (!inv.vulnerabilityData.known)
    return line(label, 'neutral', 'Not checked', inv.vulnerabilityData.reason);
  const old = isOutOfDate(inv.reportedAt, CURRENT_FOR.report, now);
  const found = findings(inv);
  const informational = informationalCount(inv);
  const none = informational > 0 ? 'No actionable findings' : 'None known';
  const info =
    informational > 0
      ? ` ${informational} informational ${informational === 1 ? 'note' : 'notes'}, shown under Software.`
      : '';
  if (found.length > 0) {
    const names = [...new Set(found.map((f) => f.name))];
    const fixable = found.filter((f) => f.v.fixedIn).length;
    return line(
      label,
      'red',
      `${found.length} known ${found.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
      `In ${names.join(', ')}. ${
        fixable === found.length
          ? 'Each has a fixed version.'
          : `${fixable} of ${found.length} have a fixed version.`
      }`,
      inv.reportedAt,
      old,
    );
  }
  const mu =
    inv.muPlugins.known && inv.muPlugins.value.length > 0
      ? ' Must-use plugins aren’t checked.'
      : '';
  if (inv.vulnerabilityData.value.stale)
    return line(
      label,
      'amber',
      `${none}, data out of date`,
      `Kamaji’s Wordfence data is out of date${
        inv.vulnerabilityData.value.problem ? `: ${inv.vulnerabilityData.value.problem}` : ''
      }.${info}${mu}`,
      inv.reportedAt,
      old,
    );
  if (old)
    return line(
      label,
      'neutral',
      `${none} at last report`,
      `The site hasn’t reported since, so this isn’t current.${info}${mu}`,
      inv.reportedAt,
      true,
    );
  return line(
    label,
    'green',
    none,
    `Its last report, matched against Wordfence’s list.${info}${mu}`,
    inv.reportedAt,
  );
}

/** Where a site's offered updates stand, in the same words on every page: "1 to approve · 1 held". */
export function workWords(w: SiteSummary['updateWork']): string {
  return [
    w.toApprove > 0 && `${w.toApprove} to approve`,
    w.held > 0 && `${w.held} held`,
    w.running > 0 && `${w.running} running`,
    w.noDownload > 0 && `${w.noDownload} without a download`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A held update needs Tyler; one to approve is waiting on him; one running is in hand. */
export function workTone(w: SiteSummary['updateWork']): Tone {
  if (w.held > 0) return 'red';
  if (w.toApprove > 0 || w.noDownload > 0) return 'amber';
  return 'neutral';
}

export function updates(site: SiteSummary): StatusLine {
  const label = 'Updates';
  if (site.mode !== 'connected')
    return line(label, 'neutral', 'Not checked', 'Monitoring only: needs Craftish Care.');
  if (!site.updates.known) return line(label, 'neutral', 'Not known yet', site.updates.reason);
  const words = workWords(site.updateWork);
  if (words === '')
    return line(label, 'green', 'None offered', 'WordPress offers no updates here.');
  const n = site.updates.value;
  return line(
    label,
    workTone(site.updateWork),
    words,
    `WordPress offers ${n} ${n === 1 ? 'update' : 'updates'}; review them under Updates.`,
  );
}

const VOUCHED: Record<'host' | 'client' | 'tyler', string> = {
  host: 'The host backs this site up.',
  client: 'The client backs this site up.',
  tyler: 'You confirm a backup before each run.',
};

export const STEP_WORDS: Record<string, string> = {
  restore: 'restoring the snapshot',
  verify: 'checking it against its manifest',
  unpack: 'unpacking it',
  docker: 'starting Docker',
  database: 'loading the database',
  wordpress: 'starting WordPress',
  'home page': 'fetching the home page',
};

export const SCHEDULE_DAYS = { weekly: 7, fortnightly: 14 } as const;
export const OVERDUE_GRACE = 2 * DAY;

/**
 * Backups, a line per kind: Kamaji's database export, a backup someone else vouches for, the
 * whole-site backup and its restore check. Kinds that don't apply to the site are left out.
 */
export function backups(b: SiteBackupsResponse, now: number): StatusLine[] {
  const lines: StatusLine[] = [];
  const exports = b.history.filter((e) => e.state !== 'recorded');
  const lastExport = exports.find((e) => e.state === 'exported');

  if (b.backupExpectation === null)
    lines.push(
      line('Backups', 'amber', 'Not set', 'Choose how this site is backed up under Configure.'),
    );
  else if (b.backupExpectation !== 'kamaji') {
    const vouched = b.history.find((e) => e.state === 'recorded');
    lines.push(
      line(
        'Backups',
        'neutral',
        'Not made by Kamaji',
        `${VOUCHED[b.backupExpectation]} Kamaji records that before each run but doesn’t see or check the backup.`,
        vouched?.recordedAt ?? null,
      ),
    );
  }

  if (b.canExport || exports.length > 0) {
    const label = 'Database export';
    const newest = exports[0];
    if (!lastExport)
      lines.push(
        newest
          ? line(label, 'red', 'Failed', newest.words, newest.recordedAt)
          : line(
              label,
              'neutral',
              'None yet',
              'Database only. Made before each run, or with Back up now.',
            ),
      );
    else if (newest && newest !== lastExport)
      lines.push(
        line(
          label,
          'amber',
          'Last attempt failed',
          `${newest.words}. The last good export is older.`,
          newest.recordedAt,
        ),
      );
    else
      lines.push(
        line(
          label,
          'green',
          'Exported by Kamaji',
          'Database only, kept on craftish for 14 days.',
          lastExport.exportedAt ?? lastExport.recordedAt,
        ),
      );
  }

  const w = b.wholeSite;
  if (w) {
    const label = 'Whole-site backup';
    if (w.schedule === 'off' || !w.active)
      lines.push(
        line(
          label,
          'neutral',
          'Off',
          w.schedule === 'off'
            ? 'Files and database aren’t backed up by Kamaji.'
            : 'Waiting for the client’s agreement under Configure.',
        ),
      );
    else {
      const newest = w.snapshots[0];
      const overdue =
        w.lastGoodAt !== null &&
        now - Date.parse(w.lastGoodAt) > SCHEDULE_DAYS[w.schedule] * DAY + OVERDUE_GRACE;
      if (w.lastGoodAt === null)
        lines.push(
          newest && !newest.ok
            ? line(label, 'red', 'Failed', newest.problem ?? 'The backup failed.', newest.startedAt)
            : line(label, 'neutral', 'None yet', 'The first runs tonight at 03:15.'),
        );
      else if (newest && !newest.ok)
        lines.push(
          line(
            label,
            'red',
            'Last attempt failed',
            `${newest.problem ?? 'The backup failed'}. The last good one is older.`,
            newest.startedAt,
          ),
        );
      else
        lines.push(
          line(
            label,
            overdue ? 'amber' : 'green',
            overdue ? 'Overdue' : 'Backed up by Kamaji',
            'Files and database, read back and checked after each run.',
            w.lastGoodAt,
            overdue,
          ),
        );

      const check = w.restoreChecks[0];
      if (!check)
        lines.push(line('Restore check', 'neutral', 'Not run yet', 'One a month, or ask for one.'));
      else if (!check.ok)
        lines.push(
          line(
            'Restore check',
            'red',
            'Failed',
            `While ${STEP_WORDS[check.failedStep ?? ''] ?? check.failedStep ?? 'at an unknown step'}: ${
              check.problem ?? 'it failed'
            }.`,
            check.startedAt,
          ),
        );
      else {
        const old = isOutOfDate(check.startedAt, CURRENT_FOR.restoreCheck, now);
        lines.push(
          line(
            'Restore check',
            old ? 'neutral' : 'green',
            old ? 'Passed, out of date' : 'Passed',
            `Restored to an offline test copy that served its home page, in ${check.seconds} s.`,
            check.startedAt,
            old,
          ),
        );
      }
    }
  }
  return lines;
}
