// "Download latest export" (ops/backups-plan.md, "The download"): the app asks craftish for one
// export with its download key (server-pull/kamaji-fetch-export) and streams it to the browser.
// Nothing is stored on the mini. A gzip starts 1f 8b; anything else is the forced command's one
// JSON line saying why not.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import type { BackupConfig } from '../updater/backup.js';

export interface ExportStream {
  stdout: Readable;
  exit: Promise<number | null>;
  stop: () => void;
}
export type FetchExport = (siteId: string, at: string) => ExportStream | null;

export function craftishFetch(
  config: BackupConfig | undefined,
  env: NodeJS.ProcessEnv,
): FetchExport {
  return (siteId: string, at: string) => {
    if (!config) return null;
    const child = spawn(
      '/usr/bin/ssh',
      [
        '-i',
        env.KAMAJI_FETCH_SSH_KEY ?? `${homedir()}/.ssh/kamaji-fetch`,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        `UserKnownHostsFile=${config.knownHostsPath}`,
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        '-T',
        `kamaji-pull@${config.host}`,
        `${siteId} ${at}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const exit = new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    });
    return { stdout: child.stdout, exit, stop: () => child.kill() };
  };
}

const REFUSAL = /\{"format":1,"ok":false,"problem":"([^"\\]{1,200})"\}/;

export type Opened =
  { ok: true; body: ReadableStream<Uint8Array> } | { ok: false; problem: string };

/**
 * Waits for craftish's first bytes: a gzip streams on, hashed as it goes and compared with the
 * evidence at the end (`onEnd`); anything else becomes the reason it isn't coming.
 */
export async function openDownload(
  stream: ExportStream,
  onEnd: (result: { sha256: string; exit: number | null }) => void,
): Promise<Opened> {
  const chunks = stream.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const first = await chunks.next();
  if (first.done) {
    const code = await stream.exit;
    return { ok: false, problem: `craftish sent nothing (exit ${code ?? 'unknown'})` };
  }
  const head: Buffer = first.value;
  if (!(head[0] === 0x1f && head[1] === 0x8b)) {
    let text = head.toString('utf8');
    for (
      let next = await chunks.next();
      !next.done && text.length < 4096;
      next = await chunks.next()
    )
      text += (next.value as Buffer).toString('utf8');
    stream.stop();
    const refusal = REFUSAL.exec(text);
    return { ok: false, problem: refusal ? refusal[1]! : 'craftish answered with something else' };
  }
  const hash = createHash('sha256').update(head);
  let sentFirst = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(new Uint8Array(head));
        return;
      }
      const next = await chunks.next();
      if (!next.done) {
        const chunk = next.value as Buffer;
        hash.update(chunk);
        controller.enqueue(new Uint8Array(chunk));
        return;
      }
      const exit = await stream.exit;
      onEnd({ sha256: hash.digest('hex'), exit });
      if (exit === 0) controller.close();
      else controller.error(new Error('the export stopped early'));
    },
    cancel() {
      stream.stop();
    },
  });
  return { ok: true, body };
}
