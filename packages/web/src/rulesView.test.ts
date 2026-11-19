import type { RuleSiteOption, RuleView } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { bodyOf, formOf, NEW_RULE, slugs, stateWords } from './rulesView';

const SITES: RuleSiteOption[] = [
  { id: 'one.test', name: 'One', url: 'https://one.test/', backup: 'kamaji', autoUpdates: [] },
  { id: 'two.test', name: 'Two', url: 'https://two.test/', backup: 'host', autoUpdates: [] },
];
const WHEN = { weekday: 2, hour: 19 };

describe('a rule’s form', () => {
  it('starts as patch and minor plugin updates, WooCommerce left out, three days', () => {
    expect(NEW_RULE).toMatchObject({
      plugins: true,
      themes: false,
      change: 'minor',
      leaveOut: 'woocommerce',
      waitDays: 3,
      securityWaitDays: 0,
    });
  });

  it('signs each site with its address and backup as Kamaji has them, and the update time', () => {
    const built = bodyOf(
      {
        ...NEW_RULE,
        name: ' My sites ',
        siteIds: ['two.test'],
        leaveOut: 'WooCommerce, woo-x\nwoo-x',
      },
      null,
      SITES,
      WHEN,
    );
    expect(built).toEqual({
      ok: true,
      body: {
        ruleId: null,
        name: 'My sites',
        sites: [{ id: 'two.test', url: 'https://two.test/', backup: 'host' }],
        types: ['plugin'],
        only: [],
        leaveOut: ['woocommerce', 'woo-x'],
        change: 'minor',
        waitDays: 3,
        securityWaitDays: 0,
        when: WHEN,
        most: { perSite: 10, sites: 10 },
      },
    });
    if (built.ok)
      expect(formOf(built.body)).toMatchObject({
        siteIds: ['two.test'],
        leaveOut: 'woocommerce, woo-x',
      });
  });

  it('says what’s missing before anything is signed', () => {
    expect(bodyOf(NEW_RULE, null, SITES, WHEN)).toEqual({ ok: false, why: 'Give it a name.' });
    expect(bodyOf({ ...NEW_RULE, name: 'x' }, null, SITES, WHEN)).toEqual({
      ok: false,
      why: 'Choose at least one site.',
    });
    expect(
      bodyOf({ ...NEW_RULE, name: 'x', siteIds: ['one.test'], plugins: false }, null, SITES, WHEN),
    ).toEqual({ ok: false, why: 'Choose plugins, themes or both.' });
    // A site that's no longer one a rule can name is left off, never signed as it was.
    expect(bodyOf({ ...NEW_RULE, name: 'x', siteIds: ['gone.test'] }, null, SITES, WHEN)).toEqual({
      ok: false,
      why: 'Choose at least one site.',
    });
  });

  it('reads slugs however they were typed', () => {
    expect(slugs(' a, b  c\nA ')).toEqual(['a', 'b', 'c']);
  });
});

describe('a rule’s state', () => {
  const rule = (patch: Partial<RuleView>) => ({ paused: null, warnings: [], ...patch }) as RuleView;
  it('red when it paused itself, amber when Tyler did or it has warnings', () => {
    expect(stateWords(rule({}))).toEqual({ tone: 'green', words: 'On' });
    expect(stateWords(rule({ warnings: ['x'] })).tone).toBe('amber');
    expect(stateWords(rule({ paused: { at: '', by: 'kamaji', reason: '' } }))).toEqual({
      tone: 'red',
      words: 'Paused itself',
    });
    expect(stateWords(rule({ paused: { at: '', by: 'tyler', reason: '' } })).words).toBe('Paused');
  });
});
