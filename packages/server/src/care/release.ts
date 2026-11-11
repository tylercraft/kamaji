// Craftish Care's signed release channel (docs/protocol.md, "Self-update"): info.json beside the
// zip, signed with the release key, which only the laptop holds. The plugin offers a release
// only when the signature checks out, and installs the zip only when its SHA-256 matches.
import { createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyFromSeed } from './keys.js';
import { releaseZip } from './zip.js';

export interface ReleaseInfo {
  version: string;
  package: string;
  sha256: string;
  key: string;
  signature: string;
}

/** The version in the plugin's header, which must agree with its VERSION constant. */
export function pluginVersion(pluginDir: string): string {
  const main = readFileSync(join(pluginDir, 'craftish-care.php'), 'utf8');
  const header = /^ \* Version:\s+(\d+\.\d+\.\d+)$/m.exec(main)?.[1];
  const constant = /^const VERSION\s+= '(\d+\.\d+\.\d+)';$/m.exec(main)?.[1];
  if (!header || header !== constant) {
    throw new Error('craftish-care.php: the Version header and VERSION must match');
  }
  return header;
}

export const releaseMessage = (version: string, sha256: string) =>
  `craftish-care-release-v1\n${version}\n${sha256}`;

export function buildRelease(
  pluginDir: string,
  key: { id: string; seed: string },
  channel: string,
  at: Date,
): { zip: Buffer; zipName: string; info: ReleaseInfo } {
  if (!channel.startsWith('https://') || !channel.endsWith('/')) {
    throw new Error('the channel is an https URL ending in /');
  }
  const version = pluginVersion(pluginDir);
  const zip = releaseZip(pluginDir, at);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const zipName = `craftish-care-${version}.zip`;
  const signature = sign(
    null,
    Buffer.from(releaseMessage(version, sha256)),
    privateKeyFromSeed(key.seed),
  ).toString('base64');
  return {
    zip,
    zipName,
    info: { version, package: `${channel}${zipName}`, sha256, key: key.id, signature },
  };
}
