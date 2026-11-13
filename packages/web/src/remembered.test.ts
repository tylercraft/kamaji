import { describe, expect, it } from 'vitest';
import { readRemembered, remember, startsOpen } from './components/remembered';

function fakeStore(initial: string | null = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_: string, v: string) => void (value = v) };
}

describe('remembered sections', () => {
  it('keeps each section’s last state by name', () => {
    const store = fakeStore();
    remember('checks', true, store);
    remember('plugins', false, store);
    remember('checks', false, store);
    expect(readRemembered(store)).toEqual({ checks: false, plugins: false });
  });

  it('falls back to nothing when the store is empty, broken or blocked', () => {
    expect(readRemembered(fakeStore('not json'))).toEqual({});
    expect(readRemembered(fakeStore('{"a": 1, "b": true}'))).toEqual({ b: true });
    expect(readRemembered(null)).toEqual({});
    expect(() =>
      remember('a', true, {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });

  it('opens for a problem whatever was remembered, else as last left, else the default', () => {
    expect(startsOpen(false, false, true)).toBe(true);
    expect(startsOpen(false, true, false)).toBe(false);
    expect(startsOpen(true, false, false)).toBe(true);
    expect(startsOpen(undefined, true, false)).toBe(true);
  });
});
