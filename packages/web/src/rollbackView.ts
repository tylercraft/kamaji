// The words of the site page's Rollback section (pages/Rollback.tsx), kept apart so they're tested.
import type {
  RollbackCounts,
  RollbackItemView,
  RollbackView,
  SiteRollbackResponse,
} from '@kamaji/shared';
import type { Tone } from './components/ui';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** How long ago, in a few words: "2 days ago", "5 hours ago". */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (ms < HOUR) return 'under an hour ago';
  const hours = Math.round(ms / HOUR);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `${Math.round(ms / DAY)} days ago`;
}

export function itemLine(i: RollbackItemView): string {
  const name = i.type === 'core' ? 'WordPress' : i.name;
  const core = i.type === 'core' ? ', from wordpress.org, checked against its checksums' : '';
  return `${name} ${i.back} (now ${i.now})${core}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the database box lost, as counted on the server: "12 orders, 3 comments and 1 new user". */
export function countsWords(c: RollbackCounts): string {
  const parts = [
    ...(c.orders === null ? [] : [plural(c.orders, 'order', 'orders')]),
    plural(c.comments, 'comment', 'comments'),
    plural(c.users, 'new user', 'new users'),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}` : parts[0]!;
}

/** Still going: asked, running, or pushed and waiting for its checks. */
export function inProgress(r: RollbackView | null): boolean {
  if (!r) return false;
  if (r.state === 'waiting' || r.state === 'running') return true;
  return r.changed !== 'none' && r.checksOk === null;
}

export const rollbackPollMs = (last: SiteRollbackResponse | null) =>
  inProgress(last?.latest ?? null) ? 5_000 : 60_000;

const STEPS: Record<string, string> = {
  check: 'the checks on the server',
  receive: 'sending the files',
  count: 'counting what the database would lose',
  stage: 'staging the files',
  save: 'saving the database first',
  maintenance: 'maintenance mode',
  swap: 'the swap',
  database: 'the database',
  snapshot: 'reading the restore point',
  pack: 'packing the files',
  connection: 'the connection',
  mini: 'the mini',
};

/** The latest rollback or undo in a pill and a line. */
export function latestWords(r: RollbackView): { tone: Tone; label: string; detail: string } {
  const undo = r.kind === 'undo';
  const noun = undo ? 'Undo' : 'Rollback';
  if (r.state === 'waiting')
    return {
      tone: 'neutral',
      label: `${noun} asked for`,
      detail: 'The backups process takes it within a minute or so.',
    };
  if (r.state === 'running')
    return {
      tone: 'neutral',
      label: undo ? 'Undoing' : 'Rolling back',
      detail: 'Working on the server now.',
    };
  const step = STEPS[r.step ?? ''] ?? r.step ?? 'a step';
  if (r.changed === 'none')
    return {
      tone: 'amber',
      label: `${noun} stopped`,
      detail: `Stopped at ${step}, with nothing changed: ${r.problem ?? 'it failed'}.`,
    };
  if (r.checksOk === null)
    return { tone: 'neutral', label: 'Checking', detail: 'Pushed; the checks are running.' };
  const lost =
    r.counts && r.withDatabase && !undo
      ? ` Put back with the database, losing ${countsWords(r.counts)} since then.`
      : '';
  const checks = r.checksOk
    ? 'Checks passed.'
    : `Checks failed: ${r.checksProblem ?? 'see Activity'}.`;
  if (r.changed === 'all')
    return {
      tone: r.checksOk ? 'green' : 'red',
      label: undo ? 'Rollback undone' : 'Rolled back',
      detail: `${checks}${lost}`,
    };
  if (r.changed === 'files')
    return {
      tone: 'red',
      label: undo ? 'Undone, files only' : 'Rolled back, files only',
      detail: `The database didn’t import, so it’s as it was. ${checks}`,
    };
  return {
    tone: 'red',
    label: `${noun} stopped part way`,
    detail: `Stopped at ${step}: ${r.problem ?? 'it failed'}. It needs a look on the server. ${checks}`,
  };
}
