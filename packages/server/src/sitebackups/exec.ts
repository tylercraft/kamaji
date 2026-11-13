// Running a command for the restore check: its exit code and some of its stdout, never stderr
// (it can say anything, and Kamaji keeps only its own words). stdin can come from a file.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import type { Exec } from './restore.js';

const CAP = 1024 * 1024;

export function realExec(signal?: AbortSignal): Exec {
  return (command, args, options = {}) =>
    new Promise((resolve) => {
      const stdin = options.stdinFile ? openSync(options.stdinFile, 'r') : 'ignore';
      const child = spawn(command, args, {
        stdio: [stdin, 'pipe', 'ignore'],
        timeout: options.timeoutMs ?? 60_000,
        ...(signal ? { signal } : {}),
      });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < CAP) stdout += d.toString('utf8');
      });
      const done = (code: number | null) => {
        if (typeof stdin === 'number') closeSync(stdin);
        resolve({ code, stdout });
      };
      child.on('error', () => done(null));
      child.on('close', (code) => done(code));
    });
}
