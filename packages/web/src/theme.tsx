// The brief's tokens (brief.md, "Visual direction"; the prototype's values for the rest), as CSS
// custom properties so both appearances come from one set of names. Status colours carry meaning
// and always come with text or an icon; copper and brass are brand, never status.
import { css, Global } from '@emotion/react';

const light = `
  --bg: #eee9df;
  --panel: #fffcf5;
  --soft: #f4efe5;
  --ink: #342e26;
  --muted: #736959;
  --line: #ded4c4;
  --copper: #8b482d;
  --copper-soft: #f6e7da;
  --on-copper: #fffcf5;
  --brass: #94723e;
  --brass-soft: #ece0c6;
  --metal: #39352e;
  --metal-ink: #e9cc96;
  --green: #286746;
  --green-soft: #eaf2e6;
  --amber: #805913;
  --amber-soft: #fbf0d4;
  --red: #af3540;
  --red-soft: #fceeee;
`;

const dark = `
  --bg: #191815;
  --panel: #24221e;
  --soft: #302c25;
  --ink: #eee7db;
  --muted: #b8ad9c;
  --line: #494135;
  --copper: #edb18b;
  --copper-soft: #3b2d24;
  --on-copper: #332419;
  --brass: #b99559;
  --brass-soft: #3b3325;
  --metal: #11100e;
  --metal-ink: #edc988;
  --green: #99d3ad;
  --green-soft: #263b2c;
  --amber: #edc46c;
  --amber-soft: #3d3420;
  --red: #ffacb0;
  --red-soft: #422b2c;
`;

const globalStyles = css`
  :root {
    ${light}
    color-scheme: light;
    --radius: 6px;
    --gap: 14px;
    --serif: Georgia, 'Times New Roman', serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      ${dark}
      color-scheme: dark;
    }
  }
  :root[data-theme='dark'] {
    ${dark}
    color-scheme: dark;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font:
      13px/1.45 -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      sans-serif;
    font-variant-numeric: tabular-nums;
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  a {
    color: var(--copper);
  }
  button {
    font: inherit;
    color: inherit;
  }
  :focus-visible {
    outline: 2px solid var(--copper);
    outline-offset: 3px;
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      animation: none !important;
      transition: none !important;
    }
  }
`;

export function GlobalStyles() {
  return <Global styles={globalStyles} />;
}

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'kamaji.theme';

export function readThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}
