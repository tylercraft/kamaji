// The top of a site's page: one tile per question (siteStatus.ts), quiet when it's fine, then
// whatever needs Tyler, each with a link to the section that has the evidence. A problem always
// shows here, even when its section's details are closed.
import styled from '@emotion/styled';
import type { StatusLine } from '../siteStatus';
import { Dot, Pill, Time } from '../components/ui';

const Tiles = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  li {
    padding: 10px 13px;
    border-left: 1px solid var(--line);
    display: grid;
    gap: 3px;
    align-content: start;
    justify-items: start;
    min-width: 0;
  }
  li:first-of-type {
    border-left: 0;
  }
  li > span {
    max-width: 100%;
    white-space: normal;
  }
  .label {
    font: 11px/1.45 var(--mono);
    color: var(--muted);
  }
  .quiet {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-weight: 550;
  }
  .quiet .dot {
    color: var(--green);
  }
  .neutral {
    color: var(--muted);
  }
  .when {
    font-size: 11px;
    color: var(--muted);
  }
  .old {
    color: var(--amber);
  }
  @media (max-width: 560px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    li:nth-of-type(odd) {
      border-left: 0;
    }
    li {
      border-top: 1px solid var(--line);
    }
    li:nth-of-type(-n + 2) {
      border-top: 0;
    }
  }
`;

/** Healthy is a dot and words; anything else is a flag, so exceptions are the loud ones. */
function State({ line }: { line: StatusLine }) {
  if (line.tone === 'green')
    return (
      <span className="quiet">
        <span className="dot">
          <Dot />
        </span>
        {line.state}
      </span>
    );
  return (
    <Pill tone={line.tone}>
      <Dot /> {line.state}
    </Pill>
  );
}

export function HealthTiles({ lines }: { lines: StatusLine[] }) {
  return (
    <Tiles aria-label="Health">
      {lines.map((l) => (
        <li key={l.label} title={l.detail}>
          <span className="label">{l.label}</span>
          <State line={l} />
          {l.at && (
            <span className="when">
              <Time iso={l.at} />
              {l.outOfDate && <span className="old"> · out of date</span>}
            </span>
          )}
        </li>
      ))}
    </Tiles>
  );
}

/** The lines that need a look, with where their evidence is. */
export function needsLook(lines: StatusLine[]): StatusLine[] {
  return lines.filter((l) => l.tone === 'red' || l.tone === 'amber' || l.outOfDate);
}

export function Attention({
  lines,
  where,
}: {
  lines: StatusLine[];
  /** The section each line's evidence is in: an anchor and its name. */
  where: Record<string, [string, string] | undefined>;
}) {
  if (lines.length === 0) return null;
  return (
    <section
      aria-labelledby="site-attention"
      css={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderLeft: '3px solid var(--amber)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        display: 'grid',
        gap: 6,
      }}
    >
      <h2 id="site-attention" css={{ fontSize: 13 }}>
        Needs a look ({lines.length})
      </h2>
      <ul css={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
        {lines.map((l) => {
          const to = where[l.label];
          return (
            <li key={l.label}>
              <strong>{l.label}:</strong> {l.state}.{' '}
              <span css={{ color: 'var(--muted)' }}>{l.detail}</span>
              {l.outOfDate && l.tone !== 'red' && l.tone !== 'amber' && (
                <span css={{ color: 'var(--amber)' }}> The check is out of date.</span>
              )}
              {to && (
                <>
                  {' '}
                  <a href={`#${to[0]}`}>{to[1]}</a>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
