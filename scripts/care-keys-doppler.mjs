// Laptop only, once: makes craftish-care's two real key pairs (docs/protocol.md, "Keys") and
// sends each half straight into Doppler, project kamaji, so no key is ever shown, saved or
// pasted. checker gets the report key's seed and the update key's public half; updater (M4's)
// gets the update key's seed and nothing else. Refuses to replace a key: sites installed with
// the old public keys would stop answering.
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

const DOPPLER = '/opt/homebrew/bin/doppler';
const PROJECT = 'kamaji';

const pair = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    seed: pkcs8.subarray(pkcs8.length - 32).toString('base64'),
    publicKey: spki.subarray(spki.length - 32).toString('base64'),
  };
};

const doppler = (args, input) =>
  spawnSync(DOPPLER, [...args, '--project', PROJECT], {
    input,
    encoding: 'utf8',
    // Only names ever come back on stdout; set's output is thrown away unread.
    stdio: ['pipe', input === undefined ? 'pipe' : 'ignore', 'pipe'],
  });

const names = (config) => {
  const r = doppler(['secrets', '--config', config, '--only-names', '--json']);
  if (r.status !== 0) {
    console.error(`Couldn’t list ${PROJECT}/${config}: ${r.stderr.trim().split('\n')[0]}`);
    process.exit(1);
  }
  return new Set(Object.keys(JSON.parse(r.stdout)));
};

const report = pair();
const update = pair();
const plan = [
  ['updater', 'KAMAJI_CARE_UPDATE_KEY', update.seed],
  ['checker', 'KAMAJI_CARE_UPDATE_PUBLIC_KEY', update.publicKey],
  ['checker', 'KAMAJI_CARE_REPORT_KEY', report.seed],
];

const existing = { checker: names('checker'), updater: names('updater') };
const taken = plan.filter(([config, name]) => existing[config].has(name));
if (taken.length > 0) {
  for (const [config, name] of taken) console.error(`${PROJECT}/${config} already has ${name}.`);
  console.error(
    'Nothing changed. Keys are made once; replacing one means reinstalling every site.',
  );
  process.exit(1);
}

const done = [];
for (const [config, name, value] of plan) {
  const r = doppler(['secrets', 'set', name, '--config', config, '--silent'], value);
  if (r.status !== 0) {
    console.error(`Couldn’t set ${PROJECT}/${config} ${name}: ${r.stderr.trim().split('\n')[0]}`);
    if (done.length > 0) {
      console.error(
        `Already set: ${done.join(', ')}. Delete those in Doppler, then run this again.`,
      );
    }
    process.exit(1);
  }
  done.push(`${config} ${name}`);
  console.log(`Set ${PROJECT}/${config} ${name}`);
}
