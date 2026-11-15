// Check now, for one server: the cycle's read, on demand, with no passkey, and the issues it
// clears gone when it answers.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { findOpenIssue, raiseIssue } from '../issues.js';
import type { Run } from '../molcajete/read.js';
import { latestObservations } from '../observations.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { testDb } from '../testing.js';
import type { ServerCheckOptions } from './serverCheck.js';
import { parseReport, type ReportReading, type SshTarget } from './serverReport.js';

const T = Date.UTC(2026, 10, 15);
const LOGIN = 'tylercraft@github';

const healthy = (): ReportReading => {
  const reading = parseReport(
    readFileSync(
      new URL('./fixtures/kamaji-report.ubuntu-container.json', import.meta.url),
      'utf8',
    ),
  );
  if (!reading.ok) throw new Error(reading.problem);
  return {
    ok: true,
    report: {
      ...reading.report,
      packages: { security: [], other: [], esm: [] },
      services: { nginx: 'active', mariadb: 'active' },
      disks: [{ mount: '/', sizeBytes: 100, usedBytes: 40, availableBytes: 60 }],
    },
  };
};

/** Every one of molcajete's tools fails: the read still happens, and says so. */
const failingTools: Run = async () => ({ code: 1, stdout: '', stderr: 'nope' });

function setup(serverCheck?: Partial<ServerCheckOptions>) {
  // The seeds: craftish and molcajete.
  const db = testDb({ seed: true });
  const read: SshTarget[] = [];
  const app = createApp({
    db,
    login: LOGIN,
    webDist: mkdtempSync(join(tmpdir(), 'kamaji-web-')),
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: T,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
    // Passkeys set up, so a write that needed one would be asked for it (401).
    passkeys: testAuthenticator().config,
    ...(serverCheck
      ? {
          serverCheck: {
            keyPath: '/nonexistent',
            knownHostsPath: '/nonexistent',
            crashFiles: { path: join(mkdtempSync(join(tmpdir(), 'kamaji-crash-')), 'crash.log') },
            read: async (target: SshTarget) => {
              read.push(target);
              return healthy();
            },
            exec: failingTools,
            fs: { exists: () => false, agentLabels: () => [], tail: () => null },
            repoPullLog: '/nonexistent/repo-pull.log',
            ...serverCheck,
          },
        }
      : {}),
    now: () => T,
  });
  const post = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'Tailscale-User-Login': LOGIN,
        Host: 'kamaji.test',
        Origin: 'https://kamaji.test',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  return { db, post, read };
}

const servicesDown = { resourceType: 'server', resourceId: 'craftish', kind: 'services' } as const;

describe('Check now', () => {
  it('reads craftish’s report with no passkey, and clears what’s fixed', async () => {
    const { db, post, read } = setup({});
    raiseIssue(db, T - 60_000, {
      ...servicesDown,
      severity: 'urgent',
      summary: 'craftish: nginx has stopped',
    });
    const res = await post('/api/servers/craftish/check');
    expect(res.status).toBe(200);
    expect(read.map((t) => t.address)).toEqual(['kamaji-report@100.77.122.31']);
    expect(findOpenIssue(db, servicesDown)).toBeNull();
    expect(latestObservations(db, 'server', 'craftish', 'report', 'ssh', 1)[0]?.at).toBe(T);
  });

  it('reads only the server asked for', async () => {
    const { db, post, read } = setup({});
    db.prepare(
      `INSERT INTO servers (id, name, kind, address, created_at)
       VALUES ('other', 'other', 'linux-ssh', 'kamaji-report@other', 0)`,
    ).run();
    expect((await post('/api/servers/other/check')).status).toBe(200);
    expect(read.map((t) => t.address)).toEqual(['kamaji-report@other']);
  });

  it('reads molcajete with its own readers', async () => {
    const { db, post, read } = setup({});
    expect((await post('/api/servers/molcajete/check')).status).toBe(200);
    expect(read).toEqual([]);
    expect(latestObservations(db, 'server', 'molcajete', 'local', 'mini', 1)[0]?.at).toBe(T);
  });

  it('refuses a server Kamaji doesn’t have, or has removed', async () => {
    const { db, post } = setup({});
    expect((await post('/api/servers/nope/check')).status).toBe(404);
    db.prepare("UPDATE servers SET removed_at = 1 WHERE id = 'craftish'").run();
    expect((await post('/api/servers/craftish/check')).status).toBe(404);
  });

  it('checks one server once at a time', async () => {
    let answer: (r: ReportReading) => void = () => {};
    const { post } = setup({
      read: () =>
        new Promise<ReportReading>((resolve) => {
          answer = resolve;
        }),
    });
    const first = post('/api/servers/craftish/check');
    await new Promise((r) => setTimeout(r, 0));
    const second = await post('/api/servers/craftish/check');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_checking' });
    answer(healthy());
    expect((await first).status).toBe(200);
  });

  it('says it isn’t set up without what reading a server needs', async () => {
    const { post } = setup();
    expect((await post('/api/servers/craftish/check')).status).toBe(409);
  });
});
