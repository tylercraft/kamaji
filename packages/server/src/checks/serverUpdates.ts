// How urgent a server's package updates are (TY-167, Tyler 2026-11-13). Kamaji recommends;
// patching and restarts stay Tyler's.
//
// - Urgent (Discord at once): a security update to an internet-facing package (the web server,
//   PHP, OpenSSH, OpenSSL, MariaDB, the kernel) waiting over a day, or a restart pending over 7
//   days.
// - Morning digest: any other security update waiting over a day; a restart pending; 20 or more
//   ordinary updates waiting with the oldest over 30 days (listed once, then every 30 days:
//   notify.ts, DIGEST_REPEAT).
// - Ubuntu Pro's ESM updates are information only.
//
// "Waiting" counts from when Kamaji first saw that version (server_updates), since apt doesn't say
// when a package became upgradable; a restart counts from /var/run/reboot-required's time.
import type { Db } from '../db.js';

const DAY = 86_400_000;
export const SECURITY_GRACE = DAY;
export const REBOOT_URGENT = 7 * DAY;
export const STALE_COUNT = 20;
export const STALE_AGE = 30 * DAY;

export interface Upgradable {
  name: string;
  from: string;
  to: string;
  suites: string[];
  security: boolean;
  esm: boolean;
}

export interface UpdateRow extends Upgradable {
  firstSeenAt: number;
}

interface Rule {
  test: RegExp;
  label: string;
  /** Why it deserves a careful pass, or null when it doesn't. */
  care: string | null;
  /** Internet-facing only while this service runs. */
  service?: string;
}

/** By package name. linux-firmware-* is firmware, not the kernel. */
const RULES: Rule[] = [
  { test: /^nginx/, label: 'nginx', care: 'restarts the web server' },
  {
    test: /^apache2/,
    label: 'Apache',
    care: 'restarts the web server',
    service: 'apache2',
  },
  { test: /^php(\d+\.\d+)?-/, label: 'PHP', care: 'restarts PHP-FPM: check the sites after' },
  { test: /^openssh-/, label: 'OpenSSH', care: null },
  { test: /^(openssl|libssl)/, label: 'OpenSSL', care: null },
  { test: /^(mariadb-|libmariadb)/, label: 'MariaDB', care: 'restarts the database' },
  {
    test: /^linux-(image|modules|headers)-|^linux-(generic|virtual|kvm)(-|$)/,
    label: 'the kernel',
    care: 'takes effect only after a restart',
  },
];

export interface Classed {
  /** What it's part of, when that's internet-facing: "OpenSSL", "the kernel". */
  internetFacing: string | null;
  care: string | null;
}

export function classify(name: string, services: Record<string, string>): Classed {
  const rule = RULES.find((r) => r.test.test(name));
  if (!rule) return { internetFacing: null, care: null };
  const running = rule.service === undefined || services[rule.service] === 'active';
  return { internetFacing: running ? rule.label : null, care: rule.care };
}

/**
 * Keeps server_updates in step with a report: a package's clock starts when Kamaji first sees
 * its version waiting, and restarts with a new version. Installed packages go; on a list cut
 * short by the report's cap, missing ones are kept, since they may still be waiting.
 */
export function syncUpdates(
  db: Db,
  serverId: string,
  at: number,
  list: Upgradable[],
  truncated: boolean,
): UpdateRow[] {
  const before = new Map(
    db
      .prepare('SELECT name, to_version, first_seen_at FROM server_updates WHERE server_id = ?')
      .all(serverId)
      .map((r) => [String(r.name), { to: String(r.to_version), at: Number(r.first_seen_at) }]),
  );
  const upsert = db.prepare(
    `INSERT INTO server_updates
       (server_id, name, from_version, to_version, suites, security, esm, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (server_id, name) DO UPDATE SET from_version = excluded.from_version,
       to_version = excluded.to_version, suites = excluded.suites, security = excluded.security,
       esm = excluded.esm, first_seen_at = excluded.first_seen_at`,
  );
  const seen = new Set<string>();
  for (const p of list) {
    seen.add(p.name);
    const was = before.get(p.name);
    const firstSeen = was && was.to === p.to ? was.at : at;
    upsert.run(
      serverId,
      p.name,
      p.from,
      p.to,
      p.suites.join(','),
      p.security ? 1 : 0,
      p.esm ? 1 : 0,
      firstSeen,
    );
  }
  if (!truncated) {
    const drop = db.prepare('DELETE FROM server_updates WHERE server_id = ? AND name = ?');
    for (const name of before.keys()) if (!seen.has(name)) drop.run(serverId, name);
  }
  return updateRows(db, serverId);
}

export function updateRows(db: Db, serverId: string): UpdateRow[] {
  return db
    .prepare('SELECT * FROM server_updates WHERE server_id = ? ORDER BY name')
    .all(serverId)
    .map((r) => ({
      name: String(r.name),
      from: String(r.from_version),
      to: String(r.to_version),
      suites: String(r.suites).split(',').filter(Boolean),
      security: Number(r.security) === 1,
      esm: Number(r.esm) === 1,
      firstSeenAt: Number(r.first_seen_at),
    }));
}

/** A wait in words: "under a day", "1 day", "9 days". */
export function waited(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days < 1) return 'under a day';
  return days === 1 ? '1 day' : `${days} days`;
}

const listed = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export type Level = 'urgent' | 'digest' | 'ok';

/** What one concern means now: raise an issue, clear it, or leave it as it is. */
export type Finding =
  | { action: 'raise'; severity: 'urgent' | 'normal'; summary: string }
  | { action: 'clear'; summary: string }
  | { action: 'keep' };

export interface Rating {
  level: Level;
  /** The rating in words, most pressing first. */
  words: string[];
  security: Finding;
  reboot: Finding;
  stale: Finding;
}

export function rateUpdates(input: {
  server: string;
  now: number;
  rows: UpdateRow[];
  services: Record<string, string>;
  reboot: { required: boolean; since: number | null; packages: string[] };
}): Rating {
  const { server, now, rows, services, reboot } = input;
  const urgent: string[] = [];
  const digest: string[] = [];
  const quiet: string[] = [];

  // Security: ESM never counts.
  const security = rows.filter((r) => r.security && !r.esm);
  const due = security.filter((r) => now - r.firstSeenAt >= SECURITY_GRACE);
  const facing = [
    ...new Set(due.map((r) => classify(r.name, services).internetFacing).filter((l) => l !== null)),
  ];
  let securityFinding: Finding;
  if (security.length === 0) {
    securityFinding = { action: 'clear', summary: `${server}’s security updates are installed` };
  } else if (due.length === 0) {
    securityFinding = { action: 'keep' };
    quiet.push(
      `${security.length} security ${security.length === 1 ? 'update' : 'updates'} seen in the last day: unattended-upgrades usually installs these overnight`,
    );
  } else {
    const oldest = waited(now - Math.min(...due.map((r) => r.firstSeenAt)));
    const count = `${due.length} security ${due.length === 1 ? 'update' : 'updates'}`;
    if (facing.length > 0) {
      urgent.push(`Security updates for ${listed(facing)}, waiting ${oldest}`);
      securityFinding = {
        action: 'raise',
        severity: 'urgent',
        summary: `${server}: security updates for ${listed(facing)} waiting over a day (${count} in all)`,
      };
    } else {
      digest.push(`${count} waiting ${oldest}`);
      securityFinding = {
        action: 'raise',
        severity: 'normal',
        summary: `${server}: ${count} waiting for over a day`,
      };
    }
  }

  // A pending restart: urgent after 7 days.
  let rebootFinding: Finding;
  if (!reboot.required) {
    rebootFinding = { action: 'clear', summary: `${server} has restarted` };
  } else {
    const pending = reboot.since === null ? null : now - reboot.since;
    const why = reboot.packages.length > 0 ? ` for ${listed(reboot.packages.slice(0, 3))}` : '';
    if (pending !== null && pending > REBOOT_URGENT) {
      urgent.push(`A restart pending for ${waited(pending)}${why}`);
      rebootFinding = {
        action: 'raise',
        severity: 'urgent',
        summary: `${server} has needed a restart for ${waited(pending)} to finish updates`,
      };
    } else {
      digest.push(`A restart pending${pending === null ? '' : ` for ${waited(pending)}`}${why}`);
      rebootFinding = {
        action: 'raise',
        severity: 'normal',
        summary: `${server} needs a restart to finish updates`,
      };
    }
  }

  // Ordinary updates piling up: 20 or more, the oldest over 30 days.
  const ordinary = rows.filter((r) => !r.security && !r.esm);
  const oldestOrdinary = ordinary.length
    ? now - Math.min(...ordinary.map((r) => r.firstSeenAt))
    : 0;
  let staleFinding: Finding;
  if (ordinary.length >= STALE_COUNT && oldestOrdinary > STALE_AGE) {
    const words = `${ordinary.length} ordinary updates waiting, the oldest for ${waited(oldestOrdinary)}`;
    digest.push(words);
    staleFinding = { action: 'raise', severity: 'normal', summary: `${server}: ${words}` };
  } else {
    staleFinding = { action: 'clear', summary: `${server}’s ordinary updates are in hand` };
    if (ordinary.length > 0) {
      quiet.push(`${ordinary.length} ordinary ${ordinary.length === 1 ? 'update' : 'updates'}`);
    }
  }

  const level: Level = urgent.length ? 'urgent' : digest.length ? 'digest' : 'ok';
  const words = [...urgent, ...digest, ...quiet];
  return {
    level,
    words: words.length ? words : ['Up to date'],
    security: securityFinding,
    reboot: rebootFinding,
    stale: staleFinding,
  };
}
