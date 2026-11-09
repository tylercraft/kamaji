// Form pieces for Add site and Remove: labelled fields, one style for inputs, and an error line.
import styled from '@emotion/styled';
import type { ReactNode } from 'react';
import { Muted } from './ui';

export const Form = styled.form`
  display: grid;
  gap: 14px;
  max-width: 560px;
`;

const FieldBox = styled.div`
  display: grid;
  gap: 5px;
  label,
  legend {
    font-size: 12px;
    font-weight: 600;
  }
  input[type='text'],
  input[type='url'],
  select {
    font: inherit;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 7px 9px;
  }
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--copper);
    outline-offset: 1px;
  }
`;

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <FieldBox>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <Muted id={`${id}-hint`}>{hint}</Muted>}
    </FieldBox>
  );
}

export const Choices = styled.fieldset`
  border: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  legend {
    font-size: 12px;
    font-weight: 600;
    padding: 0;
    margin-bottom: 4px;
  }
  label {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
`;

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" css={{ color: 'var(--red)', fontSize: 12 }}>
      {children}
    </p>
  );
}

export const PrimaryButton = styled.button`
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 13px;
  border: 1px solid var(--copper);
  border-radius: 3px;
  background: var(--copper);
  color: var(--on-copper);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
`;
