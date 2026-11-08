import { useState } from 'react';
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from '../theme';

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  return (
    <label
      css={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--muted)' }}
    >
      Appearance
      <select
        value={choice}
        onChange={(event) => {
          const next = event.target.value as ThemeChoice;
          setChoice(next);
          applyThemeChoice(next);
        }}
        css={{
          font: 'inherit',
          color: 'var(--ink)',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 4,
          padding: '3px 4px',
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
