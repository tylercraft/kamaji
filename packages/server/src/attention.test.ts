// No warning without something to do: every kind of issue has its next step, Dismiss hides one
// Kamaji can't check again until something new happens, and dismissing takes a passkey.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityResponse, OverviewResponse, SitesResponse } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp, PASSKEY_WINDOW_MS } from './app.js';
import type { SiteCheckers } from './checks/sites.js';
import type { Db } from './db.js';
import { checkEndOfLife } from './endOfLife/check.js';
import { actionFor, familyOf, ISSUE_FAMILIES, type IssueKind } from './issueActions.js';
import { dismissIssue, findOpenIssue, raiseIssue, undismissIssue, clearIssue } from './issues.js';
import { recordObservation } from './observations.js';
import { testAuthenticator } from './passkeys/testing.js';
import { overview } from './queries.js';
import { testDb } from './testing.js';

const T = Date.parse('2026-11-11T09:00:00Z');
const DAY = 86_400_000;
const LOGIN = 'tylercraft@github';

/** One kind from each family, as Kamaji raises it. */
const example = (family: string): IssueKind =>
  (['crash', 'job-failed', 'unmounted', 'smart', 'read-only', 'vulnerable', 'abandoned'].includes(
    family,
  )
    ? `${family}:x`
    : family) as IssueKind;

describe('every issue has a next step', () => {
  it('declares one for each kind, a button or a line to look at with Dismiss', () => {
    for (const family of ISSUE_FAMILIES) {
      const action = actionFor({
        resourceType: 'site',
        resourceId: 'a.test',
        kind: example(family),
      });
      if (action.type === 'recheck') {
        expect(action.label, family).not.toBe('');
        // Only the routes the site page's own buttons use, and a server's Check now.
        expect(action.path, family).toMatch(
          /^\/api\/(sites\/a\.test\/(check|report|backups\/whole-site|domain\/check)|servers\/a\.test\/check)$/,
        );
      } else {
        expect(action.text, family).toMatch(/\.$/);
      }
    }
  });

  it('rechecks what Kamaji can check again, the way the site page does', () => {
    const of = (kind: string) => actionFor({ resourceType: 'site', resourceId: 'a.test', kind });
    expect(of('down')).toMatchObject({ label: 'Check again', path: '/api/sites/a.test/check' });
    expect(of('certificate')).toMatchObject({ label: 'Check again' });
    expect(of('inventory-stale')).toMatchObject({ label: 'Refresh inventory' });
    expect(of('vulnerable:plugin:x')).toMatchObject({ label: 'Refresh inventory' });
    expect(of('restore-check-failed')).toMatchObject({
      label: 'Check restore now',
      body: { kind: 'restore' },
    });
    expect(of('backup-failed')).toMatchObject({ label: 'Back up now', body: { kind: 'backup' } });
    // A domain renewed, or readable again: its renewal date read now.
    for (const kind of ['domain-expiring', 'domain-unreadable'])
      expect(of(kind), kind).toMatchObject({
        type: 'recheck',
        label: 'Check again',
        path: '/api/sites/a.test/domain/check',
      });
  });

  it('gives server issues a fresh read clears Check now, and keeps Dismiss for the rest', () => {
    const of = (resourceId: string, kind: string) =>
      actionFor({ resourceType: 'server', resourceId, kind });
    const checkNow = (id: string) => ({
      type: 'recheck',
      label: 'Check now',
      path: `/api/servers/${id}/check`,
      body: {},
    });
    for (const kind of ['services', 'security-updates', 'reboot', 'stale-updates', 'disk'])
      expect(of('craftish', kind), kind).toMatchObject(checkNow('craftish'));
    expect(of('craftish', 'unreadable')).toMatchObject(checkNow('craftish'));
    for (const kind of [
      'job-missing:outbox',
      'job-stopped:outbox',
      'job-failed:outbox',
      'unmounted:Backup',
      'disk:Backup',
      'smart:Backup',
      'read-only:Backup',
      'docker',
      'containers',
      'tailscale',
      'tailscale-health',
      'unreadable:Docker',
      'molcajete-load',
    ])
      expect(of('molcajete', kind), kind).toMatchObject(checkNow('molcajete'));
    // What a read doesn't clear: time does, or the six-hourly updates read, or a new release.
    for (const kind of [
      'restarted',
      'repo-pull',
      'macos-updates',
      'unreadable:software updates',
      'crash:abc',
    ])
      expect(of('molcajete', kind).type, kind).toBe('look');
    expect(of('craftish', 'os-eol').type).toBe('look');
  });

  it('says what to look at for the rest, linking a crash to its stack', () => {
    expect(
      actionFor({ resourceType: 'site', resourceId: 'minton.test', kind: 'end-of-life:php' }),
    ).toEqual({ type: 'look', text: 'Ask the host or client to upgrade.', href: null });
    expect(
      actionFor({ resourceType: 'server', resourceId: 'molcajete', kind: 'crash:abc123' }),
    ).toEqual({ type: 'look', text: 'See the stack on Servers.', href: '/servers#crash-abc123' });
  });

  it('knows the family of every kind, and still offers Dismiss for one it no longer raises', () => {
    expect(familyOf('disk:Backup')).toBe('disk');
    expect(familyOf('unreadable:software updates')).toBe('unreadable');
    expect(familyOf('retired-kind')).toBeNull();
    expect(actionFor({ resourceType: 'site', resourceId: 'a', kind: 'retired-kind' }).type).toBe(
      'look',
    );
  });

  it('won’t compile a new kind without an action', () => {
    const db = testDb();
    raiseIssue(db, T, {
      resourceType: 'site',
      resourceId: 'a.test',
      // @ts-expect-error: a kind with no action isn't a kind raiseIssue takes.
      kind: 'brand-new-kind',
      severity: 'normal',
      summary: 'x',
    });
  });
});

const crash = (db: Db, lastCrash: number, at = T) =>
  raiseIssue(db, at, {
    resourceType: 'server',
    resourceId: 'molcajete',
    kind: 'crash:g1',
    severity: 'urgent',
    summary: 'money-rc crashed',
    fingerprint: String(lastCrash),
  });
const crashKey = { resourceType: 'server', resourceId: 'molcajete', kind: 'crash:g1' } as const;

describe('dismissing', () => {
  it('hides an issue from Overview until something new happens, and Undo shows it again', () => {
    const db = testDb();
    const { issue } = crash(db, T - 60_000);
    expect(dismissIssue(db, T, issue.id, LOGIN)).toBe('dismissed');
    let o = overview(db);
    expect(o.attention.known && o.attention.value).toEqual([]);
    expect(o.dismissed.map((i) => [i.kind, i.dismissed])).toEqual([
      ['crash:g1', { at: new Date(T).toISOString(), by: LOGIN }],
    ]);
    // The same crash seen again: still hidden.
    crash(db, T - 60_000, T + 300_000);
    expect(findOpenIssue(db, crashKey)?.dismissedAt).toBe(T);
    expect(undismissIssue(db, T + 1, issue.id, LOGIN)).toBe(true);
    o = overview(db);
    expect(o.attention.known && o.attention.value.map((i) => i.kind)).toEqual(['crash:g1']);
    expect(o.dismissed).toEqual([]);
  });

  it('brings a crash group back with a new crash, to be announced again', () => {
    const db = testDb();
    const { issue } = crash(db, T - 60_000);
    db.prepare('UPDATE issues SET notified_at = ? WHERE id = ?').run(T, issue.id);
    dismissIssue(db, T, issue.id, LOGIN);
    crash(db, T + 600_000, T + 600_000);
    const back = findOpenIssue(db, crashKey)!;
    expect(back.dismissedAt).toBeNull();
    expect(back.notifiedAt).toBeNull();
    expect(back.severity).toBe('urgent');
  });

  it('brings a host finding back when its version changes or its date passes', () => {
    const db = testDb();
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('minton.test', 'Minton test', 'https://minton.test/', 'other', 'connected', 'done', 0)`,
    ).run();
    const report = (php: string, at: number) =>
      recordObservation(db, {
        resourceType: 'site',
        resourceId: 'minton.test',
        check: 'report',
        source: 'plugin',
        at,
        ok: true,
        value: { ok: true, php, database: '10.11.14-MariaDB' },
      });
    const php = {
      resourceType: 'site',
      resourceId: 'minton.test',
      kind: 'end-of-life:php',
    } as const;
    // PHP 8.2's security support ends on 2026-12-31: ending now, ended in January.
    report('8.2.35', T);
    checkEndOfLife(db, T);
    dismissIssue(db, T, findOpenIssue(db, php)!.id, LOGIN);
    checkEndOfLife(db, T + DAY);
    expect(findOpenIssue(db, php)?.dismissedAt).toBe(T);
    checkEndOfLife(db, Date.parse('2027-01-02T09:00:00Z'));
    expect(findOpenIssue(db, php)?.dismissedAt).toBeNull();

    // Dismissed again, then the site moves to 8.1: another version, so it's back.
    dismissIssue(db, T, findOpenIssue(db, php)!.id, LOGIN);
    report('8.1.30', T + 2 * DAY);
    checkEndOfLife(db, Date.parse('2027-01-02T09:00:00Z'));
    expect(findOpenIssue(db, php)?.dismissedAt).toBeNull();
  });

  it('brings back as urgent what turns urgent, or resolves and recurs', () => {
    const db = testDb();
    const disk = (severity: 'urgent' | 'normal', at = T) =>
      raiseIssue(db, at, {
        resourceType: 'server',
        resourceId: 'molcajete',
        kind: 'repo-pull',
        severity,
        summary: 'Calcifer’s repo on molcajete hasn’t pulled since 09:00',
      });
    const key = { resourceType: 'server', resourceId: 'molcajete', kind: 'repo-pull' } as const;
    dismissIssue(db, T, disk('normal').issue.id, LOGIN);
    disk('normal', T + 1);
    expect(findOpenIssue(db, key)?.dismissedAt).toBe(T);
    disk('urgent', T + 2);
    expect(findOpenIssue(db, key)).toMatchObject({ dismissedAt: null, severity: 'urgent' });

    // Urgent, dismissed, resolved, and back: a new issue, urgent and announced.
    dismissIssue(db, T + 3, findOpenIssue(db, key)!.id, LOGIN);
    clearIssue(db, T + 4, key, 'Calcifer’s repo on molcajete is pulling again');
    disk('urgent', T + 5);
    expect(findOpenIssue(db, key)).toMatchObject({
      dismissedAt: null,
      notifiedAt: null,
      severity: 'urgent',
    });
  });

  it('won’t dismiss what Kamaji can check again: it clears by passing', () => {
    const db = testDb();
    const { issue } = raiseIssue(db, T, {
      resourceType: 'site',
      resourceId: 'a.test',
      kind: 'down',
      severity: 'urgent',
      summary: 'A is down',
    });
    expect(dismissIssue(db, T, issue.id, LOGIN)).toBe('not-dismissable');
    expect(dismissIssue(db, T, 'nope', LOGIN)).toBe('not-found');
  });
});

function setup(home: { ok: boolean; problem: string | null } = { ok: true, problem: null }) {
  const db = testDb();
  const passkey = testAuthenticator();
  const checkers: SiteCheckers = {
    homePage: async () => ({
      ...home,
      status: home.ok ? 200 : null,
      responseMs: 100,
      finalUrl: null,
      expectedText: null,
      phpError: false,
      errorCode: null,
    }),
    certificate: async () => ({ validTo: T + 60 * DAY, daysLeft: 60, problem: null }),
  };
  const clock = { now: T };
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
    passkeys: passkey.config,
    siteCheckers: checkers,
    now: () => clock.now,
  });
  const headers = {
    'Tailscale-User-Login': LOGIN,
    Host: 'kamaji.test',
    Origin: 'https://kamaji.test',
    'Content-Type': 'application/json',
  };
  const post = (path: string) => app.request(path, { method: 'POST', headers, body: '{}' });
  const signed = (path: string, body: unknown = {}) =>
    passkey.post(app, path, JSON.stringify(body), headers);
  const get = (path: string) => app.request(path, { headers });
  const withCookie = (path: string, cookie: string, body: unknown = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify(body),
    });
  return { db, post, signed, get, withCookie, clock };
}

/** The cookie a response sets, as a request sends it back. */
const cookieFrom = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

describe('the routes', () => {
  it('dismisses only with a passkey, shows it in Activity, and undoes without one', async () => {
    const { db, post, signed, get } = setup();
    const { issue } = crash(db, T - 60_000);
    expect((await post(`/api/issues/${issue.id}/dismiss`)).status).toBe(401);
    expect(findOpenIssue(db, crashKey)?.dismissedAt).toBeNull();
    expect((await signed(`/api/issues/${issue.id}/dismiss`)).status).toBe(200);
    const o = OverviewResponse.parse(await (await get('/api/overview')).json());
    expect(o.dismissed.map((i) => i.id)).toEqual([issue.id]);
    const events = ActivityResponse.parse(await (await get('/api/activity?limit=5')).json());
    expect(events.events[0]).toMatchObject({
      kind: 'issue.dismissed',
      summary: `Dismissed by ${LOGIN}: money-rc crashed`,
    });
    expect((await post(`/api/issues/${issue.id}/undismiss`)).status).toBe(200);
    expect(findOpenIssue(db, crashKey)?.dismissedAt).toBeNull();
  });

  it('lets a signed write open ten minutes of passkey writes, approvals aside', async () => {
    const { db, signed, withCookie, clock } = setup();
    const a = crash(db, T - 60_000).issue;
    // Three issues with a line and Dismiss: an OS leaving support, on three servers.
    const disks = ['one', 'two', 'three'].map(
      (server) =>
        raiseIssue(db, T, {
          resourceType: 'server',
          resourceId: server,
          kind: 'os-eol',
          severity: 'normal',
          summary: `${server}: Ubuntu 22.04 LTS leaves standard support on 2027-06-01`,
        }).issue,
    );
    const first = await signed(`/api/issues/${a.id}/dismiss`);
    expect(first.status).toBe(200);
    const setCookie = first.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\/api;/);
    expect(setCookie).toMatch(/Max-Age=600/);
    const cookie = cookieFrom(first);

    clock.now = T + PASSKEY_WINDOW_MS - 1;
    const second = await withCookie(`/api/issues/${disks[0]!.id}/dismiss`, cookie);
    expect(second.status).toBe(200);
    // Used, the window doesn't move on.
    expect(second.headers.get('Set-Cookie')).toBeNull();
    // Any other write that takes a passkey: a site's settings, saved.
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('a.test', 'A', 'https://a.test/', 'other', 'monitoring', 'done', 0)`,
    ).run();
    const configure = await withCookie('/api/sites/a.test/configure', cookie, {
      platform: 'static',
      expectedText: null,
      backupExpectation: null,
      notifications: 'normal',
    });
    expect(configure.status).toBe(200);
    // Approving a batch always signs: the updater checks the approval's own signature.
    expect((await withCookie('/api/batches', cookie)).status).toBe(401);
    // A made-up token, and the real one once the ten minutes are up.
    expect(
      (await withCookie(`/api/issues/${disks[1]!.id}/dismiss`, 'kamaji_dismiss=x')).status,
    ).toBe(401);
    clock.now = T + PASSKEY_WINDOW_MS;
    expect((await withCookie(`/api/issues/${disks[1]!.id}/dismiss`, cookie)).status).toBe(401);
    expect(
      findOpenIssue(db, { resourceType: 'server', resourceId: 'two', kind: 'os-eol' })?.dismissedAt,
    ).toBeNull();
  });

  it('opens a window from any signed write, and none from a refused one', async () => {
    const { db, signed, withCookie } = setup();
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('a.test', 'A', 'https://a.test/', 'other', 'monitoring', 'done', 0)`,
    ).run();
    const opened = await signed('/api/sites/a.test/configure', {
      expectedText: 'A',
      backupExpectation: null,
      notifications: 'normal',
    });
    expect(opened.status).toBe(200);
    const cookie = cookieFrom(opened);
    expect(cookie).toMatch(/^kamaji_passkey=/);
    expect(
      (await withCookie(`/api/issues/${crash(db, T - 60_000).issue.id}/dismiss`, cookie)).status,
    ).toBe(200);
  });

  it('opens no window when the dismiss doesn’t happen', async () => {
    const { db, signed } = setup();
    const { issue } = raiseIssue(db, T, {
      resourceType: 'site',
      resourceId: 'a.test',
      kind: 'certificate',
      severity: 'normal',
      summary: 'A’s certificate ends soon',
    });
    expect((await signed(`/api/issues/${issue.id}/dismiss`)).headers.get('Set-Cookie')).toBeNull();
  });

  it('refuses to dismiss what can be checked again', async () => {
    const { db, signed } = setup();
    const { issue } = raiseIssue(db, T, {
      resourceType: 'site',
      resourceId: 'a.test',
      kind: 'certificate',
      severity: 'normal',
      summary: 'A’s certificate ends soon',
    });
    expect((await signed(`/api/issues/${issue.id}/dismiss`)).status).toBe(409);
  });

  it('checks one site again without a passkey, and the issue clears when it passes', async () => {
    const { db, post, get } = setup();
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES ('a.test', 'A', 'https://a.test/', 'other', 'monitoring', 'done', 0)`,
    ).run();
    raiseIssue(db, T, {
      resourceType: 'site',
      resourceId: 'a.test',
      kind: 'down',
      severity: 'urgent',
      summary: 'A is down',
    });
    const res = await post('/api/sites/a.test/check');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, problem: null });
    expect(
      findOpenIssue(db, { resourceType: 'site', resourceId: 'a.test', kind: 'down' }),
    ).toBeNull();
    expect((await post('/api/sites/nowhere.test/check')).status).toBe(404);
    // Each finding on the Sites page carries its step too.
    raiseIssue(db, T, {
      resourceType: 'site',
      resourceId: 'a.test',
      kind: 'end-of-life:php',
      severity: 'normal',
      summary: 'A: PHP 8.2 reaches the end of security support on 2026-12-31',
    });
    const sites = SitesResponse.parse(await (await get('/api/sites')).json());
    expect(sites.sites[0]?.findings.map((f) => f.action.type)).toEqual(['look']);
  });
});
