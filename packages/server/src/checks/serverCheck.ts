// Check now, for one server: the same read the cycle makes, on demand. craftish's is its
// kamaji-report over the restricted SSH key; molcajete's is its own readers (molcajete/check.ts).
// Either one only reads, so the route takes no passkey. The issues they raise or clear are judged
// exactly as in the cycle.
import type { Db } from '../db.js';
import { checkMolcajete, type MolcajeteOptions } from '../molcajete/check.js';
import { checkServers, type ReportReading, type SshTarget } from './serverReport.js';

export interface ServerCheckOptions {
  keyPath: string;
  knownHostsPath: string;
  crashFiles: MolcajeteOptions['crashFiles'];
  /** Stand-ins for SSH and molcajete's tools, in tests. */
  read?: (target: SshTarget, signal: AbortSignal) => Promise<ReportReading>;
  exec?: MolcajeteOptions['exec'];
  fs?: MolcajeteOptions['fs'];
  system?: MolcajeteOptions['system'];
  wait?: MolcajeteOptions['wait'];
  repoPullLog?: string;
}

/** Reads one server now. 'not-found' when there's no such server, or it's been removed. */
export async function checkServer(
  db: Db,
  id: string,
  options: ServerCheckOptions & { now: () => number; signal: AbortSignal },
): Promise<'checked' | 'not-found'> {
  const row = db.prepare('SELECT kind FROM servers WHERE id = ? AND removed_at IS NULL').get(id);
  if (!row) return 'not-found';
  const { now, signal } = options;
  if (row.kind === 'linux-ssh') {
    await checkServers(db, {
      now,
      signal,
      keyPath: options.keyPath,
      knownHostsPath: options.knownHostsPath,
      only: [id],
      ...(options.read ? { read: options.read } : {}),
    });
    return 'checked';
  }
  await checkMolcajete(db, {
    now,
    signal,
    crashFiles: options.crashFiles,
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.system ? { system: options.system } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.repoPullLog ? { repoPullLog: options.repoPullLog } : {}),
  });
  return 'checked';
}
