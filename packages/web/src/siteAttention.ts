// "Needs a look" at the top of a site's page: one short line per thing to act on, each pointing at
// the card that has the evidence. Raw errors and explanations stay in that card. Backup problems
// are grouped into one line; the card lists them separately. Built from the same status lines as
// the tiles (siteStatus.ts), so the two never disagree.
import type { CareHello, Inventory, SiteBackupsResponse, SiteDetailResponse } from '@kamaji/shared';
import {
  backups,
  certificate,
  CURRENT_FOR,
  fromOutside,
  homePage,
  isOutOfDate,
  updates,
  type StatusLine,
} from './siteStatus';

export interface Look {
  text: string;
  tone: 'red' | 'amber';
  /** The element to open and move to, and the link's words. */
  target: string;
  action: string;
}

/** What in a good handshake deserves a look, in a few words each. */
export function capabilityProblems(hello: CareHello): string[] {
  const c = hello.capabilities;
  return [
    !c.can_update && 'can’t update',
    c.maintenance.present && 'a .maintenance file is present',
    !c.loopback.ok && 'loopback blocked',
    hello.multisite && 'multisite isn’t supported',
  ].filter((p): p is string => typeof p === 'string');
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A check's line, when it needs a look: failing, or a pass that's out of date. */
function checkLook(line: StatusLine): Look | null {
  if (line.tone === 'red' || line.tone === 'amber')
    return {
      text: `${line.label}: ${lower(line.state)}`,
      tone: line.tone,
      target: 'checks',
      action: 'Inspect check',
    };
  if (line.outOfDate)
    return {
      text: `${line.label}: check out of date`,
      tone: 'amber',
      target: 'checks',
      action: 'Inspect check',
    };
  return null;
}

/** Each component's known vulnerabilities, informational notes left out. */
export function componentFindings(inv: Inventory): { name: string; count: number }[] {
  const all = [
    { name: 'WordPress', vs: inv.core.vulnerabilities },
    ...inv.plugins.map((p) => ({ name: p.name, vs: p.vulnerabilities })),
    ...inv.themes.map((t) => ({ name: t.name, vs: t.vulnerabilities })),
  ];
  return all
    .map(({ name, vs }) => ({ name, count: vs.filter((v) => !v.informational).length }))
    .filter((c) => c.count > 0);
}

function softwareLooks(detail: SiteDetailResponse, now: number): Look[] {
  if (detail.site.mode !== 'connected' || !detail.inventory.known) return [];
  const inv = detail.inventory.value;
  const looks: Look[] = componentFindings(inv).map((c) => ({
    text: `${c.name}: ${c.count} known ${c.count === 1 ? 'vulnerability' : 'vulnerabilities'}`,
    tone: 'red',
    target: 'security',
    action: 'Review software',
  }));
  if (inv.vulnerabilityData.known && inv.vulnerabilityData.value.stale)
    looks.push({
      text: 'Vulnerability data: out of date',
      tone: 'amber',
      target: 'security',
      action: 'Review software',
    });
  for (const h of inv.siteHealth)
    looks.push({
      text: `Site Health: ${lower(h.label)}`,
      tone: 'amber',
      target: 'site-health',
      action: 'Review software',
    });
  if (inv.lastFailure)
    looks.push({
      text: 'Inventory: the latest report failed',
      tone: 'amber',
      target: 'software',
      action: 'Review software',
    });
  else if (isOutOfDate(inv.reportedAt, CURRENT_FOR.report, now))
    looks.push({
      text: 'Inventory: out of date',
      tone: 'amber',
      target: 'software',
      action: 'Review software',
    });
  return looks;
}

function connectionLooks(detail: SiteDetailResponse): Look[] {
  const h = detail.handshake;
  if (detail.site.mode !== 'connected' || !h) return [];
  if (!h.result.ok)
    return [
      {
        text: 'Connection: not connected',
        tone: 'red',
        target: 'connection',
        action: 'Inspect connection',
      },
    ];
  return capabilityProblems(h.result.hello).map((p) => ({
    text: `Connection: ${p}`,
    tone: 'amber',
    target: 'connection-diagnostics',
    action: 'Inspect connection',
  }));
}

/** Backups as one line: how many failed, else what's late or unset. */
export function backupLooks(b: SiteBackupsResponse, now: number): Look[] {
  const lines = backups(b, now);
  // A failed attempt counts as failed even where an older good backup keeps it amber.
  const isFailed = (l: StatusLine) => l.tone === 'red' || /failed/i.test(l.state);
  const failed = lines.filter(isFailed);
  const other = lines.filter((l) => !isFailed(l) && (l.tone === 'amber' || l.outOfDate));
  const go = { target: 'backups', action: 'Review backups' };
  if (failed.length > 0)
    return [
      {
        text: `Backups: ${failed.length} failed ${failed.length === 1 ? 'check' : 'checks'}${
          other.length > 0 ? `, ${other.length} more to look at` : ''
        }`,
        tone: 'red',
        ...go,
      },
    ];
  if (other.length === 1) {
    const l = other[0]!;
    if (l.label === 'Backups' && l.state === 'Not set')
      return [
        {
          text: 'Backups: not set for updates',
          tone: 'amber',
          target: 'configure',
          action: 'Configure',
        },
      ];
    return [
      {
        text: `Backups: ${lower(l.label)} ${l.outOfDate && l.tone !== 'amber' ? 'out of date' : lower(l.state)}`,
        tone: 'amber',
        ...go,
      },
    ];
  }
  if (other.length > 1)
    return [{ text: `Backups: ${other.length} to look at`, tone: 'amber', ...go }];
  return [];
}

export function siteLooks(
  detail: SiteDetailResponse,
  backupData: SiteBackupsResponse | null,
  now: number,
): Look[] {
  const { site } = detail;
  const waiting = updates(site);
  return [
    ...[homePage(site, now), fromOutside(site, now), certificate(site)]
      .map(checkLook)
      .filter((l): l is Look => l !== null),
    ...softwareLooks(detail, now),
    ...(waiting.tone === 'amber' || waiting.tone === 'red'
      ? [
          {
            text: `Updates: ${waiting.state}`,
            tone: waiting.tone,
            target: 'updates',
            action: 'Review updates',
          },
        ]
      : []),
    ...connectionLooks(detail),
    ...(backupData ? backupLooks(backupData, now) : []),
  ];
}
