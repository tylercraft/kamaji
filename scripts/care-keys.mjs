// Laptop only: makes dev/care-keys.env, the craftish-care keys for the local DDEV WordPress
// (dev/README.md): report, update, and release (which signs test releases). Never used for a
// real site: those keys live in Doppler. Leaves existing keys alone, so the DDEV site's installed
// copy keeps working, and adds only what's missing.
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../dev/care-keys.env', import.meta.url);
const seed = () => {
  const der = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('base64');
};
if (!existsSync(path)) {
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
}
if (!/^KAMAJI_CARE_RELEASE_KEY=/m.test(readFileSync(path, 'utf8'))) {
  appendFileSync(
    path,
    ['KAMAJI_CARE_RELEASE_KEY_ID=p1', `KAMAJI_CARE_RELEASE_KEY=${seed()}`, ''].join('\n'),
  );
  console.log('Added a release key to dev/care-keys.env.');
} else {
  console.log('dev/care-keys.env already has all three keys; leaving it.');
}
