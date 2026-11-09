// Laptop only: makes dev/care-keys.env, the two craftish-care keys for the local DDEV WordPress
// (dev/README.md). Never used for a real site: those keys live in Doppler. Leaves an existing
// file alone, so the DDEV site's installed copy keeps working.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const path = new URL('../dev/care-keys.env', import.meta.url);
if (existsSync(path)) {
  console.log('dev/care-keys.env already exists; leaving it.');
  process.exit(0);
}
const seed = () => {
  const der = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('base64');
};
writeFileSync(
  path,
  [
    '# Local development only (scripts/care-keys.mjs). Not for any real site.',
    'KAMAJI_CARE_REPORT_KEY_ID=r1',
    `KAMAJI_CARE_REPORT_KEY=${seed()}`,
    'KAMAJI_CARE_UPDATE_KEY_ID=u1',
    `KAMAJI_CARE_UPDATE_KEY=${seed()}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log('Wrote dev/care-keys.env.');
