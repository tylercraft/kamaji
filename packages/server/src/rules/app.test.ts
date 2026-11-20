// Rules from the app's side (ops/rules-plan.md): signing with the passkey every time, pausing
// without one, the Rules page, Updates' labels, "Ready to update", and a rollback pausing a rule.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CareReport,
  RulePreview,
  RulesResponse,
  UpdatesResponse,
  type RuleBody,
} from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import { storeReport } from '../inventory/report.js';
import { recordObservation } from '../observations.js';
import { testAuthenticator } from '../passkeys/testing.js';
import { readyMessage, readyToUpdate } from '../ready.js';
import { requestRollback } from '../rollback/request.js';
import { run, site as rollbackSite, T as ROLLBACK_T, DAY } from '../rollback/testRollback.js';
import { KAMAJI_ZONE, wallClock } from '../sitebackups/schedule.js';
import { testDb } from '../testing.js';
import { runMessage, unannounced } from '../updates/announce.js';
import type { OrgLookup } from './org.js';
import { makeRuleRuns } from './runs.js';
import { ruleRow, saveRule } from './store.js';

const LOGIN = 'tylercraft@github';
const T = Date.UTC(2026, 10, 12, 0, 0);
const PAGE = {
  'Tailscale-User-Login': LOGIN,
  Host: 'kamaji.test',
  Origin: 'https://kamaji.test',
  'Content-Type': 'application/json',
};
const REPORT = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('../inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);
const org: OrgLookup = async () => ({ version: '5.7.2', at: T - 10 * DAY });

function connected(db: Db, id: string, backup: string) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, backup_expectation, created_at)
     VALUES (?, ?, ?, 'craftish', 'connected', 'done', ?, 0)`,
  ).run(id, id === 'one.test' ? 'One' : 'Two', `https://${id}/`, backup);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: id,
    check: 'hello',
    source: 'plugin',
    at: T,
    ok: true,
    value: {
      ok: true,
      hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
    },
  });
  const r = structuredClone(REPORT);
  r.plugins[0]!.offer = { version: '5.7.2', package: true };
  r.plugins[0]!.auto_update = true;
  storeReport(db, { id, name: id }, r, T);
}

const wall = wallClock(KAMAJI_ZONE, T);
const body = (patch: Partial<RuleBody> = {}): RuleBody => ({
  ruleId: null,
  name: 'Minor plugin updates',
  sites: [{ id: 'one.test', url: 'https://one.test/', backup: 'host' }],
  types: ['plugin'],
  only: [],
  leaveOut: ['woocommerce'],
  change: 'minor',
  waitDays: 3,
  securityWaitDays: 0,
  when: { weekday: wall.weekday, hour: wall.hour },
  most: { perSite: 10, sites: 10 },
  ...patch,
});

function setup() {
  const db = testDb();
  connected(db, 'one.test', 'host');
  connected(db, 'two.test', 'tyler');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('update-time', ?, 0)").run(
    JSON.stringify(body().when),
  );
  const tyler = testAuthenticator();
  let at = T - DAY;
  let starts = 0;
  const webDist = mkdtempSync(join(tmpdir(), 'kamaji-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
  const app = createApp({
    db,
    login: LOGIN,
    webDist,
    passkeys: tyler.config,
    org,
    startUpdater: () => (starts += 1),
    now: () => at,
    statusInput: () => ({
      version: '0.1.0',
      commit: null,
      startedAt: 0,
      now: at,
      cycleSeconds: 300,
      heartbeatConfigured: false,
      alertsConfigured: false,
    }),
  });
  const raw = (path: string, text = '{}') =>
    app.request(path, { method: 'POST', headers: PAGE, body: text });
  const signed = (path: string, text: string) => tyler.post(app, path, text, PAGE);
  const get = async <S extends { parse: (v: unknown) => unknown }>(path: string, schema: S) =>
    schema.parse(await (await app.request(path, { headers: PAGE })).json()) as ReturnType<
      S['parse']
    >;
  return { db, app, raw, signed, get, setAt: (t: number) => (at = t), starts: () => starts };
}

describe('the Rules routes', () => {
  it('signs a rule with the passkey every time, even inside the passkey’s window', async () => {
    const s = setup();
    expect((await s.raw('/api/rules', JSON.stringify(body()))).status).toBe(401);
    const made = await s.signed('/api/rules', JSON.stringify(body()));
    expect(made.status).toBe(201);
    const { id, version } = (await made.json()) as { id: string; version: number };
    expect(version).toBe(1);
    // The window a signed write opens doesn't cover a rule: there'd be no signature to check.
    const again = JSON.stringify(body({ ruleId: id }));
    expect((await s.raw('/api/rules', again)).status).toBe(401);
    expect((await s.signed('/api/rules', again)).status).toBe(201);
    expect(ruleRow(s.db, id)?.version).toBe(2);
    const stored = JSON.parse(
      String(s.db.prepare('SELECT approval FROM rule_versions WHERE version = 2').get()!.approval),
    ) as { body: string };
    expect(stored.body).toBe(again);
  });

  it('refuses a site no rule may name, or one whose address the page had wrong', async () => {
    const s = setup();
    const tylers = body({ sites: [{ id: 'two.test', url: 'https://two.test/', backup: 'host' }] });
    const res = await s.signed('/api/rules', JSON.stringify(tylers));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'invalid',
      problem:
        'two.test can’t be in a rule: its backup is your word each time, which a rule can’t give',
    });
    const moved = body({ sites: [{ id: 'one.test', url: 'https://old.test/', backup: 'host' }] });
    expect((await s.signed('/api/rules', JSON.stringify(moved))).status).toBe(409);
  });

  it('pauses without a passkey, resumes only by signing again, deletes with one', async () => {
    const s = setup();
    const { id } = (await (await s.signed('/api/rules', JSON.stringify(body()))).json()) as {
      id: string;
    };
    expect((await s.raw(`/api/rules/${id}/pause`)).status).toBe(200);
    expect(ruleRow(s.db, id)).toMatchObject({ pausedBy: LOGIN, pausedReason: 'Paused by Tyler' });
    expect((await s.signed('/api/rules', JSON.stringify(body({ ruleId: id })))).status).toBe(201);
    expect(ruleRow(s.db, id)).toMatchObject({ pausedAt: null, version: 2 });
    const fresh = setup();
    const made = (await (await fresh.signed('/api/rules', JSON.stringify(body()))).json()) as {
      id: string;
    };
    // A later process, say, with no passkey window: deleting needs the passkey.
    fresh.setAt(T + DAY);
    expect((await fresh.raw(`/api/rules/${made.id}/delete`)).status).toBe(401);
  });

  it('shows each rule as a sentence, what it would take, and the auto-updates it overlaps', async () => {
    const s = setup();
    await s.signed('/api/rules', JSON.stringify(body()));
    const page = await s.get('/api/rules', RulesResponse);
    expect(page.sites.map((x) => x.id)).toEqual(['one.test']);
    expect(page.notAllowed).toEqual([
      {
        id: 'two.test',
        name: 'Two',
        why: 'its backup is your word each time, which a rule can’t give',
      },
    ]);
    const [rule] = page.rules;
    expect(rule!.words).toMatch(
      /^Patch and minor updates to any plugin, except woocommerce, on One/,
    );
    expect(rule!.takes.map((t) => `${t.name} ${t.from} → ${t.to}`)).toEqual([
      'Akismet Anti-spam: Spam Protection 5.3 → 5.7.2',
    ]);
    expect(rule!.autoUpdates).toEqual([
      { siteName: 'One', name: 'Akismet Anti-spam: Spam Protection' },
    ]);
    expect(rule!.warnings).toEqual([]);
    // Updates labels what the rule would take.
    const updates = await s.get('/api/updates', UpdatesResponse);
    const akismet = updates.items.find((i) => i.siteId === 'one.test' && i.type === 'plugin')!;
    expect(akismet.rule).toMatchObject({ name: 'Minor plugin updates' });
    expect(
      updates.items.find((i) => i.siteId === 'two.test' && i.type === 'plugin')!.rule,
    ).toBeNull();
  });

  it('previews a rule as written, without a passkey, saving nothing', async () => {
    const s = setup();
    const preview = async (b: RuleBody) =>
      RulePreview.parse(await (await s.raw('/api/rules/preview', JSON.stringify(b))).json());
    const minor = await preview(body());
    expect(minor.problem).toBeNull();
    expect(minor.takes.map((t) => `${t.name} ${t.from} → ${t.to}`)).toEqual([
      'Akismet Anti-spam: Spam Protection 5.3 → 5.7.2',
    ]);
    // Changing the form changes the answer, by the same matcher a signed rule uses.
    const patch = await preview(body({ change: 'patch' }));
    expect(patch.takes).toEqual([]);
    expect(patch.misses.find((m) => m.siteId === 'one.test' && m.to === '5.7.2')?.why).toBe(
      'a minor version, and the rule takes patches only',
    );
    const tylers = await preview(
      body({ sites: [{ id: 'two.test', url: 'https://two.test/', backup: 'host' }] }),
    );
    expect(tylers.takes).toEqual([]);
    expect(tylers.problem).toMatch(/^two.test can’t be in a rule/);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM rule_versions').get()!.n).toBe(0);
    expect((await s.raw('/api/rules/preview', '{"name":1}')).status).toBe(400);
  });

  it('warns when a signed site’s address changed, or the update time moved', async () => {
    const s = setup();
    await s.signed('/api/rules', JSON.stringify(body()));
    s.db.prepare("UPDATE sites SET url = 'https://new.test/' WHERE id = 'one.test'").run();
    s.db.prepare('UPDATE settings SET value = \'{"weekday":1,"hour":9}\'').run();
    const [rule] = (await s.get('/api/rules', RulesResponse)).rules;
    expect(rule!.warnings).toEqual([
      'One won’t run: its address changed since the rule was signed',
      'It was signed for another update time than Kamaji’s now, so its backups won’t line up: sign it again',
    ]);
    expect(rule!.takes).toEqual([]);
  });

  it('Pause this run, without a passkey: its updates go back to the queue', async () => {
    const s = setup();
    await s.signed('/api/rules', JSON.stringify(body()));
    await makeRuleRuns(s.db, T, org);
    const batch = String(s.db.prepare('SELECT id FROM batches').get()!.id);
    expect((await s.raw(`/api/batches/${batch}/pause`)).status).toBe(200);
    const updates = await s.get('/api/updates', UpdatesResponse);
    expect(updates.batches[0]!.sites[0]).toMatchObject({
      state: 'held',
      heldReason: 'Paused by Tyler before it ran',
    });
    expect(
      updates.items.some((i) => i.siteId === 'one.test' && i.item === 'akismet/akismet.php'),
    ).toBe(true);
    // Tyler did it, so Discord isn't told.
    expect(unannounced(s.db)).toEqual([]);
  });

  it('a finished rule’s run tells Discord it was a rule’s, without its name', () => {
    const line = runMessage(
      {
        id: 'b',
        approvedBy: 'rule',
        rule: true,
        finishedAt: 0,
        lines: ['✅ Updated One: 1 plugin'],
        anchor: 'run-b-one',
      },
      'https://kamaji.test',
    );
    expect(line).toBe(
      'By a rule you signed:\n✅ Updated One: 1 plugin\n<https://kamaji.test/updates#run-b-one>',
    );
  });
});

describe('Ready to update, with a rule’s run', () => {
  it('counts the rule’s run, and Discord never gets the rule’s name', async () => {
    const s = setup();
    await s.signed('/api/rules', JSON.stringify(body({ name: 'Akismet and friends' })));
    await makeRuleRuns(s.db, T, org);
    const ready = readyToUpdate(s.db, T, T);
    expect(ready.rules).toEqual([
      {
        name: 'Akismet and friends',
        updates: 1,
        sites: 1,
        startsAt: new Date(T + 3_600_000).toISOString(),
      },
    ]);
    const message = readyMessage(ready, 'https://kamaji.test');
    expect(message).toContain('A rule will run 1 update on 1 site from');
    expect(message).toContain('Nothing else is approved until you approve it.');
    expect(message).not.toContain('Akismet');
  });
});

describe('a rollback of a rule’s run', () => {
  it('pauses the rule, by whoever asked, without an alarm', () => {
    const db = testDb();
    rollbackSite(db);
    run(db, { snapshot: 'relied', exportAt: '20261119T025500Z' });
    db.prepare("INSERT INTO rules (id, created_at, created_by) VALUES ('r1', 0, 'tyler')").run();
    saveRule(db, body({ ruleId: 'r1' }), '{}', 'tyler', 0);
    db.prepare("UPDATE batches SET rule_id = 'r1', rule_version = 1 WHERE id = 'batch1'").run();
    const asked = requestRollback(
      db,
      'one.test',
      { batchId: 'batch1', withDatabase: false },
      'tyler',
      ROLLBACK_T + 2 * DAY,
    );
    expect(asked.ok).toBe(true);
    expect(ruleRow(db, 'r1')).toMatchObject({
      pausedBy: 'tyler',
      pausedReason: 'a run it made was rolled back',
    });
    expect(db.prepare("SELECT 1 FROM issues WHERE kind = 'rule-paused'").get()).toBeUndefined();
  });
});
