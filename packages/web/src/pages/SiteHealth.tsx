// The top of a site's page: one tile per question (siteStatus.ts), quiet when it's fine, then
// whatever needs Tyler, each with a link to the section that has the evidence. A problem always
// shows here, even when its section's details are closed.
import styled from '@emotion/styled';
import { RevealLink } from '../components/reveal';
import type { Look } from '../siteAttention';
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

/** Each check's line in full: what was checked, what it found, when. */
export function CheckDetails({ lines }: { lines: StatusLine[] }) {
  return (
    <details id="checks">
      <summary>Check details</summary>
      <dl
        css={{
          margin: '8px 0 0',
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          gap: '6px 16px',
          fontSize: 12,
          dt: { color: 'var(--muted)' },
          dd: { margin: 0 },
          '@media (max-width: 520px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
        }}
      >
        {lines.map((l) => (
          <div key={l.label} css={{ display: 'contents' }}>
            <dt>{l.label}</dt>
            <dd>
              {l.state}. {l.detail}
              {l.at && (
                <>
                  {' '}
                  Checked <Time iso={l.at} />
                  {l.outOfDate && <span css={{ color: 'var(--amber)' }}> · out of date</span>}.
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Things to act on, a line each, linked to the card that has the evidence. */
export function Attention({ looks }: { looks: Look[] }) {
  if (looks.length === 0) return null;
  const red = looks.some((l) => l.tone === 'red');
  return (
    <section
      aria-labelledby="site-attention"
      css={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderLeft: `3px solid var(--${red ? 'red' : 'amber'})`,
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        display: 'grid',
        gap: 6,
      }}
    >
      <h2 id="site-attention" css={{ fontSize: 13 }}>
        Needs a look{' '}
        <span css={{ color: 'var(--muted)', fontWeight: 400 }}>
          · {looks.length} {looks.length === 1 ? 'item' : 'items'}
        </span>
      </h2>
      <ul
        css={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '4px 24px',
        }}
      >
        {looks.map((l) => (
          <li key={l.text} css={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span css={{ color: `var(--${l.tone})` }} aria-hidden="true">
              <Dot />
            </span>
            <span>
              {l.text} <RevealLink to={l.target}>{l.action}</RevealLink>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
