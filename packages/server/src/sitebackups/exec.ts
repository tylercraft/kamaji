// Running a command for the restore check: its exit code, some of its stdout, and the end of its
// stderr. stderr can say anything, so it's only kept when a step fails, as a scrubbed tail
// (stderrTail.ts). stdin can come from a file, and the environment can add to the process's.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import type { Exec } from './restore.js';

const CAP = 1024 * 1024;
/** Enough of stderr's end for its last 20 lines. */
const ERR_CAP = 64 * 1024;

export function realExec(signal?: AbortSignal): Exec {
  return (command, args, options = {}) =>
    new Promise((resolve) => {
      const stdin = options.stdinFile ? openSync(options.stdinFile, 'r') : 'ignore';
      const child = spawn(command, args, {
        stdio: [stdin, 'pipe', 'pipe'],
        timeout: options.timeoutMs ?? 60_000,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        ...(signal ? { signal } : {}),
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < CAP) stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-ERR_CAP);
      });
      const done = (code: number | null) => {
        if (typeof stdin === 'number') closeSync(stdin);
        resolve({ code, stdout, stderr });
      };
      child.on('error', () => done(null));
      child.on('close', (code) => done(code));
    });
}
