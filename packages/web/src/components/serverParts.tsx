// Pieces of a server's card: titled parts (Maintenance, Resources, Services) in a row, and a meter
// with its number beside it. A meter is coloured only where Kamaji has a threshold for it (disks:
// 85% and 95%, as the checks use); otherwise it's plain.
import styled from '@emotion/styled';
import type { ReactNode } from 'react';

/** Maintenance, Resources and Services side by side on a wide screen, stacked on a narrow one. */
export const PartsRow = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  & > section {
    padding: 0 16px;
    border-left: 1px solid var(--line);
  }
  & > section:first-of-type {
    padding-left: 0;
    border-left: 0;
  }
  & > section:last-of-type {
    padding-right: 0;
  }
  @media (max-width: 900px) {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    & > section {
      padding: 10px 0 0;
      border-left: 0;
      border-top: 1px solid var(--line);
    }
    & > section:first-of-type {
      padding-top: 0;
      border-top: 0;
    }
  }
`;

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
    <section aria-label={title} css={{ display: 'grid', gap: 6, alignContent: 'start' }}>
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
