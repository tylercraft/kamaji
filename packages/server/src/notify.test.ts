import { describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { createDiscord, parseWebhookUrl, readDiscord, type Discord } from './discord.js';
import { clearIssue, raiseIssue } from './issues.js';
import { localParts, notifyNow, REMINDER_MS, sendDigest, type NotifyOptions } from './notify.js';
import { testDb } from './testing.js';

const T0 = Date.UTC(2026, 10, 9, 0, 0); // 13:00 in Christchurch
const MIN = 60_000;

function outbox(ok = true) {
  const sent: string[] = [];
  const discord: Discord = {
    configured: true,
    send: async (content) => {
      sent.push(content);
      return ok;
    },
  };
  return { sent, discord };
}

const options: NotifyOptions = {
  kamajiUrl: 'https://kamaji.test',
  workerAlerts: false,
  digestAt: '07:30',
};

function addSite(db: Db, id: string, tailnetOnly = false) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, tailnet_only, created_at)
     VALUES (?, ?, ?, 'craftish', 'monitoring', 'done', ?, ?)`,
  ).run(id, id, `https://${id}/`, tailnetOnly ? 1 : 0, T0);
}

const down = (id: string) =>
  ({ resourceType: 'site', resourceId: id, kind: 'down', severity: 'urgent' }) as const;

describe('notifyNow', () => {
  it('sends one alert, one recovery, and nothing in between', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    const { sent, discord } = outbox();

    raiseIssue(db, T0, { ...down('a.test'), summary: 'a.test is down: HTTP 503' });
    await notifyNow(db, T0, discord, options);
    raiseIssue(db, T0 + 5 * MIN, { ...down('a.test'), summary: 'a.test is down: HTTP 502' });
    await notifyNow(db, T0 + 5 * MIN, discord, options);
    clearIssue(db, T0 + 25 * MIN, down('a.test'), 'a.test is back up');
    await notifyNow(db, T0 + 25 * MIN, discord, options);
    await notifyNow(db, T0 + 30 * MIN, discord, options);

    expect(sent).toEqual([
      '**Kamaji**\n- a.test is down: HTTP 503\n<https://kamaji.test>',
      '**Kamaji**\n- Resolved: a.test is down: HTTP 502 (after 25 min)\n<https://kamaji.test>',
    ]);
  });

  it('groups what’s due into one message', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    addSite(db, 'b.test');
    const { sent, discord } = outbox();
    raiseIssue(db, T0, { ...down('a.test'), summary: 'a down' });
    raiseIssue(db, T0, { ...down('b.test'), summary: 'b down' });
    expect(await notifyNow(db, T0, discord, options)).toBe(2);
    expect(sent).toEqual(['**Kamaji**\n- a down\n- b down\n<https://kamaji.test>']);
  });

  it('retries next cycle when Discord doesn’t take it', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    const failing = outbox(false);
    raiseIssue(db, T0, { ...down('a.test'), summary: 'a down' });
    await notifyNow(db, T0, failing.discord, options);
    const working = outbox();
    await notifyNow(db, T0 + 5 * MIN, working.discord, options);
    expect(failing.sent).toHaveLength(1);
    expect(working.sent).toHaveLength(1);
  });

  it('reminds once a day while it stays open', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    const { sent, discord } = outbox();
    raiseIssue(db, T0, { ...down('a.test'), summary: 'a down' });
    await notifyNow(db, T0, discord, options);
    await notifyNow(db, T0 + REMINDER_MS - MIN, discord, options);
    await notifyNow(db, T0 + REMINDER_MS, discord, options);
    await notifyNow(db, T0 + REMINDER_MS + 5 * MIN, discord, options);
    expect(sent[1]).toBe('**Kamaji**\n- Still open after 24 h: a down\n<https://kamaji.test>');
    expect(sent).toHaveLength(2);
  });

  it('leaves public sites going down to the Worker, but not tailnet-only ones', async () => {
    const db = testDb();
    addSite(db, 'public.test');
    addSite(db, 'private.test', true);
    const { sent, discord } = outbox();
    raiseIssue(db, T0, { ...down('public.test'), summary: 'public down' });
    raiseIssue(db, T0, { ...down('private.test'), summary: 'private down' });
    await notifyNow(db, T0, discord, { ...options, workerAlerts: true });
    expect(sent).toEqual(['**Kamaji**\n- private down\n<https://kamaji.test>']);
  });

  it('keeps normal issues for the digest, and announces one that turns urgent', async () => {
    const db = testDb();
    addSite(db, 'a.test');
    const { sent, discord } = outbox();
    const cert = { resourceType: 'site', resourceId: 'a.test', kind: 'certificate' } as const;
    raiseIssue(db, T0, { ...cert, severity: 'normal', summary: '14 days' });
    await notifyNow(db, T0, discord, options);
    expect(sent).toEqual([]);
    raiseIssue(db, T0 + 7 * 1440 * MIN, { ...cert, severity: 'urgent', summary: '7 days' });
    await notifyNow(db, T0 + 7 * 1440 * MIN, discord, options);
    expect(sent).toEqual(['**Kamaji**\n- 7 days\n<https://kamaji.test>']);
  });
});

describe('sendDigest', () => {
  const morning = Date.UTC(2026, 10, 9, 18, 31); // 07:31 on the 10th in Christchurch

  it('sends once a day from 07:30, only with something in it', async () => {
    const db = testDb();
    const { sent, discord } = outbox();
    expect(await sendDigest(db, morning, discord, options)).toBe(false);

    const cert = { resourceType: 'site', resourceId: 'a.test', kind: 'certificate' } as const;
    raiseIssue(db, morning, { ...cert, severity: 'normal', summary: 'a’s certificate: 12 days' });
    expect(await sendDigest(db, morning + 5 * MIN, discord, options)).toBe(false);

    const nextDay = morning + 1440 * MIN;
    expect(await sendDigest(db, nextDay - 2 * MIN, discord, options)).toBe(false);
    expect(await sendDigest(db, nextDay, discord, options)).toBe(true);
    expect(await sendDigest(db, nextDay + 5 * MIN, discord, options)).toBe(false);
    expect(sent).toEqual([
      '**Kamaji, this morning:** 1 to look at when you have a moment\n- a’s certificate: 12 days\n<https://kamaji.test>',
    ]);
  });

  it('lists a nudge like stale updates once, then again only 30 days on if still open', async () => {
    const db = testDb();
    const { sent, discord } = outbox();
    const day = 1440 * MIN;
    const stale = {
      resourceType: 'server',
      resourceId: 'craftish',
      kind: 'stale-updates',
    } as const;
    const cert = { resourceType: 'site', resourceId: 'a.test', kind: 'certificate' } as const;
    raiseIssue(db, morning, { ...stale, severity: 'normal', summary: 'craftish: 24 waiting' });
    raiseIssue(db, morning, { ...cert, severity: 'normal', summary: 'a’s certificate: 12 days' });
    for (let d = 0; d <= 31; d++) await sendDigest(db, morning + d * day, discord, options);
    const listed = (line: string) => sent.filter((m) => m.includes(line)).length;
    expect(listed('a’s certificate')).toBe(32);
    expect(listed('craftish: 24 waiting')).toBe(2);
    expect(sent[30]).toContain('craftish: 24 waiting');

    // Resolved and back again: a new issue, listed the next morning.
    clearIssue(db, morning + 32 * day, stale, 'craftish is up to date');
    raiseIssue(db, morning + 32 * day, {
      ...stale,
      severity: 'normal',
      summary: 'craftish: 21 waiting',
    });
    await sendDigest(db, morning + 33 * day, discord, options);
    expect(sent.at(-1)).toContain('craftish: 21 waiting');
  });

  it('works in Christchurch time', () => {
    expect(localParts(morning)).toEqual({ day: '2026-11-10', time: '07:31' });
  });
});

describe('discord', () => {
  it('accepts only Discord webhook URLs', () => {
    expect(parseWebhookUrl('https://discord.com/api/webhooks/1/abc')).toBeDefined();
    expect(parseWebhookUrl('https://example.com/api/webhooks/1/abc')).toBeUndefined();
    expect(parseWebhookUrl('http://discord.com/api/webhooks/1/abc')).toBeUndefined();
    expect(parseWebhookUrl(undefined)).toBeUndefined();
  });

  it('posts without mentions and never logs the URL', async () => {
    const db = testDb();
    const logs: string[] = [];
    const bodies: unknown[] = [];
    const url = new URL('https://discord.com/api/webhooks/1/secret-token');
    const discord = createDiscord(db, url, {
      now: () => T0,
      log: (m) => logs.push(m),
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        throw new TypeError(`fetch failed for ${url.href}`);
      }) as typeof fetch,
    });
    expect(await discord.send('hello')).toBe(false);
    expect(bodies).toEqual([{ content: 'hello', allowed_mentions: { parse: [] } }]);
    expect(logs.join(' ')).not.toContain('secret-token');
    expect(readDiscord(db)).toEqual({ lastAttemptAt: T0, lastOk: false, lastSuccessAt: null });
  });
});
