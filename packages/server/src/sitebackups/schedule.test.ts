import { describe, expect, it } from 'vitest';
import {
  backupNight,
  currentNight,
  isDue,
  nextNight,
  updateTimes,
  validZone,
  wallClock,
  type UpdateTime,
} from './schedule.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const utc = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min);
const TUESDAY_7PM: UpdateTime = { weekday: 2, hour: 19 };
const NZ = 'Pacific/Auckland';
const LA = 'America/Los_Angeles';
const local = (zone: string, at: number) => {
  const w = wallClock(zone, at);
  return `${w.year}-${w.month}-${w.day} ${w.hour}:${String(w.minute).padStart(2, '0')}`;
};

describe('the update time', () => {
  it('is the weekday and hour in NZ, either side of now', () => {
    // Wednesday 18 November 2026, 12:00 NZDT.
    const now = utc(2026, 11, 17, 23);
    const { last, next } = updateTimes(now, TUESDAY_7PM);
    expect(local(NZ, last)).toBe('2026-11-17 19:00');
    expect(local(NZ, next)).toBe('2026-11-24 19:00');
    // At the very hour, it's the last one.
    expect(updateTimes(last, TUESDAY_7PM).last).toBe(last);
  });

  it('keeps its NZ hour across NZ’s daylight saving', () => {
    // NZDT ends Sunday 5 April 2026 and starts Sunday 27 September.
    const april = updateTimes(utc(2026, 4, 8, 0), TUESDAY_7PM);
    expect(local(NZ, april.last)).toBe('2026-4-7 19:00');
    expect(april.last).toBe(utc(2026, 4, 7, 7)); // NZST, +12
    const september = updateTimes(utc(2026, 9, 30, 0), TUESDAY_7PM);
    expect(local(NZ, september.last)).toBe('2026-9-29 19:00');
    expect(september.last).toBe(utc(2026, 9, 29, 6)); // NZDT, +13
  });
});

describe('a site’s backup night', () => {
  it('is 03:00 its own time, the last night before the update', () => {
    const update = utc(2026, 11, 17, 6); // Tuesday 19:00 NZDT
    expect(local(NZ, backupNight(update, NZ))).toBe('2026-11-17 3:00');
    // Monday 22:00 in Los Angeles: the Monday morning before.
    expect(local(LA, backupNight(update, LA))).toBe('2026-11-16 3:00');
    // Tuesday 01:00 in New York, before 03:00: so Monday's 03:00.
    expect(local('America/New_York', backupNight(update, 'America/New_York'))).toBe(
      '2026-11-16 3:00',
    );
  });

  it('stays at 03:00 in NZ across NZ’s daylight saving, both ways', () => {
    const SUNDAY_7PM: UpdateTime = { weekday: 0, hour: 19 };
    // 5 April 2026: 03:00 NZDT becomes 02:00 NZST; 03:00 that morning is NZST.
    const ends = updateTimes(utc(2026, 4, 5, 12), SUNDAY_7PM).last;
    expect(backupNight(ends, NZ)).toBe(utc(2026, 4, 4, 15));
    expect(local(NZ, backupNight(ends, NZ))).toBe('2026-4-5 3:00');
    // 27 September 2026: 02:00 NZST becomes 03:00 NZDT; 03:00 is the first hour after the jump.
    const starts = updateTimes(utc(2026, 9, 27, 12), SUNDAY_7PM).last;
    expect(backupNight(starts, NZ)).toBe(utc(2026, 9, 26, 14));
    expect(local(NZ, backupNight(starts, NZ))).toBe('2026-9-27 3:00');
  });

  it('stays at 03:00 in Los Angeles across US daylight saving, both ways', () => {
    // US DST ends Sunday 1 November 2026: Monday 26 October is PDT, Monday 2 November PST.
    const before = updateTimes(utc(2026, 10, 28, 0), TUESDAY_7PM).last;
    const after = updateTimes(utc(2026, 11, 4, 0), TUESDAY_7PM).last;
    expect(backupNight(before, LA)).toBe(utc(2026, 10, 26, 10));
    expect(backupNight(after, LA)).toBe(utc(2026, 11, 2, 11));
    // US DST starts Sunday 8 March 2026: Monday 2 March is PST, Monday 9 March PDT.
    const winter = updateTimes(utc(2026, 3, 4, 0), TUESDAY_7PM).last;
    const spring = updateTimes(utc(2026, 3, 11, 0), TUESDAY_7PM).last;
    expect(backupNight(winter, LA)).toBe(utc(2026, 3, 2, 11));
    expect(backupNight(spring, LA)).toBe(utc(2026, 3, 9, 10));
    for (const update of [before, after, winter, spring])
      expect(wallClock(LA, backupNight(update, LA)).hour).toBe(3);
  });

  it('is the night in force from 03:00 until the next one begins', () => {
    const night = utc(2026, 11, 16, 14); // Tuesday 17 November, 03:00 NZDT
    expect(currentNight(night - HOUR, TUESDAY_7PM, NZ)).toBe(night - 7 * DAY);
    expect(currentNight(night, TUESDAY_7PM, NZ)).toBe(night);
    // After the update, until the next Tuesday's 03:00.
    expect(currentNight(night + 3 * DAY, TUESDAY_7PM, NZ)).toBe(night);
  });
});

describe('due', () => {
  const night = utc(2026, 11, 16, 14); // Tuesday 17 November, 03:00 NZDT
  const weekly = { zone: NZ, schedule: 'weekly' as const };

  it('from its night, until a good snapshot for it, so a missed hour catches up', () => {
    const lastWeek = night - 7 * DAY + 15 * 60_000;
    expect(isDue(night - HOUR, TUESDAY_7PM, { ...weekly, lastGood: lastWeek }).due).toBe(false);
    // 03:15 never ran (the mini was asleep): still due at 04:15, and at 10:15.
    expect(isDue(night + 75 * 60_000, TUESDAY_7PM, { ...weekly, lastGood: lastWeek }).due).toBe(
      true,
    );
    expect(isDue(night + 7 * HOUR, TUESDAY_7PM, { ...weekly, lastGood: lastWeek }).due).toBe(true);
    // Once it has one, not until next week.
    const taken = night + 75 * 60_000;
    expect(isDue(night + 7 * HOUR, TUESDAY_7PM, { ...weekly, lastGood: taken }).due).toBe(false);
    expect(nextNight(night + 7 * HOUR, TUESDAY_7PM, { ...weekly, lastGood: taken })).toBe(
      night + 7 * DAY,
    );
    // Never backed up: due now.
    expect(isDue(night - HOUR, TUESDAY_7PM, { ...weekly, lastGood: null }).due).toBe(true);
  });

  it('a Back up site now that evening counts for the night', () => {
    expect(isDue(night, TUESDAY_7PM, { ...weekly, lastGood: night - 30 * 60_000 }).due).toBe(false);
    expect(isDue(night, TUESDAY_7PM, { ...weekly, lastGood: night - 3 * HOUR }).due).toBe(true);
  });

  it('fortnightly: every second week, counted from its last snapshot', () => {
    const fortnightly = { zone: NZ, schedule: 'fortnightly' as const };
    const taken = night - 7 * DAY + 15 * 60_000; // last week's night
    expect(isDue(night + HOUR, TUESDAY_7PM, { ...fortnightly, lastGood: taken }).due).toBe(false);
    expect(nextNight(night + HOUR, TUESDAY_7PM, { ...fortnightly, lastGood: taken })).toBe(
      night + 7 * DAY,
    );
    expect(isDue(night + 7 * DAY, TUESDAY_7PM, { ...fortnightly, lastGood: taken }).due).toBe(true);
    // Two weeks back is too old.
    const older = taken - 7 * DAY;
    expect(isDue(night + HOUR, TUESDAY_7PM, { ...fortnightly, lastGood: older }).due).toBe(true);
  });

  it('follows the update time when Tyler moves it', () => {
    const SATURDAY_9AM: UpdateTime = { weekday: 6, hour: 9 };
    const at = utc(2026, 11, 20, 15); // Saturday 21 November, 04:00 NZDT
    expect(local(NZ, currentNight(at, SATURDAY_9AM, NZ))).toBe('2026-11-21 3:00');
    // Los Angeles: Friday 12:00 there, so Friday's 03:00.
    expect(local(LA, currentNight(at, SATURDAY_9AM, LA))).toBe('2026-11-20 3:00');
  });
});

describe('time zones', () => {
  it('takes IANA zones, not offsets or names Intl doesn’t know', () => {
    expect(validZone('America/Denver')).toBe(true);
    expect(validZone('UTC')).toBe(true);
    expect(validZone('Mars/Olympus')).toBe(false);
    expect(validZone('+13:00')).toBe(false);
  });
});
