import { fileURLToPath } from 'node:url';
import { parseWebhookUrl } from './discord.js';
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
  discordUrl: URL | undefined;
  discordUrlInvalid: boolean;
  /** Kamaji's address on the tailnet, for links in messages. Not a secret. */
  kamajiUrl: string;
  /** When the morning digest goes, Pacific/Auckland time. */
  digestAt: string;
  /** The Worker's address and Kamaji's token for it; outside checks are off unless both are set. */
  worker: { url: string; token: string } | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPing = env.HEALTHCHECKS_PING_URL;
  const pingUrl = parsePingUrl(rawPing);
  const rawDiscord = env.DISCORD_WEBHOOK_URL;
  const discordUrl = parseWebhookUrl(rawDiscord);
  return {
    host: env.KAMAJI_HOST ?? '127.0.0.1',
    port: Number(env.KAMAJI_PORT ?? 10002),
    dbPath: env.KAMAJI_DB ?? `${repoRoot}data/kamaji.db`,
    webDist: env.KAMAJI_WEB_DIST ?? `${repoRoot}packages/web/dist`,
    login: (env.KAMAJI_LOGIN ?? '').trim().toLowerCase(),
    cycleSeconds: Number(env.KAMAJI_CYCLE_SECONDS ?? 300),
    pingUrl,
    pingUrlInvalid: Boolean(rawPing) && !pingUrl,
    discordUrl,
    discordUrlInvalid: Boolean(rawDiscord) && !discordUrl,
    kamajiUrl: env.KAMAJI_URL ?? 'https://molcajete.tailb3044a.ts.net:10002',
    worker:
      env.KAMAJI_WORKER_URL?.startsWith('https://') && env.KAMAJI_WORKER_TOKEN
        ? { url: env.KAMAJI_WORKER_URL, token: env.KAMAJI_WORKER_TOKEN }
        : undefined,
    digestAt: /^\d\d:\d\d$/.test(env.KAMAJI_DIGEST_AT ?? '')
      ? String(env.KAMAJI_DIGEST_AT)
      : '07:30',
  };
}
