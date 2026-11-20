import { describe, expect, it } from 'vitest';
import { upcomingTime } from './time';

describe('a time still to come', () => {
  it('as a day and a clock, not “just now”', () => {
    expect(upcomingTime('2026-11-24T07:00:00Z')).toMatch(/^Tue 24 Nov,? 20:00$/);
  });
});
