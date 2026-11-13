// Status lines (siteStatus.ts) as a list: the question, the answer as a flag, then a line of
// detail with when it was checked. An out-of-date check says so beside its time.
import styled from '@emotion/styled';
import type { StatusLine } from '../siteStatus';
import { Dot, Pill, Time } from './ui';

const List = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 10px 18px;
  dt {
    color: var(--muted);
    font-size: 12px;
    padding-top: 2px;
  }
  dd {
    margin: 0;
    display: grid;
    gap: 2px;
    justify-items: start;
  }
  .detail {
    color: var(--muted);
    font-size: 12px;
  }
  .old {
    color: var(--amber);
  }
  @media (max-width: 520px) {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    dd {
      margin-bottom: 10px;
    }
  }
`;

export function StatusList({ lines }: { lines: StatusLine[] }) {
  return (
    <List>
      {lines.map((l) => (
        <div key={l.label} css={{ display: 'contents' }}>
          <dt>{l.label}</dt>
          <dd>
            <Pill tone={l.tone}>
              <Dot /> {l.state}
            </Pill>
            <span className="detail">
              {l.detail}
              {l.at && (
                <>
                  {' · '}
                  <Time iso={l.at} />
                  {l.outOfDate && <span className="old"> · out of date</span>}
                </>
              )}
            </span>
          </dd>
        </div>
      ))}
    </List>
  );
}
