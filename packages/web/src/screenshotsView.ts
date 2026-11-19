// Screenshot checks in words (ops/screenshots-plan.md, "The UI"): a run's one-line summary, each
// page and size's tile, and the order they're shown in, the changed first.
import {
  comparisonChanged,
  type ComparisonView,
  type RunScreenshots,
  type ScreenshotSetView,
  type ShotView,
} from '@kamaji/shared';

/** "Home", or the page's path: "/shop/". */
export function pageLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path === '/' ? 'Home' : decodeURIComponent(path);
  } catch {
    return url;
  }
}

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What one page and size did, short: "3.1% changed", "340 px taller", "not shot after". */
export function tileWords(c: ComparisonView): string {
  const parts: string[] = [];
  if (c.compared === 'none')
    parts.push(c.after?.blocked ? 'bot check' : (c.problem ?? 'not compared'));
  else {
    if (c.compared === 'first screen' && c.heightBefore !== null && c.heightAfter !== null) {
      const d = c.heightAfter - c.heightBefore;
      parts.push(`${Math.abs(d)} px ${d > 0 ? 'taller' : 'shorter'}`);
    }
    const changed = c.changedPct ?? 0;
    parts.push(changed < 0.05 ? 'no change' : `${pct(changed)} changed`);
  }
  if (c.newJsErrors > 0) parts.push(plural(c.newJsErrors, 'new JavaScript error'));
  if (c.newFailedRequests > 0) parts.push(plural(c.newFailedRequests, 'new failed request'));
  return parts.join(', ');
}

/** The changed first, the most changed first; then the rest in page order. */
export function ordered(comparisons: ComparisonView[]): ComparisonView[] {
  return comparisons
    .map((c, i) => ({ c, i, changed: comparisonChanged(c) }))
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        (b.changed ? (b.c.changedPct ?? 100) - (a.c.changedPct ?? 100) : 0) ||
        a.i - b.i,
    )
    .map((x) => x.c);
}

const pagesOf = (comparisons: ComparisonView[]) => new Set(comparisons.map((c) => c.pageUrl)).size;

/** The run's line: what was shot and the biggest change, or why there's nothing to compare. */
export function runSummary(run: RunScreenshots): { words: string; changed: boolean } {
  if (run.before?.state === 'waiting' || run.before?.state === 'running')
    return { words: 'Taking the “before” screenshots…', changed: false };
  if (run.after?.state === 'waiting' || run.after?.state === 'running')
    return { words: 'Taking the “after” screenshots…', changed: false };
  if (run.comparisons.length === 0) {
    const why =
      run.after?.state === 'failed'
        ? run.after.problem
        : run.before?.state === 'failed'
          ? run.before.problem
          : null;
    return {
      words: why ? `Screenshots weren’t compared: ${why}.` : 'Screenshots weren’t compared.',
      changed: false,
    };
  }
  const pages = pagesOf(run.comparisons);
  const changed = run.comparisons.filter(comparisonChanged);
  const shot = `${plural(pages, 'page')} at 2 sizes`;
  if (changed.length === 0) return { words: `${shot}, no change over 1%.`, changed: false };
  const top = ordered(changed)[0]!;
  return {
    words: `${shot}. ${new Set(changed.map((c) => c.pageUrl)).size} changed; the most: ${pageLabel(top.pageUrl)}, ${top.viewport}, ${tileWords(top)}.`,
    changed: true,
  };
}

/** Why a set is as it is, for the site page. */
export function setWords(set: ScreenshotSetView): string {
  const why = { before: 'before an update', after: 'after an update', manual: 'by hand' }[set.kind];
  if (set.state === 'waiting') return 'Waiting for the screenshots process…';
  if (set.state === 'running') return 'Taking screenshots…';
  if (set.state === 'failed') return `Couldn’t take them: ${set.problem ?? 'it failed'}.`;
  return `Taken ${why}${set.problem ? `, but ${set.problem}` : ''}.`;
}

/** Alt text: "Shop, mobile, after". */
export const altText = (s: ShotView, when: string) =>
  `${pageLabel(s.pageUrl)}, ${s.viewport}, ${when}`;
