// The Rules page's form, as plain functions (ops/rules-plan.md, "The UI"): what a new rule starts
// as, a rule's body back into the form, and the form into the exact body Tyler signs.
import type { RuleBody, RuleChange, RuleSiteOption, RuleView } from '@kamaji/shared';

export interface RuleForm {
  name: string;
  siteIds: string[];
  plugins: boolean;
  themes: boolean;
  change: RuleChange;
  /** Slugs, as typed: commas, spaces or new lines between them. */
  only: string;
  leaveOut: string;
  waitDays: number;
  securityWaitDays: number;
  perSite: number;
  sites: number;
}

/** A new rule: patch and minor plugin updates, WooCommerce left out, three days' wait. */
export const NEW_RULE: RuleForm = {
  name: '',
  siteIds: [],
  plugins: true,
  themes: false,
  change: 'minor',
  only: '',
  leaveOut: 'woocommerce',
  waitDays: 3,
  securityWaitDays: 0,
  perSite: 10,
  sites: 10,
};

export function formOf(body: RuleBody): RuleForm {
  return {
    name: body.name,
    siteIds: body.sites.map((s) => s.id),
    plugins: body.types.includes('plugin'),
    themes: body.types.includes('theme'),
    change: body.change,
    only: body.only.join(', '),
    leaveOut: body.leaveOut.join(', '),
    waitDays: body.waitDays,
    securityWaitDays: body.securityWaitDays,
    perSite: body.most.perSite,
    sites: body.most.sites,
  };
}

export const slugs = (typed: string) => [
  ...new Set(
    typed
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/**
 * The body to sign: each chosen site with its address and backup as Kamaji has them now, and the
 * update time it runs at. Null with why when it can't be signed yet.
 */
export function bodyOf(
  form: RuleForm,
  ruleId: string | null,
  options: RuleSiteOption[],
  when: { weekday: number; hour: number },
): { ok: true; body: RuleBody } | { ok: false; why: string } {
  if (form.name.trim() === '') return { ok: false, why: 'Give it a name.' };
  const sites = options.filter((o) => form.siteIds.includes(o.id));
  if (sites.length === 0) return { ok: false, why: 'Choose at least one site.' };
  const types = [
    ...(form.plugins ? ['plugin' as const] : []),
    ...(form.themes ? ['theme' as const] : []),
  ];
  if (types.length === 0) return { ok: false, why: 'Choose plugins, themes or both.' };
  return {
    ok: true,
    body: {
      ruleId,
      name: form.name.trim(),
      sites: sites.map((s) => ({ id: s.id, url: s.url, backup: s.backup })),
      types,
      only: slugs(form.only),
      leaveOut: slugs(form.leaveOut),
      change: form.change,
      waitDays: form.waitDays,
      securityWaitDays: form.securityWaitDays,
      when,
      most: { perSite: form.perSite, sites: form.sites },
    },
  };
}

/** A rule's state in a few words, for its heading. */
export function stateWords(rule: RuleView): { tone: 'green' | 'amber' | 'red'; words: string } {
  if (rule.paused)
    return {
      tone: rule.paused.by === 'kamaji' ? 'red' : 'amber',
      words: rule.paused.by === 'kamaji' ? 'Paused itself' : 'Paused',
    };
  if (rule.warnings.length > 0) return { tone: 'amber', words: 'On, with warnings' };
  return { tone: 'green', words: 'On' };
}
