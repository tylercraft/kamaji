// Refuses to build or run the dev server where Kamaji is installed (molcajete), unless deploy.sh
// asked. The running process serves packages/web/dist from disk and restarts into
// packages/server/dist, so a casual build there would change what runs without a deploy.
// Sessions on the mini check their work with `npm run check`, which writes nothing.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const installed = existsSync(join(homedir(), 'Library/LaunchAgents/dev.craftish.kamaji.plist'));
if (installed && process.env.KAMAJI_DEPLOY !== '1') {
  const what = process.argv[2] ?? 'this';
  console.error(
    `Kamaji is installed here, so ${what} would change what's running. ` +
      'Use `npm run check` to check a change; ops/deploy.sh deploys it.',
  );
  process.exit(1);
}
