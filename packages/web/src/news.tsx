// What's new for this viewer (server viewers.ts), polled once for the whole app: a dot on a tab
// when something appeared on that page since it was last opened, a dot on each such item while
// the page is open, and a toast when a run this viewer started finishes, on whatever page is open.
import { NewsResponse, type FinishedRunView, type SeenPage } from '@kamaji/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { postJson } from './api';
import { useResource } from './useResource';

const NewsContext = createContext<{ news: NewsResponse | null; reload: () => void }>({
  news: null,
  reload: () => {},
});

/** The toast's words: Discord's lines, with what changed by name, without the bold. */
export const runToast = (run: FinishedRunView) => run.lines.map((l) => l.replace(/\*\*/g, ''));

/** New runs this viewer approved, not seen at the first load: each toasted once. */
export function runsToToast(
  runs: FinishedRunView[],
  login: string,
  known: Set<string>,
): FinishedRunView[] {
  return runs.filter((r) => !known.has(r.id) && r.approvedBy === login);
}

export function NewsProvider({ children }: { children: ReactNode }) {
  const resource = useResource('/api/me/news', NewsResponse, { pollMs: 30_000 });
  const news = resource.state === 'ready' ? resource.data : null;
  // Runs already finished when the page loaded aren't news; only those that finish after are.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!news) return;
    if (known.current === null) {
      known.current = new Set(news.runs.map((r) => r.id));
      return;
    }
    for (const run of runsToToast(news.runs, news.login, known.current)) {
      known.current.add(run.id);
      const [first, ...rest] = runToast(run);
      const held = run.lines.some((l) => l.startsWith('⚠️'));
      (held ? toast.warning : toast.success)(first, {
        description: rest.length > 0 ? rest.join('\n') : undefined,
        duration: held ? Infinity : 15_000,
        action: {
          label: 'See the run',
          onClick: () => window.location.assign(run.href ?? `/updates#${run.anchor}`),
        },
      });
    }
  }, [news]);
  const reload = resource.state === 'ready' ? resource.reload : () => {};
  return <NewsContext.Provider value={{ news, reload }}>{children}</NewsContext.Provider>;
}

export const useNews = () => useContext(NewsContext);

/**
 * For a page that remembers when it was last opened: what was new when it opened (kept for this
 * visit, so the dots stay while it's open), then marks the page seen.
 */
export function useFresh(page: SeenPage): Set<string> {
  const { news, reload } = useNews();
  const [fresh, setFresh] = useState<Set<string> | null>(null);
  // Captured once, the first time news is in: it stays for this visit.
  if (news && fresh === null) setFresh(new Set(news.fresh[page]));
  const marked = useRef(false);
  useEffect(() => {
    if (fresh === null || marked.current) return;
    marked.current = true;
    void postJson('/api/me/seen', { page }, z.object({ ok: z.literal(true) })).then(reload);
  }, [fresh, page, reload]);
  return fresh ?? new Set();
}
