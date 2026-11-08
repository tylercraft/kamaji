// Writes the version and commit beside the built server, so /api/status says what's running.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (dirty) commit += '+';
} catch {
  // No git or no commits yet: the status shows the version alone.
}
writeFileSync(
  new URL('../packages/server/dist/build-info.json', import.meta.url),
  `${JSON.stringify({ version, commit })}\n`,
);
