import { fileURLToPath } from 'node:url';
import { parsePingUrl } from './heartbeat.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  webDist: string;
  /** The one Tailscale login allowed in, exactly as serve's Tailscale-User-Login header has it. */
  login: string;
  cycleSeconds: number;
  pingUrl: URL | undefined;
  /** Set but unusable (not https): the server says so at startup instead of silently not pinging. */
  pingUrlInvalid: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPing = env.HEALTHCHECKS_PING_URL;
  const pingUrl = parsePingUrl(rawPing);
  return {
    host: env.KAMAJI_HOST ?? '127.0.0.1',
    port: Number(env.KAMAJI_PORT ?? 10002),
    dbPath: env.KAMAJI_DB ?? `${repoRoot}data/kamaji.db`,
    webDist: env.KAMAJI_WEB_DIST ?? `${repoRoot}packages/web/dist`,
    login: (env.KAMAJI_LOGIN ?? '').trim().toLowerCase(),
    cycleSeconds: Number(env.KAMAJI_CYCLE_SECONDS ?? 300),
    pingUrl,
    pingUrlInvalid: Boolean(rawPing) && !pingUrl,
  };
}
