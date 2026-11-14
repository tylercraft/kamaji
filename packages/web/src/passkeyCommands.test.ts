import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addCommand, passkeyLine, removeCommand } from './passkeyCommands';

const phone = { id: 'aB-_9z', alg: -7, publicKey: 'MFkwEwYHKoZIzj0CAQ', label: 'Tyler’s iPhone' };
const laptop = { id: 'Qx_1-c', alg: -8, publicKey: 'MCowBQYDK2VwAyEA', label: 'Laptop' };

/** Runs a command as the page shows it, with sudo dropped, against a file of the test's own. */
function run(command: string, file: string) {
  execFileSync('/bin/sh', ['-c', command.replaceAll('/usr/bin/sudo ', '')]);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as typeof phone);
}

function passkeyFile() {
  const file = join(mkdtempSync(join(tmpdir(), 'kamaji-passkey-commands-')), 'passkeys');
  writeFileSync(file, `${passkeyLine(phone)}\n`);
  return file;
}

describe('passkey commands', () => {
  it('adds a line that keeps a name with quotes, a dollar sign and backslashes exactly', () => {
    const file = passkeyFile();
    const odd = { ...laptop, label: `Tyler's "work" $HOME \\ \`id\`` };
    expect(run(addCommand(passkeyLine(odd), file), file)).toEqual([phone, odd]);
  });

  it('removes one passkey by id and leaves the others', () => {
    const file = passkeyFile();
    run(addCommand(passkeyLine(laptop), file), file);
    expect(run(removeCommand(phone.id, file), file)).toEqual([laptop]);
  });
});
