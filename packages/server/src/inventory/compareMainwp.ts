// npm run compare:mainwp [-- --dir scratch/mainwp] [--kamaji URL] [--login LOGIN] [site ...]
// Laptop only. Reads each pilot site's inventory from Kamaji (on the tailnet, where serve adds
// the login) and MainWP's exported files, and prints what matches and what doesn't. Exits 1 on
// any difference.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SiteDetailResponse } from '@kamaji/shared';
import type { z } from 'zod';
import { compare, MainwpAbandoned, MainwpList, MainwpSite, type MainwpExport } from './mainwp.js';

const PILOT = ['aleyahoerlein.com', 'photogravure.com', 'mintonhomesllc.com'];

const { values, positionals } = parseArgs({
  options: {
    dir: { type: 'string', default: 'scratch/mainwp' },
    kamaji: { type: 'string', default: 'https://molcajete.tailb3044a.ts.net:10002' },
    // Only for a local server without tailscale serve in front.
    login: { type: 'string' },
  },
  allowPositionals: true,
});

function read<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  return schema.parse(JSON.parse(readFileSync(join(values.dir, file), 'utf8')));
}

function mainwpExport(site: string): MainwpExport {
  return {
    site: read(`${site}-site.json`, MainwpSite),
    plugins: read(`${site}-plugins.json`, MainwpList),
    themes: read(`${site}-themes.json`, MainwpList),
    abandoned: read(`${site}-abandoned.json`, MainwpAbandoned),
  };
}

async function kamajiDetail(site: string) {
  const response = await fetch(`${values.kamaji}/api/sites/${site}`, {
    headers: values.login ? { 'Tailscale-User-Login': values.login } : {},
  });
  if (!response.ok) throw new Error(`Kamaji answered ${response.status} for ${site}`);
  return SiteDetailResponse.parse(await response.json());
}

let mismatched = false;
for (const site of positionals.length > 0 ? positionals : PILOT) {
  console.log(`\n${site}`);
  let detail;
  try {
    detail = await kamajiDetail(site);
  } catch (error) {
    console.log(`  Couldn’t read Kamaji: ${error instanceof Error ? error.message : 'error'}`);
    mismatched = true;
    continue;
  }
  if (!detail.inventory.known) {
    console.log(`  No inventory in Kamaji: ${detail.inventory.reason}`);
    mismatched = true;
    continue;
  }
  const result = compare(detail.inventory.value, mainwpExport(site));
  console.log(`  ${result.matched.length} match`);
  for (const line of result.differences) console.log(`  DIFFERENT  ${line}`);
  for (const line of result.notes) console.log(`  note       ${line}`);
  if (result.differences.length > 0) mismatched = true;
}
console.log(mismatched ? '\nNot a match yet.' : '\nKamaji matches MainWP for every site.');
process.exit(mismatched ? 1 : 0);
