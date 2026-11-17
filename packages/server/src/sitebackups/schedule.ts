// When whole-site backups run (Tyler, 2026-11-17): one weekly update time, in NZ time, and each
// site backed up at 03:00 in its own time zone on the last night before it, so the backup runs at
// a quiet hour for its visitors and is fresh when Tyler updates. Fortnightly sites go every second
// week. Every offset comes from Intl, so daylight saving in either zone is the platform's to get
// right, never ours.

export const KAMAJI_ZONE = 'Pacific/Auckland';
export const BACKUP_HOUR = 3;
/** The weekly update time: a weekday (0 Sunday … 6 Saturday) and hour, in NZ time. */
export interface UpdateTime {
  weekday: number;
  hour: number;
}
export const DEFAULT_UPDATE_TIME: UpdateTime = { weekday: 2, hour: 19 };

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.includes('/') || zone === 'UTC';
  } catch {
    return false;
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The wall clock in `zone` at `at`. */
export function wallClock(zone: string, at: number): Wall {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formats.set(zone, format);
  }
  const p = Object.fromEntries(format.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday)),
  };
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in ms. */
function offset(zone: string, at: number): number {
  const w = wallClock(zone, at);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(at / 60_000) * 60_000;
}

/**
 * The instant `zone`'s clocks read this date at `hour`:00. A date's month and day may overflow
 * (day 0, day 32): Date.UTC rolls them. An hour skipped by daylight saving gives the instant just
 * after the jump.
 */
export function zonedTime(
  zone: string,
  date: { year: number; month: number; day: number },
  hour: number,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour);
  let at = wall - offset(zone, wall);
  // Once more, in case the guess fell on the other side of a change.
  at = wall - offset(zone, at);
  return at;
}

/** The update times either side of `now`: the last at or before it, and the next after it. */
export function updateTimes(now: number, time: UpdateTime): { last: number; next: number } {
  const today = wallClock(KAMAJI_ZONE, now);
  const candidates: number[] = [];
  for (let d = -8; d <= 8; d++) {
    const at = zonedTime(KAMAJI_ZONE, { ...today, day: today.day + d }, time.hour);
    if (wallClock(KAMAJI_ZONE, at).weekday === time.weekday) candidates.push(at);
  }
  const last = Math.max(...candidates.filter((t) => t <= now));
  const next = Math.min(...candidates.filter((t) => t > now));
  return { last, next };
}

/** 03:00 in the site's zone on the last night before the update at `update`. */
export function backupNight(update: number, zone: string): number {
  const local = wallClock(zone, update);
  const sameDay = zonedTime(zone, local, BACKUP_HOUR);
  return sameDay < update
    ? sameDay
    : zonedTime(zone, { ...local, day: local.day - 1 }, BACKUP_HOUR);
}

export type Schedule = 'weekly' | 'fortnightly';

/**
 * The backup night now in force for a site: the latest one that has begun. A site is due from
 * then until its next night, unless it has a good snapshot that counts for this one: since this
 * night for weekly sites; since the week before for fortnightly ones, so a fortnightly site goes
 * every second week, counted from its own last snapshot.
 */
export function currentNight(now: number, time: UpdateTime, zone: string): number {
  const { last, next } = updateTimes(now, time);
  const upcoming = backupNight(next, zone);
  return upcoming <= now ? upcoming : backupNight(last, zone);
}

export function isDue(
  now: number,
  time: UpdateTime,
  site: { zone: string; schedule: Schedule; lastGood: number | null },
): { due: boolean; night: number } {
  const night = currentNight(now, time, site.zone);
  const since = site.schedule === 'fortnightly' ? night - WEEK : night;
  // A snapshot within an hour before a night (Back up site now that evening) counts for it.
  const counts = site.lastGood !== null && site.lastGood >= since - HOUR;
  return { due: !counts, night };
}

/** When a site's next scheduled backup starts, after `now`. */
export function nextNight(
  now: number,
  time: UpdateTime,
  site: { zone: string; schedule: Schedule; lastGood: number | null },
): number {
  const { due, night } = isDue(now, time, site);
  if (due) return now;
  // The next night, and for fortnightly sites, the one after if the next still counts as covered.
  let update = updateTimes(now, time).next;
  for (let i = 0; i < 3; i++) {
    const candidate = backupNight(update, site.zone);
    if (candidate > night && isDue(candidate, time, site).due) return candidate;
    update = updateTimes(update, time).next;
  }
  return backupNight(update, site.zone);
}
