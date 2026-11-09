// Which jobs' text Kamaji may read (Tyler, 2026-11-09; docs/crash-hook.md). Triage, the outbox,
// the today jobs, research and the phone threads read mail or untrusted text, so their log tails
// are never opened and their crash messages and tracebacks never kept. Only these jobs, matched
// on the label without its prefix, get either. The list only widens by a commit.
export const PREFIX = 'dev.craftish.calcifer.';
export const KAMAJI_LABEL = 'dev.craftish.kamaji';

const FULL_TEXT = new Set([
  'repo-pull',
  'echoocho-pull',
  'echoocho-mirror',
  'heartbeat',
  'dashboard',
  'dashboard-feed',
  'desk-card',
  'mini-status',
  'update-stack',
  'stack-at-login',
]);

/** The job's short name: the label without dev.craftish.calcifer., or "kamaji". */
export function shortName(label: string): string {
  if (label === KAMAJI_LABEL) return 'kamaji';
  return label.startsWith(PREFIX) ? label.slice(PREFIX.length) : label;
}

/** Whether a job's log tail, crash message and traceback may be read. */
export function fullText(label: string): boolean {
  if (label === KAMAJI_LABEL) return true;
  if (!label.startsWith(PREFIX)) return false;
  const short = label.slice(PREFIX.length);
  return FULL_TEXT.has(short) || short.startsWith('hunt-');
}

/** Phone threads: their exit codes are a session ending, not a failure. */
export function isSession(label: string): boolean {
  const short = shortName(label);
  return short.endsWith('-rc') || short === 'remote-control';
}
