// Ironworks, from the v1.5 design handoff (brief "Visual direction"; the prototype's values for
// the rest), as CSS custom properties so both appearances come from one set of names. Status
// colours carry meaning and always come with text or an icon; copper and brass are brand, never
// status. The chrome (header, mark) is near-black iron in both appearances.
import { css, Global } from '@emotion/react';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';

const light = `
  --bg: #dfe3e6;
  --panel: #f1f3f4;
  --soft: #e5e9ec;
  --ink: #202932;
  --muted: #54616f;
  --line: #bbc5ce;
  --copper: #86502e;
  --copper-soft: #e8ddd3;
  --on-copper: #ffffff;
  --brass: #8b7357;
  --green: #366751;
  --green-soft: #ddeae3;
  --amber: #7b5c20;
  --amber-soft: #ede4cf;
  --red: #a43c3c;
  --red-soft: #f4e0e0;
  --chrome: #20262e;
  --chrome-ink: #e6e9ee;
  --chrome-muted: #a5afbc;
  --seam: #48515c;
  --seam-copper: #9e6745;
  --lens: #10141b;
  --rim: #8e99a4;
  --glint: #707587;
  --hair: #81878b;
`;

const dark = `
  --bg: #101419;
  --panel: #1b2128;
  --soft: #242c35;
  --ink: #e5e9ef;
  --muted: #a1adbc;
  --line: #38424e;
  --copper: #d5a074;
  --copper-soft: #352c25;
  --on-copper: #171a1e;
  --brass: #a38b70;
  --green: #97bba9;
  --green-soft: #25372f;
  --amber: #dcb77c;
  --amber-soft: #393023;
  --red: #ef9b9b;
  --red-soft: #3c262a;
  --chrome: #0c1015;
  --chrome-ink: #dce3ec;
  --chrome-muted: #98a5b5;
  --seam: #343e49;
  --seam-copper: #b78059;
  --lens: #090c11;
  --rim: #a8b2bf;
  --glint: #768093;
  --hair: #a4aaa8;
`;

const globalStyles = css`
  /* Toasts (components/toast.tsx): the icon in the theme's green or red. */
  [data-sonner-toast][data-type='success'] [data-icon] {
    color: var(--green);
  }
  [data-sonner-toast][data-type='error'] [data-icon] {
    color: var(--red);
  }
  :root {
    ${light}
    color-scheme: light;
    --radius: 6px;
    --gap: 14px;
    --sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
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
    font: 13px/1.45 var(--sans);
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
  /* Readouts: timestamps, code and figures are set in mono. */
  time,
  code,
  pre {
    font-family: var(--mono);
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
