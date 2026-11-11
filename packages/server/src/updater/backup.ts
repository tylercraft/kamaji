// "Kamaji did it" backup evidence on craftish: one SSH call to kamaji-db-export as the
// kamaji-backup user (server-export/README.md), naming the site. The export stays on craftish;
// this reads back one JSON line (when, how big, its SHA-256) and never the data.
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { BackupResult, RunSite } from './run.js';

const Answer = z.discriminatedUnion('ok', [
  z.object({
    format: z.literal(1),
    ok: z.literal(true),
    site: z.string(),
    at: z.string(),
    bytes: z.number().int(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ format: z.literal(1), ok: z.literal(false), problem: z.string().max(200) }),
]);

function readAnswer(line: string): z.infer<typeof Answer> | null {
  try {
    const result = Answer.safeParse(JSON.parse(line));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export interface BackupConfig {
  keyPath: string;
  knownHostsPath: string;
  /** craftish's address, from the servers table: user@host for the report; only the host here. */
  host: string;
}

export function craftishBackup(config: BackupConfig | undefined) {
  return async (site: RunSite): Promise<BackupResult> => {
    if (site.hostKind !== 'craftish') {
      return {
        ok: false,
        words:
          'Kamaji makes exports only on craftish; set this site’s backups to the host, the client or Tyler',
      };
    }
    if (!config) return { ok: false, words: 'This updater has no backup key set up' };
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(
        '/usr/bin/ssh',
        [
          '-i',
          config.keyPath,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          `UserKnownHostsFile=${config.knownHostsPath}`,
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=15',
          '-T',
          `kamaji-backup@${config.host}`,
          site.id,
        ],
        { timeout: 10 * 60_000, maxBuffer: 64 * 1024 },
        (error, stdout) =>
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout: String(stdout),
          }),
      );
    });
    const line = out.stdout.trim().split('\n').pop() ?? '';
    const parsed = readAnswer(line);
    if (!parsed)
      return {
        ok: false,
        words: `The export on craftish didn’t answer as expected (exit ${out.code ?? 'unknown'})`,
      };
    if (!parsed.ok) return { ok: false, words: `The export on craftish failed: ${parsed.problem}` };
    if (parsed.site !== site.id)
      return { ok: false, words: 'The export on craftish answered for another site' };
    return {
      ok: true,
      words: `Kamaji exported the database on craftish at ${parsed.at} (${parsed.bytes} bytes, SHA-256 ${parsed.sha256.slice(0, 12)}…)`,
    };
  };
}
