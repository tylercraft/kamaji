// Links within a page that open whatever disclosure hides their target, move there and put focus
// on it, so a keyboard or screen reader user lands where a sighted one does.
import type { ReactNode } from 'react';

export function reveal(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  for (let p: HTMLElement | null = el; p; p = p.parentElement)
    if (p instanceof HTMLDetailsElement) p.open = true;
  el.scrollIntoView({ block: 'start' });
  const focusable = el instanceof HTMLDetailsElement ? el.querySelector('summary') : el;
  if (focusable && focusable === el && !el.hasAttribute('tabindex'))
    el.setAttribute('tabindex', '-1');
  focusable?.focus({ preventScroll: true });
  return true;
}

export function RevealLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      href={`#${to}`}
      onClick={(event) => {
        if (reveal(to)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}
