import { describe, expect, it } from 'vitest';
import { createHeartbeat, parsePingUrl, readHeartbeat } from './heartbeat.js';
import { testDb } from './testing.js';

const SECRET = 'https://hc-ping.com/0b3a-secret-uuid';

function fakeFetch(respond: (url: string) => Response | Error) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = respond(url);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}

describe('heartbeat', () => {
  it('accepts only https ping URLs', () => {
    expect(parsePingUrl(undefined)).toBeUndefined();
    expect(parsePingUrl('http://hc-ping.com/x')).toBeUndefined();
    expect(parsePingUrl('not a url')).toBeUndefined();
    expect(parsePingUrl(SECRET)?.href).toBe(SECRET);
  });

  it('does nothing when not configured', async () => {
    const db = testDb();
    const beat = createHeartbeat(db, undefined);
    expect(beat.configured).toBe(false);
    await beat.ping(true);
    expect(readHeartbeat(db)).toBeNull();
  });

  it('pings the check on success and /fail on failure', async () => {
    const db = testDb();
    const { fn, calls } = fakeFetch(() => new Response('OK'));
    const beat = createHeartbeat(db, parsePingUrl(SECRET), { fetch: fn, now: () => 1000 });
    await beat.ping(true);
    await beat.ping(false);
    expect(calls).toEqual([SECRET, `${SECRET}/fail`]);
    expect(readHeartbeat(db)).toEqual({ lastAttemptAt: 1000, lastOk: true, lastSuccessAt: 1000 });
  });

  it('records failures and recoveries once, without the URL anywhere', async () => {
    const db = testDb();
    const logs: string[] = [];
    let fail = false;
    const { fn } = fakeFetch((url) =>
      fail ? new TypeError(`fetch failed: ${url}`) : new Response('OK'),
    );
    let now = 0;
    const beat = createHeartbeat(db, parsePingUrl(SECRET), {
      fetch: fn,
      now: () => now,
      log: (m) => logs.push(m),
    });

    await beat.ping(true);
    fail = true;
    now = 1;
    await beat.ping(true);
    now = 2;
    await beat.ping(true);
    fail = false;
    now = 3;
    await beat.ping(true);

    const rows = db.prepare('SELECT kind, summary, detail FROM events ORDER BY id').all();
    expect(rows.map((r) => r.kind)).toEqual(['heartbeat.failed', 'heartbeat.recovered']);
    const everything = JSON.stringify([rows, logs, db.prepare('SELECT * FROM state').all()]);
    expect(everything).not.toContain('secret-uuid');
    expect(readHeartbeat(db)).toEqual({ lastAttemptAt: 3, lastOk: true, lastSuccessAt: 3 });
  });

  it('treats a non-2xx answer as a failed ping', async () => {
    const db = testDb();
    const { fn } = fakeFetch(() => new Response('nope', { status: 404 }));
    const logs: string[] = [];
    const beat = createHeartbeat(db, parsePingUrl(SECRET), { fetch: fn, log: (m) => logs.push(m) });
    await beat.ping(true);
    expect(readHeartbeat(db)?.lastOk).toBe(false);
    expect(logs).toEqual(['heartbeat ping failed: HTTP 404']);
  });
});
