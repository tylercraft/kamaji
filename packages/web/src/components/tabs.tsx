// Tabs (the WAI-ARIA pattern): arrow keys, Home and End move between tabs, Tab moves into the
// panel. Only the chosen panel is rendered. The choice is kept in the address's #, so a reload or
// a shared link lands on the same tab.
import styled from '@emotion/styled';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: string;
  /** A short count or flag after the label, like "3". */
  badge?: string | undefined;
  panel: () => ReactNode;
}

const List = styled.div`
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
  button {
    flex: none;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    background: none;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 550;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  button:hover {
    color: var(--ink);
  }
  button[aria-selected='true'] {
    color: var(--ink);
    border-bottom-color: var(--copper);
  }
  button:focus-visible {
    outline-offset: -2px;
  }
  .badge {
    font: 500 11px/1.4 var(--mono);
    color: var(--muted);
  }
`;

function fromHash(ids: string[]): string | null {
  const hash = window.location.hash.slice(1);
  return ids.includes(hash) ? hash : null;
}

export function Tabs({ label, tabs }: { label: string; tabs: TabDef[] }) {
  const ids = tabs.map((t) => t.id);
  const [chosen, setChosen] = useState(() => fromHash(ids) ?? ids[0]!);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  // A tab that went away (a site switched to monitoring only) falls back to the first.
  const selected = ids.includes(chosen) ? chosen : ids[0]!;

  const select = (id: string, focus = false) => {
    setChosen(id);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}#${id}`);
    if (focus) refs.current[id]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const i = ids.indexOf(selected);
    const to: Record<string, number> = {
      ArrowRight: (i + 1) % ids.length,
      ArrowLeft: (i - 1 + ids.length) % ids.length,
      Home: 0,
      End: ids.length - 1,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(ids[next]!, true);
  };

  const current = tabs.find((t) => t.id === selected)!;
  return (
    <div css={{ display: 'grid', gap: 'var(--gap)' }}>
      <List role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === selected}
            aria-controls={`panel-${t.id}`}
            tabIndex={t.id === selected ? 0 : -1}
            onClick={() => select(t.id)}
            onKeyDown={onKeyDown}
          >
            {t.label}
            {t.badge && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </List>
      <div
        role="tabpanel"
        id={`panel-${current.id}`}
        aria-labelledby={`tab-${current.id}`}
        tabIndex={0}
        css={{
          display: 'grid',
          gap: 'var(--gap)',
          minWidth: 0,
          '&:focus-visible': { outlineOffset: 4 },
        }}
      >
        {current.panel()}
      </div>
    </div>
  );
}
