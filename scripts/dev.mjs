// Local development: the server rebuilt and restarted on change, and Vite with hot reload.
// Open http://localhost:5173. Vite's proxy adds the login header tailscale serve adds in production.
import { spawn, spawnSync } from 'node:child_process';

if (spawnSync('node', ['scripts/guard.mjs', 'npm run dev'], { stdio: 'inherit' }).status !== 0) {
  process.exit(1);
}

const login = process.env.KAMAJI_LOGIN ?? 'dev@localhost';
const env = {
  ...process.env,
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
