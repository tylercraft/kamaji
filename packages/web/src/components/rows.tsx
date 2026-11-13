// A card's facts as label and value rows: "Latest attempt", "Next run". Stacks on a phone.
import styled from '@emotion/styled';

export const Rows = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  font-size: 12px;
  dt {
    color: var(--muted);
    padding-top: 1px;
  }
  dd {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 8px;
    align-items: baseline;
  }
  dd .why {
    flex-basis: 100%;
    color: var(--muted);
  }
  @media (max-width: 420px) {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    dd {
      margin-bottom: 6px;
    }
  }
`;
