// Kamaji's Discord channel (#kamaji), through its webhook. The webhook URL is a secret (anyone
// with it can post as Kamaji), so it lives only in this closure: never logged, never in an
// error, never in the database. Discord is a third party: messages carry short labels and a
// link back to Kamaji, never plugin lists, error text or anything from a site.
import type { Db } from './db.js';
import { readState, writeState } from './state.js';

export interface Discord {
  configured: boolean;
  /** Posts one message. True if Discord took it. Never throws. */
  send(content: string, signal?: AbortSignal): Promise<boolean>;
}

export interface DiscordState {
  lastAttemptAt: number;
  lastOk: boolean;
  lastSuccessAt: number | null;
}

const KEY = 'discord';
const MAX_LENGTH = 2000;

export function readDiscord(db: Db): DiscordState | null {
  return readState<DiscordState>(db, KEY);
}

/** Returns the URL if it's a Discord webhook URL, otherwise undefined. */
export function parseWebhookUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const hostOk = url.hostname === 'discord.com' || url.hostname === 'discordapp.com';
    return url.protocol === 'https:' && hostOk && url.pathname.startsWith('/api/webhooks/')
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export function createDiscord(
  db: Db,
  url: URL | undefined,
  options: {
    now?: () => number;
    fetch?: typeof fetch;
    log?: (message: string) => void;
    timeoutMs?: number;
  } = {},
): Discord {
  if (!url) return { configured: false, send: async () => false };
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 15_000;
  const href = url.href;

  return {
    configured: true,
    async send(content, signal) {
      const at = now();
      let ok = false;
      let problem = '';
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const text = content.length > MAX_LENGTH ? `${content.slice(0, MAX_LENGTH - 1)}…` : content;
        const response = await doFetch(href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        ok = response.ok;
        if (!ok) problem = `HTTP ${response.status}`;
      } catch (error) {
        // Name only: fetch errors can carry the URL.
        problem = error instanceof Error ? error.name : 'error';
      }
      const before = readDiscord(db);
      writeState(
        db,
        KEY,
        {
          lastAttemptAt: at,
          lastOk: ok,
          lastSuccessAt: ok ? at : (before?.lastSuccessAt ?? null),
        } satisfies DiscordState,
        at,
      );
      log(ok ? 'discord: sent' : `discord: not sent (${problem})`);
      return ok;
    },
  };
}
