// Whether a rule takes an update (ops/rules-plan.md, "What a rule is"): one pure function, so the
// app's preview, the app making a rule's run and the updater checking that run before it sends
// anything all decide the same way. What goes in is the signed rule and the facts about one
// update; where those facts come from is the caller's business, and the updater gets them from
// the site and from wordpress.org itself (rules/check.ts), never from the site's row.
import { compareVersions, type RuleBody, type RuleSite } from '@kamaji/shared';

export const DAY = 24 * 60 * 60_000;

/** Never taken by a rule, whatever it says: Kamaji's own plugin updates from its own channel. */
export const NEVER = new Set(['craftish-care']);

export type ChangeKind = 'major' | 'minor' | 'patch' | 'not newer';

/**
 * How big a change is, by its numbering: the first part is major (as `isMajor` in
 * updates/queue.ts), the second minor, anything after it a patch. A missing part reads as 0, so
 * 5.3 → 5.3.1 is a patch. Many plugins don't number by these rules; the wait and "leave out" are
 * the answers to that, not this.
 */
export function changeKind(from: string, to: string): ChangeKind {
  if (compareVersions(to, from) <= 0) return 'not newer';
  const parts = (v: string) => v.split(/[.-]/);
  const [a, b] = [parts(from), parts(to)];
  if ((a[0] ?? '0') !== (b[0] ?? '0')) return 'major';
  if ((a[1] ?? '0') !== (b[1] ?? '0')) return 'minor';
  return 'patch';
}

/** wordpress.org's latest release of a plugin or theme, and when it went out. */
export interface Release {
  version: string;
  at: number;
}

/** The facts about one update on one site, wherever they came from. */
export interface Candidate {
  siteId: string;
  type: 'core' | 'plugin' | 'theme';
  /** The plugin's slug, or the theme's stylesheet. */
  slug: string;
  from: string;
  to: string;
  /** WordPress offers it with a package it can install. */
  package: boolean;
  /** It fixes a known vulnerability (Kamaji's Wordfence records). */
  security: boolean;
  /** Its latest release on wordpress.org, or why there's none to go by. */
  release: Release | string;
  /** Kamaji rolled this item back from exactly this version, and it's still rolled back. */
  rolledBack: boolean;
}

export type Verdict = { ok: true } | { ok: false; why: string };

const no = (why: string): Verdict => ({ ok: false, why });
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** The rule's site entry, when the rule names that site. */
export const ruleSite = (rule: RuleBody, siteId: string): RuleSite | undefined =>
  rule.sites.find((s) => s.id === siteId);

/** Whether `rule` takes this update now, or the first reason it doesn't. */
export function matchItem(rule: RuleBody, c: Candidate, now: number): Verdict {
  if (!ruleSite(rule, c.siteId)) return no('the rule doesn’t name this site');
  if (c.type === 'core') return no('a rule never updates WordPress itself');
  if (!rule.types.includes(c.type)) return no(`the rule doesn’t cover ${c.type}s`);
  if (NEVER.has(c.slug)) return no('Craftish Care updates only from its own channel');
  if (rule.only.length > 0 && !rule.only.includes(c.slug))
    return no('the rule names other plugins and themes');
  if (rule.leaveOut.includes(c.slug)) return no('the rule leaves it out');
  if (!c.package) return no('WordPress offers it without a package');
  const kind = changeKind(c.from, c.to);
  if (kind === 'not newer') return no('the offer isn’t newer than what’s installed');
  if (kind === 'major') return no('a major version');
  if (rule.change === 'patch' && kind !== 'patch')
    return no('a minor version, and the rule takes patches only');
  if (rule.change === 'security' && !c.security) return no('not a security fix');
  if (c.rolledBack) return no('Kamaji rolled it back from this version');
  if (typeof c.release === 'string') return no(c.release);
  if (c.release.version !== c.to)
    return no(`wordpress.org’s latest is ${c.release.version}, not the version offered`);
  const wait = c.security ? rule.securityWaitDays : rule.waitDays;
  const out = now - c.release.at;
  if (out < wait * DAY)
    return no(
      `out ${days(Math.max(0, Math.floor(out / DAY)))}; the rule waits ${days(wait)}${c.security ? ' for a security fix' : ''}`,
    );
  return { ok: true };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The rule as a sentence, for the Rules page. */
export function ruleWords(rule: RuleBody, siteNames: Map<string, string>): string {
  const change = {
    patch: 'Patch updates',
    minor: 'Patch and minor updates',
    security: 'Security fixes, short of a major version,',
  }[rule.change];
  const what =
    rule.only.length > 0
      ? `to ${rule.only.join(', ')}`
      : `to any ${rule.types.length === 2 ? 'plugin or theme' : rule.types[0]}`;
  const except = rule.leaveOut.length > 0 ? `, except ${rule.leaveOut.join(', ')},` : '';
  const sites = rule.sites.map((s) => siteNames.get(s.id) ?? s.id);
  const on =
    sites.length === 1
      ? sites[0]
      : `${sites.slice(0, -1).join(', ')} and ${sites[sites.length - 1]}`;
  const wait =
    rule.waitDays === rule.securityWaitDays
      ? `${days(rule.waitDays)} after wordpress.org releases them`
      : `${days(rule.waitDays)} after wordpress.org releases them (${rule.securityWaitDays === 0 ? 'security fixes at once' : `security fixes after ${days(rule.securityWaitDays)}`})`;
  const hour = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return `${change} ${what}${except} on ${on}, ${wait}. Set out with “Ready to update” on ${WEEKDAYS[rule.when.weekday]}s at ${hour(rule.when.hour)}, run from ${hour(rule.when.hour + 1)}.`;
}
