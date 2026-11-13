// Which sections of a site's page Tyler last left open or closed, by name, the same on every site.
// Kept in this browser's storage: a convenience, so a phone and the laptop each remember their
// own, and an empty or blocked store just means the defaults. A section opened because of a
// problem opens regardless; what's remembered only decides the rest.
import {
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type SyntheticEvent,
} from 'react';

const KEY = 'kamaji.sections';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRemembered(store: Store | null = storage()): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}

export function remember(name: string, open: boolean, store: Store | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify({ ...readRemembered(store), [name]: open }));
  } catch {
    // Storage full or blocked: it's remembered until the page reloads.
  }
}

/** Where a section starts: open for a problem, else as last left, else its default. */
export function startsOpen(remembered: boolean | undefined, fallback: boolean, force: boolean) {
  return force || (remembered ?? fallback);
}

/**
 * Props for a <details>: `name` is the section, the same on every site; `fallback` is its default;
 * `force` opens it for a problem whatever was remembered.
 */
export function useRemembered(name: string, fallback = false, force = false) {
  const [open, setOpen] = useState(() => startsOpen(readRemembered()[name], fallback, force));
  return {
    open: force || open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      const now = event.currentTarget.open;
      if (now === open) return;
      setOpen(now);
      remember(name, now);
    },
  };
}

/** A <details> (or a styled one, as `component`) that remembers whether it was left open. */
export function RememberedDetails({
  name,
  fallback = false,
  force = false,
  component: Component = 'details',
  ...props
}: {
  name: string;
  fallback?: boolean;
  force?: boolean;
  component?: ElementType;
} & Omit<ComponentPropsWithoutRef<'details'>, 'open' | 'onToggle'>) {
  const remembered = useRemembered(name, fallback, force);
  return <Component {...props} open={remembered.open} onToggle={remembered.onToggle} />;
}
