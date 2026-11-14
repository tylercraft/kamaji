import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCareKeys, type CareKeys } from './care/keys.js';
import { parseWebhookUrl } from './discord.js';
import { parsePingUrl } from './heartbeat.js';
import { relyingParty, type PasskeyConfig } from './passkeys/guard.js';
import { loadPasskeys, PASSKEYS_FILE } from './passkeys/store.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const KAMAJI_URL = 'https://molcajete.tailb3044a.ts.net:10002';

/**
 * The passkeys writes need (TY-170), for the app and the updater alike: the root-owned
 * /etc/kamaji/passkeys at Kamaji's address. KAMAJI_PASSKEYS_DEV names a file of the user's own
 * instead, for `npm run dev`, and is ignored unless Kamaji's address is http://localhost.
 */
export function passkeyConfig(env: NodeJS.ProcessEnv = process.env): PasskeyConfig {
  const url = env.KAMAJI_URL ?? KAMAJI_URL;
  const dev = env.KAMAJI_PASSKEYS_DEV && /^http:\/\/localhost(:\d+)?$/.test(url);
  return {
    load: dev
      ? () => loadPasskeys(String(env.KAMAJI_PASSKEYS_DEV), { trustOwner: true })
      : () => loadPasskeys(PASSKEYS_FILE),
    ...relyingParty(url),
  };
}

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
  /** The SSH key whose only power is running kamaji-report, and the host keys Kamaji trusts. */
  sshKeyPath: string;
  sshKnownHostsPath: string;
  /** Calcifer's crash log (docs/crash-hook.md) and the folder its jobs log to. */
  crashLogPath: string;
  logsDir: string;
  /** craftish-care's keys (docs/protocol.md), or undefined where connecting sites isn't set up. */
  care: CareKeys | undefined;
  /** The plugin's source, zipped for each site at Add site. */
  pluginDir: string;
  /** Wordfence Intelligence's v3 feed key, and where the day's download is kept. */
  wordfenceApiKey: string | undefined;
  wordfenceFeedPath: string;
  /** Laptop testing only: a saved feed to load instead of downloading. */
  wordfenceFeedFile: string | undefined;
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
    kamajiUrl: env.KAMAJI_URL ?? KAMAJI_URL,
    worker:
      env.KAMAJI_WORKER_URL?.startsWith('https://') && env.KAMAJI_WORKER_TOKEN
        ? { url: env.KAMAJI_WORKER_URL, token: env.KAMAJI_WORKER_TOKEN }
        : undefined,
    sshKeyPath: env.KAMAJI_SSH_KEY ?? `${homedir()}/.ssh/kamaji-report`,
    sshKnownHostsPath: env.KAMAJI_SSH_KNOWN_HOSTS ?? `${homedir()}/.ssh/kamaji_known_hosts`,
    crashLogPath: env.KAMAJI_CRASH_LOG ?? `${homedir()}/Library/Logs/calcifer-crashes.jsonl`,
    logsDir: `${homedir()}/Library/Logs`,
    care: loadCareKeys(env),
    pluginDir: `${repoRoot}plugin/craftish-care`,
    wordfenceApiKey: env.WORDFENCE_API_KEY || undefined,
    wordfenceFeedPath: join(
      dirname(env.KAMAJI_DB ?? `${repoRoot}data/kamaji.db`),
      'wordfence-production.json',
    ),
    wordfenceFeedFile: env.KAMAJI_WORDFENCE_FEED_FILE || undefined,
    digestAt: /^\d\d:\d\d$/.test(env.KAMAJI_DIGEST_AT ?? '')
      ? String(env.KAMAJI_DIGEST_AT)
      : '07:30',
  };
}
