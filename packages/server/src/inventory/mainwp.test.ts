import { readFileSync } from 'node:fs';
import type { Inventory } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { MU_PLUGINS_UNREAD } from './report.js';
import { compare, MainwpAbandoned, MainwpList, MainwpSite, type MainwpExport } from './mainwp.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const mainwp: MainwpExport = {
  site: MainwpSite.parse(fixture('mainwp-site.json')),
  plugins: MainwpList.parse(fixture('mainwp-plugins.json')),
  themes: MainwpList.parse(fixture('mainwp-themes.json')),
  abandoned: MainwpAbandoned.parse(fixture('mainwp-abandoned.json')),
};

const listed = {
  status: 'listed' as const,
  latestVersion: null,
  lastUpdated: null,
  tested: null,
  checkedAt: '2026-11-09T09:00:00.000Z',
};

const inventory = (): Inventory => ({
  reportedAt: '2026-11-09T09:05:00.000Z',
  wordpressCheckedAt: { core: null, plugins: null, themes: null },
  core: { version: '7.1.4', locale: 'en_US', offer: null, vulnerabilities: [] },
  vulnerabilityData: { known: false, reason: 'test' },
  php: '8.3.6',
  database: '10.11.14-MariaDB',
  endOfLife: {
    php: { product: 'PHP', line: '8.3', endsOn: '2027-12-31', state: 'supported' },
    database: { product: 'MariaDB', line: '10.11', endsOn: '2028-02-16', state: 'supported' },
  },
  plugins: [
    {
      file: 'craftish-care/craftish-care.php',
      slug: 'craftish-care',
      name: 'Craftish Care',
      version: '0.1.0',
      active: true,
      autoUpdate: false,
      offer: null,
      directory: { status: 'not-listed', checkedAt: '2026-11-09T09:00:00.000Z' },
      vulnerabilities: [],
    },
    {
      file: 'example-cache/cache.php',
      slug: 'example-cache',
      name: 'Example Cache',
      version: '1.0.4',
      active: false,
      autoUpdate: false,
      offer: null,
      directory: listed,
      vulnerabilities: [],
    },
    {
      file: 'example-forms/example-forms.php',
      slug: 'example-forms',
      name: 'Example Forms',
      version: '2.1.0',
      active: true,
      autoUpdate: false,
      offer: { version: '2.2.0', hasPackage: true },
      directory: listed,
      vulnerabilities: [],
    },
  ],
  muPlugins: { known: false, reason: MU_PLUGINS_UNREAD },
  themes: [
    {
      stylesheet: 'example-theme',
      name: 'Example Theme',
      version: '1.0',
      active: true,
      parent: null,
      autoUpdate: false,
      offer: null,
      vulnerabilities: [],
    },
    {
      stylesheet: 'twentytwentyfive',
      name: 'Twenty Twenty-Five',
      version: '1.5',
      active: false,
      parent: null,
      autoUpdate: false,
      offer: null,
      vulnerabilities: [],
    },
  ],
  siteHealth: [],
  lastFailure: null,
});

describe('comparing with MainWP', () => {
  it('matches when the two agree, leaving each tool’s own plugin and MainWP’s gaps as notes', () => {
    const result = compare(inventory(), mainwp);
    expect(result.differences).toEqual([]);
    expect(result.matched).toContain('example-forms/example-forms.php update');
    expect(result.notes).toEqual([
      'example-mu.php: Must-use; Kamaji reads these from Craftish Care 0.2.0',
      'craftish-care/craftish-care.php: only in Kamaji',
      'mainwp-child/mainwp-child.php: only in MainWP',
      'theme example-theme: MainWP has no version; Kamaji 1.0',
      'theme twentytwentyfive: only in Kamaji',
      'Kamaji reported 2026-11-09T09:05:00.000Z; MainWP last synced 2026-11-09T09:09:53',
    ]);
  });

  it('notes an update installed between the two reads, and a theme neither knows a version for', () => {
    const ours = inventory();
    ours.plugins[2]!.version = '2.2.0';
    ours.plugins[2]!.offer = null;
    ours.themes[0]!.version = '';
    const theirs = structuredClone(mainwp);
    theirs.themes.data[0]!.version = '';
    const result = compare(ours, theirs);
    expect(result.differences).toEqual([]);
    expect(result.matched).toContain('theme example-theme version');
    expect(result.notes).toContain(
      'example-forms/example-forms.php: updated 2.1.0 → 2.2.0 since MainWP’s sync',
    );
  });

  it('compares must-use plugins once Craftish Care reports them', () => {
    const ours = inventory();
    ours.muPlugins = {
      known: true,
      value: [
        { file: 'example-mu.php', name: 'Example Must-use', version: '1.0.1' },
        { file: 'host-mu.php', name: 'Host', version: '3.0' },
      ],
    };
    expect(compare(ours, mainwp).differences).toEqual([
      'example-mu.php version: Kamaji 1.0.1, MainWP 1.0.0',
      'host-mu.php: must-use, only in Kamaji',
    ]);
  });

  it('names every difference', () => {
    const ours = inventory();
    ours.core.version = '7.1.3';
    ours.plugins[1]!.version = '1.0.3';
    ours.plugins[2]!.offer = null;
    ours.plugins = ours.plugins
      .filter((p) => p.slug !== 'example-cache')
      .concat({
        ...ours.plugins[1]!,
        file: 'extra/extra.php',
        slug: 'extra',
      });
    ours.plugins[2]!.directory = {
      status: 'closed',
      closedDate: null,
      reason: null,
      checkedAt: '',
    };
    expect(compare(ours, mainwp).differences).toEqual([
      'WordPress: Kamaji 7.1.3, MainWP 7.1.4',
      'example-forms/example-forms.php update: Kamaji none, MainWP 2.2.0',
      'extra/extra.php: only in Kamaji',
      'example-cache/cache.php: only in MainWP',
      'abandoned plugins: Kamaji 1, MainWP 0',
    ]);
  });
});
