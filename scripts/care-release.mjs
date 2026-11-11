// Laptop only: builds a Craftish Care release for the signed channel (docs/protocol.md,
// "Self-update") from plugin/craftish-care, into a folder to publish: info.json and the zip.
// The release key comes from Doppler, never a file:
//   doppler run --project kamaji --config release -- node scripts/care-release.mjs --out <dir>
// --channel defaults to the real one; the DDEV tests pass their own.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildRelease } from '../packages/server/dist/care/release.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    channel: { type: 'string', default: 'https://care.craftish.dev/craftish-care/' },
  },
});
const seed = process.env.KAMAJI_CARE_RELEASE_KEY;
if (!values.out || !seed) {
  console.error('Needs --out and KAMAJI_CARE_RELEASE_KEY (from doppler run --config release).');
  process.exit(1);
}
const pluginDir = new URL('../plugin/craftish-care', import.meta.url).pathname;
const release = buildRelease(
  pluginDir,
  { id: process.env.KAMAJI_CARE_RELEASE_KEY_ID ?? 'p1', seed },
  values.channel,
  new Date(),
);
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, release.zipName), release.zip);
writeFileSync(join(values.out, 'info.json'), `${JSON.stringify(release.info, null, 2)}\n`);
console.log(
  `Built Craftish Care ${release.info.version}: ${release.zipName} and info.json in ${values.out}`,
);
