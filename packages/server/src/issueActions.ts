// No warning without something to do (Tyler's rule). Every kind of issue declares its next step:
// a recheck, which reruns the check through the same route as the button on the site page and
// clears the issue if it passes, or, when Kamaji can't check it again itself, a line saying what
// to look at, and Dismiss. A kind is its family, or its family and a name after a colon
// (crash:<group>, disk:<drive>). raiseIssue only takes a kind from a family listed here, so a new
// kind without an action doesn't compile.
import type { IssueAction } from '@kamaji/shared';

export const ISSUE_FAMILIES = [
  // Sites
  'down',
  'certificate',
  'inventory-stale',
  'vulnerable',
  'abandoned',
  'end-of-life',
  'update-held',
  'backup-failed',
  'backup-overdue',
  'restore-check-failed',
  // Servers: craftish's report, and molcajete's own readers
  'unreadable',
  'security-updates',
  'reboot',
  'stale-updates',
  'services',
  'disk',
  'os-eol',
  'job-missing',
  'job-stopped',
  'job-failed',
  'unmounted',
  'smart',
  'read-only',
  'docker',
  'containers',
  'tailscale',
  'tailscale-health',
  'restarted',
  'repo-pull',
  'macos-updates',
  'crash',
  // Kamaji itself
  'offline',
  'stale',
  'list-stale',
  'feed-stale',
] as const;
export type IssueFamily = (typeof ISSUE_FAMILIES)[number];
export type IssueKind = IssueFamily | `${IssueFamily}:${string}`;

/** The family a stored kind belongs to, or null for one Kamaji no longer raises. */
export function familyOf(kind: string): IssueFamily | null {
  const family = kind.includes(':') ? kind.slice(0, kind.indexOf(':')) : kind;
  return (ISSUE_FAMILIES as readonly string[]).includes(family) ? (family as IssueFamily) : null;
}

interface Of {
  resourceType: string;
  resourceId: string;
  kind: string;
}

const site = (id: string) => `/api/sites/${encodeURIComponent(id)}`;

/** Home page and certificate, for this one site: plain GETs, as the cycle makes. */
const checkAgain = (i: Of): IssueAction => ({
  type: 'recheck',
  label: 'Check again',
  path: `${site(i.resourceId)}/check`,
  body: {},
  asked: 'Checked again',
});
/** A fresh report: the same as Refresh inventory on the site page, then its findings judged. */
const refreshInventory = (i: Of): IssueAction => ({
  type: 'recheck',
  label: 'Refresh inventory',
  path: `${site(i.resourceId)}/report`,
  body: {},
  asked: 'Asked for a fresh report',
});
const backUpNow = (i: Of): IssueAction => ({
  type: 'recheck',
  label: 'Back up now',
  path: `${site(i.resourceId)}/backups/whole-site`,
  body: { kind: 'backup' },
  asked: 'Backup started: this clears when it passes',
});
const look =
  (text: string, href: string | null = null) =>
  (): IssueAction => ({ type: 'look', text, href });
const SERVERS = '/servers';

const ACTIONS: Record<IssueFamily, (issue: Of) => IssueAction> = {
  down: checkAgain,
  certificate: checkAgain,
  'inventory-stale': refreshInventory,
  vulnerable: refreshInventory,
  abandoned: refreshInventory,
  'end-of-life': look('Ask the host or client to upgrade.'),
  'update-held': look('Look at what held it on Updates, then carry on or stop.', '/updates'),
  'backup-failed': backUpNow,
  'backup-overdue': backUpNow,
  'restore-check-failed': (i) => ({
    type: 'recheck',
    label: 'Check restore now',
    path: `${site(i.resourceId)}/backups/whole-site`,
    body: { kind: 'restore' },
    asked: 'Restore check started: this clears when it passes',
  }),
  unreadable: look('See what Kamaji last read, and why it can’t now.', SERVERS),
  'security-updates': look('Install the security updates on the server.', SERVERS),
  reboot: look('Restart the server when nothing is running on it.', SERVERS),
  'stale-updates': look('Install the waiting updates on the server.', SERVERS),
  services: look('Restart the stopped services, or find out why they stopped.', SERVERS),
  disk: look('Free up space on that drive.', SERVERS),
  'os-eol': look('Plan the move to a supported release.', SERVERS),
  'job-missing': look('Load the job again, or remove it if it’s retired.', SERVERS),
  'job-stopped': look('See the job’s log, then start it again.', SERVERS),
  'job-failed': look('See the job’s log for why its last run failed.', SERVERS),
  unmounted: look('Check the drive is plugged in and mounted on molcajete.', SERVERS),
  smart: look('Back up the drive now and plan to replace it.', SERVERS),
  'read-only': look('Check the drive on molcajete: it may need First Aid.', SERVERS),
  docker: look('Open Docker Desktop on molcajete.', SERVERS),
  containers: look('Check the containers in Docker Desktop on molcajete.', SERVERS),
  tailscale: look('Check Tailscale on molcajete.', SERVERS),
  'tailscale-health': look('See what Tailscale reports on molcajete.', SERVERS),
  restarted: look('Nothing to do if it was you; otherwise find out why molcajete restarted.'),
  'repo-pull': look('Check the repo-pull log on molcajete.', SERVERS),
  'macos-updates': look('Install them in System Settings on molcajete.', SERVERS),
  crash: (i) => ({
    type: 'look',
    text: 'See the stack on Servers.',
    href: `/servers#crash-${encodeURIComponent(i.kind.slice('crash:'.length))}`,
  }),
  offline: look('Check molcajete’s internet connection.'),
  stale: look('Check the outside-checks Worker on Cloudflare.'),
  'list-stale': look('Recheck php.net and the vendors, then update Kamaji’s end-of-life list.'),
  'feed-stale': look('Check the Wordfence download: its key, or the network.'),
};

/** An issue's next step. A kind Kamaji no longer raises still gets one: Dismiss. */
export function actionFor(issue: Of): IssueAction {
  const family = familyOf(issue.kind);
  return family ? ACTIONS[family](issue) : look('Kamaji no longer checks this.')();
}

/** Only an issue Kamaji can't check again can be dismissed; one it can clears by passing. */
export const dismissable = (issue: Of) => actionFor(issue).type === 'look';
