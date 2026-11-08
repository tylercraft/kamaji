// Small building blocks shared by the six views.
import styled from '@emotion/styled';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Resource } from '../useResource';
import { absoluteTime, relativeTime } from '../time';

export const Panel = styled.section`
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
  min-width: 0;
  display: grid;
  gap: 10px;
  align-content: start;
`;

export const PanelTitle = styled.h2`
  font-size: 13px;
  font-weight: 650;
`;

export const Muted = styled.p`
  color: var(--muted);
  font-size: 12px;
`;

export const Grid = styled.div<{ columns?: string }>`
  display: grid;
  gap: var(--gap);
  grid-template-columns: ${(p) => p.columns ?? 'minmax(0, 1fr)'};
  align-items: start;
  @media (max-width: 900px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

export type Tone = 'green' | 'amber' | 'red' | 'neutral' | 'copper';

const toneColours: Record<Tone, [string, string]> = {
  green: ['var(--green)', 'var(--green-soft)'],
  amber: ['var(--amber)', 'var(--amber-soft)'],
  red: ['var(--red)', 'var(--red-soft)'],
  neutral: ['var(--muted)', 'var(--soft)'],
  copper: ['var(--copper)', 'var(--copper-soft)'],
};

export const Pill = styled.span<{ tone?: Tone }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.4;
  font-weight: 550;
  white-space: nowrap;
  color: ${(p) => toneColours[p.tone ?? 'neutral'][0]};
  background: ${(p) => toneColours[p.tone ?? 'neutral'][1]};
`;

/** A coloured dot that always sits beside words saying the same thing. */
export const Dot = styled.span`
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
`;

export const Button = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  &:hover {
    border-color: var(--copper);
  }
`;

const Heading = styled.header`
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  min-height: 49px;
  h1 {
    font-size: 25px;
    line-height: 1.2;
    font-weight: 650;
    letter-spacing: -0.7px;
    outline: none;
  }
`;

/** The view's title and its one-line purpose. Takes focus after navigation, for screen readers. */
export function PageHeading({
  title,
  purpose,
  children,
}: {
  title: string;
  purpose: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) ref.current?.focus();
    document.title = title === 'Overview' ? 'Kamaji' : `${title} · Kamaji`;
  }, [title]);
  return (
    <Heading>
      <div>
        <h1 ref={ref} tabIndex={-1}>
          {title}
        </h1>
        <Muted css={{ marginTop: 4 }}>{purpose}</Muted>
      </div>
      {children}
    </Heading>
  );
}

const EmptyBox = styled.div`
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: 22px 18px;
  display: grid;
  gap: 6px;
  justify-items: start;
  h3 {
    font-size: 13px;
    font-weight: 650;
  }
  p {
    color: var(--muted);
    font-size: 12px;
    max-width: 62ch;
  }
`;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <EmptyBox>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </EmptyBox>
  );
}

const Skeleton = styled.div`
  display: grid;
  gap: 8px;
  span {
    display: block;
    height: 12px;
    border-radius: 3px;
    background: var(--soft);
  }
`;

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite">
      <Muted>{label}</Muted>
      <Skeleton aria-hidden="true" css={{ marginTop: 10 }}>
        <span css={{ width: '72%' }} />
        <span css={{ width: '54%' }} />
        <span css={{ width: '63%' }} />
      </Skeleton>
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" css={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
      <Pill tone="red">
        <Dot /> Couldn’t load
      </Pill>
      <p>{message}. Nothing below is current until this loads.</p>
      <Button type="button" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Renders a resource's three states. When a refresh fails after a good load, the old data stays
 * on screen with a line saying how old it is, so it can't pass for current.
 */
export function ResourceView<T>({
  resource,
  label,
  children,
}: {
  resource: Resource<T>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.state === 'loading') return <Loading label={`Loading ${label}…`} />;
  if (resource.state === 'error')
    return <ErrorState message={resource.message} retry={resource.retry} />;
  const at = new Date(resource.loadedAt).toISOString();
  return (
    <>
      {resource.refreshError && (
        <div role="alert" css={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pill tone="amber">
            <Dot /> Stale
          </Pill>
          <Muted>
            {resource.refreshError}. Showing {label} from{' '}
            <time dateTime={at} title={absoluteTime(at)}>
              {relativeTime(at)}
            </time>
            .
          </Muted>
          <Button type="button" onClick={resource.reload}>
            Try again
          </Button>
        </div>
      )}
      {children(resource.data)}
    </>
  );
}

export function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

export const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  th {
    text-align: left;
    font-weight: 550;
    color: var(--muted);
    font-size: 11px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  tr:last-child td {
    border-bottom: 0;
  }
`;
