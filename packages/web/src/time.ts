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
