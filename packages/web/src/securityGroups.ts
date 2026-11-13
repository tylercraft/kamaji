// A site's known vulnerabilities per component, and what updating would fix: the offered version
// against each finding's fixed-in version, compared as WordPress compares versions. An offered
// update that fixes only some findings says so; it's never presented as fixing them all.
import { compareVersions, type Inventory, type VulnerabilityMatch } from '@kamaji/shared';

export interface SecurityGroup {
  name: string;
  /** The version WordPress offers for it, or null. */
  offer: string | null;
  /** Known vulnerabilities; informational notes are left out. */
  items: VulnerabilityMatch[];
}

export function securityGroups(inv: Inventory): SecurityGroup[] {
  return [
    { name: 'WordPress', offer: inv.core.offer?.version ?? null, vs: inv.core.vulnerabilities },
    ...inv.plugins.map((p) => ({
      name: p.name,
      offer: p.offer?.version ?? null,
      vs: p.vulnerabilities,
    })),
    ...inv.themes.map((t) => ({
      name: t.name,
      offer: t.offer?.version ?? null,
      vs: t.vulnerabilities,
    })),
  ]
    .map(({ name, offer, vs }) => ({
      name,
      offer,
      // Oldest fix first, no fix last: where the offered version stops helping is easy to see.
      items: vs
        .filter((v) => !v.informational)
        .sort((a, b) =>
          a.fixedIn === null ? 1 : b.fixedIn === null ? -1 : compareVersions(a.fixedIn, b.fixedIn),
        ),
    }))
    .filter((g) => g.items.length > 0);
}

/** What updating does for a component's findings, in a line. */
export function remedy(g: SecurityGroup): string {
  const n = g.items.length;
  const fixes = g.items.map((v) => v.fixedIn).filter((f): f is string => f !== null);
  const unfixed = n - fixes.length;
  const newest = fixes.reduce<string | null>(
    (m, f) => (m === null || compareVersions(f, m) > 0 ? f : m),
    null,
  );
  const noFix = unfixed > 0 ? `${unfixed} ${unfixed === 1 ? 'has' : 'have'} no fix yet` : '';
  if (g.offer === null)
    return newest
      ? [
          `${unfixed > 0 ? `${fixes.length} fixed` : 'Fixed'} by ${newest}, which WordPress isn’t offering here yet`,
          noFix,
        ]
          .filter(Boolean)
          .join('; ')
      : 'No fix yet';
  const offer = g.offer;
  const byOffer = fixes.filter((f) => compareVersions(offer, f) >= 0).length;
  if (byOffer === n) return `The offered ${offer} fixes all ${n}`;
  const later = fixes.length - byOffer;
  return [
    `The offered ${offer} fixes ${byOffer} of ${n}`,
    later > 0 ? `${later} ${later === 1 ? 'needs' : 'need'} ${newest} or later` : '',
    noFix,
  ]
    .filter(Boolean)
    .join('; ');
}
