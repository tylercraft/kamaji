import { describe, expect, it } from 'vitest';
import { failure, run } from './read.js';

describe('run', () => {
  it('gives a tool the plain environment and its one extra, never Kamaji’s own', async () => {
    process.env.KAMAJI_TEST_SECRET = 'not for children';
    try {
      const r = await run('/usr/bin/env', [], {
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        env: { TAILSCALE_BE_CLI: '1' },
      });
      const names = r.stdout
        .trim()
        .split('\n')
        .map((l) => l.split('=')[0])
        .sort();
      expect(names).toEqual(['HOME', 'PATH', 'TAILSCALE_BE_CLI']);
    } finally {
      delete process.env.KAMAJI_TEST_SECRET;
    }
  });
});

describe('failure', () => {
  it('names the exit code and stderr’s first line', () => {
    expect(failure('x failed', { code: 2, stdout: 'ignored', stderr: '  first  \nsecond' })).toBe(
      'x failed (exit 2: first)',
    );
    expect(failure('x failed', { code: 1, stdout: '', stderr: '' })).toBe('x failed (exit 1)');
  });
});
