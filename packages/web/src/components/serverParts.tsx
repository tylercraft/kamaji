// Pieces of a server's card: a titled part (Maintenance, Resources, Services) and a small meter
// with its number beside it. A meter is coloured only where Kamaji has a threshold for it (disks:
// 85% and 95%, as the checks use); otherwise it's plain.
import type { ReactNode } from 'react';

export function Part({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      css={{
        display: 'grid',
        gap: 6,
        borderTop: '1px solid var(--line)',
        paddingTop: 10,
        '&:first-of-type': { borderTop: 0, paddingTop: 0 },
      }}
    >
      <div css={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h3 css={{ fontSize: 13 }}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const DISK_WARN = 85;
export const DISK_URGENT = 95;

export function Meter({
  label,
  percent,
  words,
  thresholds,
}: {
  label: string;
  percent: number;
  words: string;
  /** Where it turns amber and red; without them it stays plain. */
  thresholds?: [number, number];
}) {
  const tone = thresholds
    ? percent >= thresholds[1]
      ? 'red'
      : percent >= thresholds[0]
        ? 'amber'
        : 'muted'
    : 'muted';
  return (
    <div css={{ display: 'grid', gap: 3, fontSize: 12 }}>
      <div css={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{label}</span>
        <span css={{ color: tone === 'muted' ? 'var(--ink)' : `var(--${tone})` }}>{words}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={words}
        css={{ height: 6, borderRadius: 3, background: 'var(--soft)', overflow: 'hidden' }}
      >
        <div
          css={{
            width: `${Math.min(100, Math.max(0, percent))}%`,
            height: '100%',
            background: `var(--${tone === 'muted' ? 'muted' : tone})`,
            opacity: tone === 'muted' ? 0.55 : 1,
          }}
        />
      </div>
    </div>
  );
}
