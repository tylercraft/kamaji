// Each cycle's site checks: the home page and the certificate for every live site, recorded as
// observations, then issues raised or cleared from them.
//
// - down (urgent): two failed home page checks in a row; cleared by the next pass.
// - certificate: 14 days or fewer left (urgent at 7 or fewer); cleared once renewed.
// - kamaji offline: every site failed at once, which says the mini's connection is out, not
//   that every site is. Those results aren't held against the sites.
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { latestObservations, recordObservation } from '../observations.js';
import {
  checkCertificate,
  checkHomePage,
  type CertificateResult,
  type HomePageResult,
} from './http.js';

export const CERT_WARN_DAYS = 14;
export const CERT_URGENT_DAYS = 7;

export interface LiveSite {
  id: string;
  name: string;
  url: string;
  expectedText: string | null;
}

export interface SiteCheckers {
  homePage: (
    url: string,
    expectedText: string | null,
    signal: AbortSignal,
  ) => Promise<HomePageResult>;
  certificate: (host: string, signal: AbortSignal) => Promise<CertificateResult>;
}

export const realCheckers: SiteCheckers = {
  homePage: (url, expectedText, signal) => checkHomePage(url, expectedText, { signal }),
  certificate: (host, signal) => checkCertificate(host, { signal }),
};

export function liveSites(db: Db): LiveSite[] {
  return db
    .prepare(
      `SELECT id, name, url, expected_text FROM sites
       WHERE removed_at IS NULL AND paused_at IS NULL AND setup = 'done'
       ORDER BY name COLLATE NOCASE`,
    )
    .all()
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      url: String(r.url),
      expectedText: r.expected_text === null ? null : String(r.expected_text),
    }));
}

/** Runs fn over items, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const OFFLINE = { resourceType: 'kamaji', resourceId: 'molcajete', kind: 'offline' } as const;

/** Checks every live site once. Returns how many it checked. */
export async function checkSites(
  db: Db,
  options: {
    now: () => number;
    signal: AbortSignal;
    checkers?: SiteCheckers;
    concurrency?: number;
  },
): Promise<number> {
  const { now, signal } = options;
  const checkers = options.checkers ?? realCheckers;
  const sites = liveSites(db);
  if (sites.length === 0) return 0;

  const results = await mapLimit(sites, options.concurrency ?? 4, async (site) => {
    const [home, cert] = await Promise.all([
      checkers.homePage(site.url, site.expectedText, signal),
      checkers.certificate(new URL(site.url).hostname, signal),
    ]);
    return { site, home, cert };
  });
  if (signal.aborted) throw signal.reason;

  const at = now();
  const allFailed = sites.length >= 3 && results.every((r) => r.home.status === null);

  transaction(db, () => {
    if (allFailed) {
      raiseIssue(db, at, {
        ...OFFLINE,
        severity: 'normal',
        summary: 'The mini can’t reach any site: its connection looks down',
      });
      return;
    }
    clearIssue(db, at, OFFLINE, 'The mini can reach sites again');
    for (const { site, home, cert } of results) {
      recordObservation(db, {
        resourceType: 'site',
        resourceId: site.id,
        check: 'http',
        source: 'mini',
        at,
        ok: home.ok,
        value: home,
      });
      recordObservation(db, {
        resourceType: 'site',
        resourceId: site.id,
        check: 'certificate',
        source: 'mini',
        at,
        ok: cert.problem === null && (cert.daysLeft ?? 0) > CERT_WARN_DAYS,
        value: cert,
      });
      judgeHomePage(db, at, site);
      judgeCertificate(db, at, site, cert);
    }
  });
  return sites.length;
}

function judgeHomePage(db: Db, at: number, site: LiveSite): void {
  const key = { resourceType: 'site', resourceId: site.id, kind: 'down' } as const;
  const [last, before] = latestObservations<HomePageResult>(db, 'site', site.id, 'http', 'mini', 2);
  if (!last) return;
  if (last.ok) {
    clearIssue(db, at, key, `${site.name} is back up`);
  } else if (before && !before.ok) {
    raiseIssue(db, at, {
      ...key,
      severity: 'urgent',
      summary: `${site.name} is down: ${last.value.problem ?? 'the check failed'}`,
    });
  }
}

function judgeCertificate(db: Db, at: number, site: LiveSite, cert: CertificateResult): void {
  const key = { resourceType: 'site', resourceId: site.id, kind: 'certificate' } as const;
  if (cert.daysLeft === null) return; // Unreadable: the home page check reports the connection.
  if (cert.daysLeft > CERT_WARN_DAYS) {
    clearIssue(db, at, key, `${site.name}’s certificate was renewed`);
    return;
  }
  raiseIssue(db, at, {
    ...key,
    severity: cert.daysLeft <= CERT_URGENT_DAYS ? 'urgent' : 'normal',
    summary:
      cert.daysLeft < 0
        ? `${site.name}’s certificate has expired`
        : `${site.name}’s certificate expires in ${cert.daysLeft} ${cert.daysLeft === 1 ? 'day' : 'days'}`,
  });
}
