// Comparing Kamaji's inventory with MainWP's, for M3's done test (calcifer explore/kamaji/plan.md:
// "Kamaji's inventory for the pilot matches MainWP's"). MainWP's side is its REST API v2, saved
// to files (scratch/mainwp, gitignored: they list clients' plugins). Shapes are as captured on
// 2026-11-09; the fixtures are copies with invented names.
import type { Inventory } from '@kamaji/shared';
import { z } from 'zod';

const Item = z.object({
  /** For plugins, MainWP's "slug" is the plugin file, like "akismet/akismet.php". */
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  active: z.boolean(),
  update_version: z.string().nullable(),
});

export const MainwpList = z.object({ success: z.literal(1), data: z.array(Item) });
export const MainwpAbandoned = z.object({
  success: z.literal(1),
  data: z.array(z.record(z.string(), z.unknown())),
});
/** /sites/{domain}: only the fields compared. Its upgrade lists are JSON inside strings. */
export const MainwpSite = z.object({
  data: z.object({
    wp_version: z.string(),
    php_version: z.string(),
    wp_upgrades: z.string(),
    last_sync: z.string(),
  }),
});

export interface MainwpExport {
  site: z.infer<typeof MainwpSite>;
  plugins: z.infer<typeof MainwpList>;
  themes: z.infer<typeof MainwpList>;
  abandoned: z.infer<typeof MainwpAbandoned>;
}

/** Each tool's own plugin: expected on one side only. */
const OWN_PLUGINS = new Set(['mainwp-child/mainwp-child.php', 'craftish-care/craftish-care.php']);

export interface Comparison {
  matched: string[];
  differences: string[];
  /** Expected, or MainWP doesn't know: listed, but not counted against a match. */
  notes: string[];
}

export function compare(kamaji: Inventory, mainwp: MainwpExport): Comparison {
  const matched: string[] = [];
  const differences: string[] = [];
  const notes: string[] = [];
  const same = (label: string, ours: unknown, theirs: unknown) => {
    if (ours === theirs) matched.push(label);
    else differences.push(`${label}: Kamaji ${String(ours)}, MainWP ${String(theirs)}`);
  };

  const site = mainwp.site.data;
  same('WordPress', kamaji.core.version, site.wp_version);
  same('PHP', kamaji.php, site.php_version);
  let coreOffers: unknown[] = [];
  try {
    coreOffers = z.array(z.unknown()).parse(JSON.parse(site.wp_upgrades || '[]'));
  } catch {
    notes.push('MainWP’s core update list couldn’t be read');
  }
  if (coreOffers.length > 0) {
    notes.push(
      `MainWP lists a core update, in a shape not seen yet; Kamaji says ${kamaji.core.offer?.version ?? 'none'}`,
    );
  } else {
    same('WordPress update', kamaji.core.offer?.version ?? 'none', 'none');
  }

  const ours = new Map(kamaji.plugins.map((p) => [p.file, p]));
  const theirs = new Map(mainwp.plugins.data.map((p) => [p.slug, p]));
  for (const file of new Set([...ours.keys(), ...theirs.keys()])) {
    const k = ours.get(file);
    const m = theirs.get(file);
    if (!k || !m) {
      const where = k ? 'Kamaji' : 'MainWP';
      (OWN_PLUGINS.has(file) ? notes : differences).push(`${file}: only in ${where}`);
      continue;
    }
    same(`${file} version`, k.version, m.version);
    same(`${file} active`, k.active, m.active);
    same(`${file} update`, k.offer?.version ?? 'none', m.update_version ?? 'none');
  }

  const ourThemes = new Map(kamaji.themes.map((t) => [t.stylesheet, t]));
  const theirThemes = new Map(mainwp.themes.data.map((t) => [t.slug, t]));
  for (const slug of new Set([...ourThemes.keys(), ...theirThemes.keys()])) {
    const k = ourThemes.get(slug);
    const m = theirThemes.get(slug);
    if (!k || !m) {
      // MainWP listed only the active theme on every pilot site; an inactive one only in
      // Kamaji is worth a look, not a mismatch.
      (k && !k.active ? notes : differences).push(
        `theme ${slug}: only in ${k ? 'Kamaji' : 'MainWP'}`,
      );
      continue;
    }
    if (m.version === '') notes.push(`theme ${slug}: MainWP has no version; Kamaji ${k.version}`);
    else same(`theme ${slug} version`, k.version, m.version);
    same(`theme ${slug} active`, k.active, m.active);
    same(`theme ${slug} update`, k.offer?.version ?? 'none', m.update_version ?? 'none');
  }

  const closed = kamaji.plugins.filter((p) => p.directory?.status === 'closed').length;
  same('abandoned plugins', closed, mainwp.abandoned.data.length);
  const unasked = kamaji.plugins.filter((p) => p.directory === null).length;
  if (unasked > 0) notes.push(`${unasked} plugins not yet looked up on wordpress.org`);
  if (kamaji.lastFailure)
    notes.push(`Kamaji’s latest report failed: ${kamaji.lastFailure.problem}`);
  notes.push(`Kamaji reported ${kamaji.reportedAt}; MainWP last synced ${site.last_sync}`);
  return { matched, differences, notes };
}
