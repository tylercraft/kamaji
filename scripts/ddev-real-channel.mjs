// Laptop only: the DDEV step of a Craftish Care release (docs/protocol.md, "Self-update"), on
// the real channel. Installs a published zip from worker/channel/craftish-care/ over the DDEV
// copy (keeping its stored dev request keys), stores the real release key's public half from
// Doppler's checker config, and asks WordPress what the channel offers. Only that public half is
// read. The next `npm run test:plugin` puts the dev keys back.
//   node scripts/ddev-real-channel.mjs 0.2.0
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';

const DOPPLER = '/opt/homebrew/bin/doppler';
const version = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/ddev-real-channel.mjs <installed version, like 0.2.0>');
  process.exit(1);
}
const zipName = `craftish-care-${version}.zip`;
const zip = new URL(`../worker/channel/craftish-care/${zipName}`, import.meta.url);
if (!existsSync(zip)) {
  console.error(`No ${zipName} in worker/channel/craftish-care/: build and commit it first.`);
  process.exit(1);
}
const wordpress = new URL('../dev/wordpress/', import.meta.url);

const fromChecker = (name) => {
  const r = spawnSync(
    DOPPLER,
    ['secrets', 'get', name, '--plain', '--project', 'kamaji', '--config', 'checker'],
    { encoding: 'utf8' },
  );
  return r.status === 0 ? r.stdout.trim() : '';
};
const publicKey = fromChecker('KAMAJI_CARE_RELEASE_PUBLIC_KEY');
if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) {
  console.error('KAMAJI_CARE_RELEASE_PUBLIC_KEY in kamaji/checker is missing or not a public key.');
  process.exit(1);
}
const keyId = fromChecker('KAMAJI_CARE_RELEASE_KEY_ID') || 'p1';

const wp = (...args) =>
  execFileSync('ddev', ['wp', ...args], { cwd: wordpress, encoding: 'utf8' }).trim();
const synced = () => execFileSync('ddev', ['mutagen', 'sync'], { cwd: wordpress, stdio: 'ignore' });

// The plugin tests' channel, if a run left it behind.
rmSync(new URL('wp-content/mu-plugins/kamaji-test-channel.php', wordpress), { force: true });
copyFileSync(zip, new URL(zipName, wordpress));
synced();
try {
  wp('plugin', 'install', `/var/www/html/${zipName}`, '--force');
} finally {
  rmSync(new URL(zipName, wordpress), { force: true });
  synced();
}
// Deleted first: the plugin's release key, the last release it verified, and WordPress's cached
// offers, so each is set or asked again.
for (const args of [
  ['option', 'delete', 'craftish_care_release_key'],
  ['option', 'delete', 'craftish_care_release'],
  ['transient', 'delete', 'update_plugins', '--network'],
]) {
  try {
    execFileSync('ddev', ['wp', ...args], { cwd: wordpress, stdio: 'ignore' });
  } catch {
    // Nothing cached.
  }
}
wp(
  'option',
  'add',
  'craftish_care_release_key',
  JSON.stringify({ use: 'release', id: keyId, public: publicKey }),
  '--format=json',
  '--autoload=no',
);
console.log(
  wp(
    'plugin',
    'list',
    '--name=craftish-care',
    '--fields=name,status,version,update,update_version',
    '--format=table',
  ),
);
