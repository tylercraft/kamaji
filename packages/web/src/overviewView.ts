// What Overview says beyond the open issues: recent outcomes (finished update runs, whole-site
// backups and restore checks, from records Kamaji already keeps) and findings grouped by what
// they're about. Each outcome links to its record.
import type { ActivityEvent, BatchView, Issue } from '@kamaji/shared';
import type { Tone } from './components/ui';
import { runAnchor, runOutcome } from './runHistory';

export interface Outcome {
  key: string;
  title: string;
  detail: string;
  tone: Tone;
  label: string;
  at: string;
  /** What the time is: a run's finish, or when the event was recorded. */
  atWords: string;
  href: string;
}

const OUTCOME_KINDS: Record<string, [string, Tone]> = {
  'site.backup': ['Backed up', 'green'],
  'site.backup-failed': ['Backup failed', 'red'],
  'site.restore-check': ['Restore check passed', 'green'],
  'site.restore-check-failed': ['Restore check failed', 'red'],
};

const RANK: Record<Tone, number> = { red: 0, amber: 1, copper: 2, neutral: 3, green: 4 };

function runOutcomes(batches: BatchView[]): Outcome[] {
  return batches
    .filter((b) => b.state === 'finished' && b.sites.length > 0)
    .map((b) => {
      const outcomes = b.sites.map(runOutcome);
      const worst = [...outcomes].sort((x, y) => RANK[x.tone] - RANK[y.tone])[0]!;
      const changes = [
        ...new Set(b.sites.flatMap((s) => s.items.map((i) => `${i.name} ${i.from} → ${i.to}`))),
      ];
      const names = b.sites.map((s) => s.siteName);
      const n = b.sites.length;
      const title =
        changes.length === 1
          ? `${changes[0]!.split(' ').slice(0, -3).join(' ')} updated on ${n} ${n === 1 ? 'site' : 'sites'}`
          : `${b.sites.reduce((k, s) => k + s.items.length, 0)} updates on ${n} ${n === 1 ? 'site' : 'sites'}`;
      return {
        key: `run-${b.id}`,
        title,
        detail: `${names.join(', ')}${changes.length === 1 ? ` · ${changes[0]!.split(' ').slice(-3).join(' ')}` : ''}`,
        tone: worst.tone,
        label: worst.tone === 'green' ? 'Checks passed' : worst.label,
        at: b.finishedAt ?? b.approvedAt,
        atWords: b.finishedAt ? 'Finished' : 'Approved',
        href: `/updates#${runAnchor({ batchId: b.id, siteId: b.sites[0]!.siteId })}`,
      };
    });
}

function eventOutcomes(events: ActivityEvent[]): Outcome[] {
  return events
    .filter((e) => OUTCOME_KINDS[e.kind] && e.resourceType === 'site' && e.resourceId)
    .map((e) => {
      const [label, tone] = OUTCOME_KINDS[e.kind]!;
      return {
        key: `event-${e.id}`,
        title: e.summary,
        detail: '',
        tone,
        label,
        at: e.at,
        atWords: 'Recorded',
        href: `/sites/${encodeURIComponent(e.resourceId!)}#backups`,
      };
    });
}

/** The newest outcomes, runs and backups together. */
export function recentOutcomes(
  batches: BatchView[],
  events: ActivityEvent[],
  count = 6,
): Outcome[] {
  return [...runOutcomes(batches), ...eventOutcomes(events)]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, count);
}

/** Open issues grouped by what they're about, most urgent group first, oldest issue first. */
export function groupIssues(issues: Issue[]) {
  const groups = new Map<string, { type: Issue['resourceType']; id: string; issues: Issue[] }>();
  for (const i of issues) {
    const key = `${i.resourceType}:${i.resourceId}`;
    const g = groups.get(key) ?? { type: i.resourceType, id: i.resourceId, issues: [] };
    g.issues.push(i);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      issues: [...g.issues].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt)),
    }))
    .sort(
      (a, b) =>
        Number(b.issues.some((i) => i.severity === 'urgent')) -
          Number(a.issues.some((i) => i.severity === 'urgent')) ||
        a.issues[0]!.firstSeenAt.localeCompare(b.issues[0]!.firstSeenAt),
    );
}

/**
 * An issue's summary without the site's name it starts with, inside a group already headed by
 * that name: "Minton Homes runs MySQL 5.7" reads "Runs MySQL 5.7".
 */
export function withoutName(summary: string, name: string): string {
  if (!summary.startsWith(name)) return summary;
  const rest = summary.slice(name.length).replace(/^(’s|'s|’|')?\s*:?\s*/, '');
  return rest === '' ? summary : rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * The Sites count's note. Connected and monitoring only add up to the total; paused and
 * unfinished are among them, and down and not checked are among the sites being checked.
 */
export function siteNote(s: {
  total: number;
  connected: number;
  monitoring: number;
  paused: number;
  unfinished: number;
  down: number;
  unchecked: number;
}): string {
  if (s.total === 0) return 'None added yet';
  const among = [
    s.paused && `${s.paused} paused`,
    s.unfinished && `${s.unfinished} with setup unfinished`,
  ].filter(Boolean);
  const checks = [
    s.down && `${s.down} down`,
    s.unchecked && `${s.unchecked} not checked yet`,
  ].filter(Boolean);
  return [
    `${s.connected} connected · ${s.monitoring} monitoring only`,
    among.length ? `including ${among.join(' and ')}` : '',
    checks.length ? checks.join(', ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
