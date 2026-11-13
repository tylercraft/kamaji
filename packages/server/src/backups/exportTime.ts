// The time kamaji-db-export answers with. craftish's db-export writes it in ISO 8601 basic format,
// `date -u +%Y%m%dT%H%M%SZ` (server-export/db-export), e.g. 20261113T004147Z, which Date can't
// parse. Extended format (2026-11-13T00:41:47Z) is accepted too.

const BASIC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const EXTENDED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** The export's time as an ISO string (UTC, extended), or null when it isn't one of the two. */
export function exportTime(raw: string): string | null {
  const basic = BASIC.exec(raw);
  if (basic) {
    const [y, mo, d, h, mi, s] = basic.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    // Date.UTC rolls 20261131 over into December; a real time comes back as itself.
    const same =
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === mo - 1 &&
      date.getUTCDate() === d &&
      date.getUTCHours() === h &&
      date.getUTCMinutes() === mi &&
      date.getUTCSeconds() === s;
    return same ? date.toISOString() : null;
  }
  if (!EXTENDED.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
