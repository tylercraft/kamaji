// When each site's domain has to be renewed, read through RDAP once a day. One check per
// registrable domain (the public suffix list, via tldts), so craftish.dev and romaji.craftish.dev
// share one. The registry's RDAP server comes from IANA's bootstrap file, kept for a week. Only
// the expiration event is read from the answer. Both fetches go through the icon fetch's capped
// GET: ten seconds, a size cap, and never a local address after a redirect.
//
// Issues go on one site per domain (the one at the domain itself, else the first by name), so a
// shared domain warns once: domain-expiring 30 days before (urgent at 7), and domain-unreadable
// after three failed reads in a row. A registry without RDAP, or an answer without a date, raises
// nothing: the site page says "Renewal date not available".
import { parse } from 'tldts';
import { z } from 'zod';
import type { Renewal, Site } from '@kamaji/shared';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { readState, writeState } from '../state.js';
import { get, type FetchOptions } from './icons.js';

const DAY = 86_400_000;
export const DOMAIN_EVERY_MS = DAY;
export const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
export const BOOTSTRAP_FOR_MS = 7 * DAY;
const BOOTSTRAP_STATE = 'rdap-bootstrap';
const BOOTSTRAP_BYTES = 512 * 1024;
const ANSWER_BYTES = 256 * 1024;
export const WARN_DAYS = 30;
export const URGENT_DAYS = 7;
export const UNREADABLE_AFTER = 3;
export const NOT_AVAILABLE = 'Renewal date not available';

/** The domain someone registers for this host, or null for an IP, localhost or a bare suffix. */
export function registrableDomain(host: string): string | null {
  const p = parse(host, { allowPrivateDomains: false });
  return !p.isIp && p.isIcann && p.domain ? p.domain.toLowerCase() : null;
}

const domainOf = (site: { url: string }) => registrableDomain(new URL(site.url).hostname);

const Bootstrap = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});
type Services = z.infer<typeof Bootstrap>['services'];

/** The RDAP base URL for a domain: the longest of its suffixes that IANA lists. */
export function rdapServer(services: Services, domain: string): string | null {
  const labels = domain.toLowerCase().split('.');
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    const service = services.find(([suffixes]) => suffixes.includes(suffix));
    const base = service?.[1].find((u) => u.startsWith('https://')) ?? service?.[1][0];
    if (base) return base.endsWith('/') ? base : `${base}/`;
  }
  return null;
}

const Answer = z.object({
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).optional(),
});

/** The expiration event's time in an RDAP domain answer, or null when it has none. */
export function expirationOf(json: unknown): number | null {
  const answer = Answer.safeParse(json);
  if (!answer.success) return null;
  const event = answer.data.events?.find((e) => e.eventAction.toLowerCase() === 'expiration');
  const at = event ? Date.parse(event.eventDate) : NaN;
  return Number.isFinite(at) ? at : null;
}

export type DomainRead =
  | { state: 'ok'; expiresAt: number }
  | { state: 'no-rdap' | 'no-date' }
  | { state: 'failed'; problem: string };

const json = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
};

/** IANA's list, fetched at most once a week; an old copy is used when a new one can't be had. */
async function bootstrap(
  db: Db,
  now: number,
  options: FetchOptions,
): Promise<Services | { problem: string }> {
  const kept = readState<{ fetchedAt: number; services: Services }>(db, BOOTSTRAP_STATE);
  if (kept && now - kept.fetchedAt < BOOTSTRAP_FOR_MS) return kept.services;
  const url = new URL(BOOTSTRAP_URL);
  const got = await get(url, url, 'application/json', BOOTSTRAP_BYTES, 'fail', options);
  const parsed = got.ok ? Bootstrap.safeParse(json(got.bytes)) : null;
  if (parsed?.success) {
    writeState(db, BOOTSTRAP_STATE, { fetchedAt: now, services: parsed.data.services }, now);
    return parsed.data.services;
  }
  if (kept) return kept.services;
  return {
    problem: `IANA’s list of RDAP servers couldn’t be read (${got.ok ? 'not understood' : got.problem})`,
  };
}

/** One domain's expiration date, read now. */
export async function readDomain(
  db: Db,
  domain: string,
  now: number,
  options: FetchOptions = {},
): Promise<DomainRead> {
  const services = await bootstrap(db, now, options);
  if ('problem' in services) return { state: 'failed', problem: services.problem };
  const base = rdapServer(services, domain);
  if (!base) return { state: 'no-rdap' };
  const url = new URL(`domain/${encodeURIComponent(domain)}`, base);
  const got = await get(url, url, 'application/rdap+json', ANSWER_BYTES, 'fail', options);
  if (!got.ok) {
    const problem = got.problem === 'HTTP 404' ? 'the registry doesn’t know it' : got.problem;
    return { state: 'failed', problem };
  }
  const body = json(got.bytes);
  if (body === undefined) return { state: 'failed', problem: 'the answer wasn’t understood' };
  const expiresAt = expirationOf(body);
  return expiresAt === null ? { state: 'no-date' } : { state: 'ok', expiresAt };
}

interface DomainRow {
  checkedAt: number;
  expiresAt: number | null;
  state: DomainRead['state'];
  problem: string | null;
  failures: number;
}

function domainRow(db: Db, domain: string): DomainRow | null {
  const r = db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain);
  return r
    ? {
        checkedAt: Number(r.checked_at),
        expiresAt: r.expires_at === null ? null : Number(r.expires_at),
        state: String(r.state) as DomainRead['state'],
        problem: r.problem === null ? null : String(r.problem),
        failures: Number(r.failures),
      }
    : null;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What the site page and the Sites list show for a site's domain. */
export function renewalFor(db: Db, site: Site): Renewal | null {
  const domain = domainOf(site);
  if (!domain) return null;
  const row = domainRow(db, domain);
  if (!row) return { domain, expiresOn: null, note: 'Not checked yet', checkedAt: null };
  const checkedAt = new Date(row.checkedAt).toISOString();
  if (row.state === 'no-rdap' || row.state === 'no-date')
    return { domain, expiresOn: null, note: NOT_AVAILABLE, checkedAt };
  return {
    domain,
    expiresOn: row.expiresAt === null ? null : day(row.expiresAt),
    note: row.state === 'failed' ? `Couldn’t read it: ${row.problem ?? 'unknown'}` : null,
    checkedAt,
  };
}

/** The live sites under each registrable domain, the one at the domain itself first. */
function domainSites(db: Db): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT id, url FROM sites WHERE removed_at IS NULL AND paused_at IS NULL AND setup = 'done'
       ORDER BY name COLLATE NOCASE`,
    )
    .all();
  const out = new Map<string, { id: string; host: string }[]>();
  for (const r of rows) {
    const url = String(r.url);
    const domain = domainOf({ url });
    if (!domain) continue;
    out.set(domain, [
      ...(out.get(domain) ?? []),
      { id: String(r.id), host: new URL(url).hostname },
    ]);
  }
  const rank = (domain: string, host: string) =>
    host === domain ? 0 : host === `www.${domain}` ? 1 : 2;
  return new Map(
    [...out].map(([domain, sites]) => [
      domain,
      [...sites].sort((a, b) => rank(domain, a.host) - rank(domain, b.host)).map((s) => s.id),
    ]),
  );
}

const key = (siteId: string, kind: 'domain-expiring' | 'domain-unreadable') =>
  ({ resourceType: 'site', resourceId: siteId, kind }) as const;

/** Records a read and raises or clears the domain's issues, on its first site only. */
export function judgeDomain(
  db: Db,
  now: number,
  domain: string,
  read: DomainRead,
  siteIds: string[],
): void {
  const before = domainRow(db, domain);
  const failures = read.state === 'failed' ? (before?.failures ?? 0) + 1 : 0;
  // A failed read keeps the last date read; a registry that stops giving one drops it.
  const expiresAt =
    read.state === 'ok'
      ? read.expiresAt
      : read.state === 'failed'
        ? (before?.expiresAt ?? null)
        : null;
  db.prepare(
    `INSERT INTO domains (domain, checked_at, expires_at, state, problem, failures)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (domain) DO UPDATE SET checked_at = excluded.checked_at,
       expires_at = excluded.expires_at, state = excluded.state, problem = excluded.problem,
       failures = excluded.failures`,
  ).run(
    domain,
    now,
    expiresAt,
    read.state,
    read.state === 'failed' ? read.problem : null,
    failures,
  );

  const [first, ...rest] = siteIds;
  for (const id of rest) {
    clearIssue(
      db,
      now,
      key(id, 'domain-expiring'),
      `${domain}’s renewal is watched on another site`,
    );
    clearIssue(
      db,
      now,
      key(id, 'domain-unreadable'),
      `${domain}’s renewal is watched on another site`,
    );
  }
  if (!first) return;

  const daysLeft = expiresAt === null ? null : Math.floor((expiresAt - now) / DAY);
  if (expiresAt === null || daysLeft === null || daysLeft > WARN_DAYS) {
    clearIssue(
      db,
      now,
      key(first, 'domain-expiring'),
      expiresAt === null
        ? `${domain}: no renewal date to watch`
        : `${domain} renews ${day(expiresAt)}`,
    );
  } else {
    raiseIssue(db, now, {
      ...key(first, 'domain-expiring'),
      severity: daysLeft <= URGENT_DAYS ? 'urgent' : 'normal',
      summary:
        daysLeft < 0
          ? `${domain} expired on ${day(expiresAt)}`
          : `${domain} expires ${day(expiresAt)}, in ${daysLeft === 1 ? '1 day' : `${daysLeft} days`}`,
    });
  }

  if (read.state === 'failed' && failures >= UNREADABLE_AFTER) {
    raiseIssue(db, now, {
      ...key(first, 'domain-unreadable'),
      severity: 'normal',
      summary: `Kamaji can’t read ${domain}’s renewal date: ${read.problem}`,
    });
  } else if (read.state !== 'failed') {
    clearIssue(
      db,
      now,
      key(first, 'domain-unreadable'),
      `Kamaji can read ${domain}’s renewal again`,
    );
  }
}

export interface DomainOptions extends FetchOptions {
  now: () => number;
}

/** Reads one domain now and judges it: Check again. */
export async function checkDomain(
  db: Db,
  domain: string,
  options: DomainOptions,
): Promise<DomainRead> {
  const read = await readDomain(db, domain, options.now(), options);
  const sites = domainSites(db).get(domain) ?? [];
  transaction(db, () => judgeDomain(db, options.now(), domain, read, sites));
  return read;
}

/** Every domain not read in the last day, one at a time. Returns how many it read. */
export async function checkDomains(db: Db, options: DomainOptions): Promise<number> {
  let read = 0;
  for (const domain of domainSites(db).keys()) {
    const row = domainRow(db, domain);
    if (row && options.now() - row.checkedAt < DOMAIN_EVERY_MS) continue;
    await checkDomain(db, domain, options);
    read++;
  }
  return read;
}

/** A site's registrable domain, for its Check again route. */
export function siteDomain(db: Db, siteId: string): string | null {
  const r = db.prepare('SELECT url FROM sites WHERE id = ? AND removed_at IS NULL').get(siteId);
  return r ? domainOf({ url: String(r.url) }) : null;
}
