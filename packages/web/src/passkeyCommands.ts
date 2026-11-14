// The commands the Passkeys page hands Tyler to run on the mini. Kamaji can't change the passkey
// file itself (it's root's, TY-170), so adding and taking one out are each a line of sudo, built
// here so the quoting is in one place and tested by actually running it.

export const PASSKEY_FILE = '/etc/kamaji/passkeys';

export interface PasskeyEntry {
  id: string;
  alg: number;
  publicKey: string;
  label: string;
}

/** Single-quoted for the shell, so nothing in it is expanded. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One line of the passkey file, in the order Kamaji writes them. */
export const passkeyLine = ({ id, alg, publicKey, label }: PasskeyEntry) =>
  JSON.stringify({ id, alg, publicKey, label });

/** printf, not echo: zsh's and sh's echo turn backslashes in a name into other characters. */
export const addCommand = (line: string, file = PASSKEY_FILE) =>
  `printf '%s\\n' ${shellQuote(line)} | /usr/bin/sudo /usr/bin/tee -a ${file} > /dev/null`;

/** A passkey id is base64url, so it's safe inside both the sed pattern and its single quotes. */
export const removeCommand = (id: string, file = PASSKEY_FILE) =>
  `/usr/bin/sudo /usr/bin/sed -i '' '/"id":"${id}"/d' ${file}`;
