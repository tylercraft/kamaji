// Local development: the server rebuilt and restarted on change, and Vite with hot reload.
// Open http://localhost:5173. Vite's proxy adds the login header tailscale serve adds in production.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

if (spawnSync('node', ['scripts/guard.mjs', 'npm run dev'], { stdio: 'inherit' }).status !== 0) {
  process.exit(1);
}

const login = process.env.KAMAJI_LOGIN ?? 'dev@localhost';

// The local WordPress's craftish-care keys and the CA its certificate comes from (dev/README.md),
// so the dev server can connect to https://kamaji-wp.ddev.site. Never on the mini.
const careKeys = new URL('../dev/care-keys.env', import.meta.url);
const care = {};
if (existsSync(careKeys)) {
  for (const line of readFileSync(careKeys, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) care[m[1]] = m[2];
  }
}
const caRoot = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8' });
if (caRoot.status === 0) care.NODE_EXTRA_CA_CERTS = `${caRoot.stdout.trim()}/rootCA.pem`;

const env = {
  ...process.env,
  ...care,
  KAMAJI_LOGIN: login,
  KAMAJI_CYCLE_SECONDS: process.env.KAMAJI_CYCLE_SECONDS ?? '60',
};

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', env });
const children = [
  run('npx', ['tsc', '-b', '--watch', '--preserveWatchOutput', 'packages/server']),
  run('node', [
    '--watch-path=packages/server/dist',
    '--disable-warning=ExperimentalWarning',
    'packages/server/dist/main.js',
  ]),
  run('npm', ['run', 'dev', '-w', '@kamaji/web']),
];
const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
