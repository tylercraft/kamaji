// The push's SSH command on each host (site-push/README.md). craftish: Kamaji's push key, forced
// to kamaji-site-push, which takes the words as the SSH command. Kinsta: no forced command, so the
// script goes as it is in the repo, with `kinsta` and the words as its arguments, over Kinsta's
// own key, as the pulls do.
import { readFileSync } from 'node:fs';
import type { Db } from '../db.js';
import type { PullHost } from '../sitebackups/eligible.js';
import { kinstaSsh, quote, type KinstaSsh } from '../sitebackups/kinsta.js';

/** site-push/push as it is in the repo, read when it's sent. */
export const readScript = () =>
  readFileSync(new URL('../../../../site-push/push', import.meta.url), 'utf8');

export interface PushSsh {
  craftish: { key: string; host: string; knownHosts: string };
  kinsta: KinstaSsh;
  script: string;
}

/** Each word is one the script's own checks take: a mode, a site, an id, files or database. */
const WORD = /^[a-z0-9][a-z0-9.-]*$/;

export function pushCommand(
  db: Db,
  siteId: string,
  host: PullHost,
  words: string[],
  ssh: PushSsh,
): string[] | null {
  if (!words.every((w) => WORD.test(w))) return null;
  if (host === 'kinsta')
    return kinstaSsh(
      db,
      ssh.kinsta,
      siteId,
      `bash -c ${quote(ssh.script)} kamaji-push kinsta ${words.map(quote).join(' ')}`,
    );
  return [
    '/usr/bin/ssh',
    '-i',
    ssh.craftish.key,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${ssh.craftish.knownHosts}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    '-T',
    `kamaji-push@${ssh.craftish.host}`,
    words.join(' '),
  ];
}
