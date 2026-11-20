const absolute = new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });

/** "just now", "4 min ago", "3 h ago", "2 days ago", then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return absolute.format(new Date(iso));
}

export const absoluteTime = (iso: string): string => absolute.format(new Date(iso));

// In NZ time, as rules and the update time are set.
const upcoming = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A time still to come, as a day and a clock: "Tue 24 Nov, 20:00". Relative words are for the past. */
export const upcomingTime = (iso: string): string =>
  upcoming.format(new Date(iso)).replace(/^(\w+),? /, '$1 ');
