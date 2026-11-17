import { ReadyToUpdate } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import type { Discord } from './discord.js';
import { recordObservation } from './observations.js';
import { checkReady, readReady, readyMessage, readyToUpdate } from './ready.js';
import { testDb } from './testing.js';

const HOUR = 60 * 60_000;
// Tuesday 17 November 2026, 19:00 NZDT: the default update time.
const UPDATE = Date.UTC(2026, 10, 17, 6, 0);
const NIGHT = Date.UTC(2026, 10, 16, 14, 0); // that morning, 03:00 NZDT

function site(
  db: Db,
  id: string,
  options: { host?: string; backups?: string; expectation?: string | null } = {},
) {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule,
       backup_expectation, created_at)
     VALUES (?, ?, ?, ?, 'connected', 'done', 1, ?, ?, 0)`,
  ).run(
    id,
    id,
    `https://${id}/`,
    options.host ?? 'craftish',
    options.backups ?? 'off',
    options.expectation === undefined ? 'kamaji' : options.expectation,
  );
  recordObservation(db, {
    resourceType: 'site',
    resourceId: id,
    check: 'hello',
    source: 'plugin',
    at: 0,
    ok: true,
    value: {
      ok: true,
      hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
    },
  });
}

function offer(db: Db, siteId: string, type: string, name: string, from: string, to: string) {
  db.prepare(
    `INSERT INTO components (site_id, type, item, slug, name, version, active, offer_version,
       offer_package, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0)`,
  ).run(siteId, type, type === 'core' ? 'core' : `${name}/${name}.php`, name, name, from, to);
}

function snapshot(db: Db, siteId: string, at: number, ok: boolean, problem: string | null = null) {
  db.prepare(
    `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id, problem)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(siteId, at, at, ok ? 1 : 0, ok ? 'a'.repeat(64) : null, problem);
}

/** Four sites: backed up, failed, Kinsta, and craftish with exports only. */
function sites(): Db {
  const db = testDb();
  site(db, 'fresh.test', { backups: 'weekly' });
  snapshot(db, 'fresh.test', NIGHT + 4 * 60_000, true);
  offer(db, 'fresh.test', 'core', 'WordPress', '6.8.3', '6.9.0');
  offer(db, 'fresh.test', 'plugin', 'akismet', '5.3', '5.3.1');
  site(db, 'broken.test', { backups: 'weekly' });
  snapshot(db, 'broken.test', NIGHT - 7 * 24 * HOUR, true);
  snapshot(db, 'broken.test', NIGHT + 15 * 60_000, false, 'craftish: not on the allowlist');
  offer(db, 'broken.test', 'plugin', 'woocommerce', '9.9.1', '10.0.0');
  site(db, 'kinsta.test', { host: 'kinsta', expectation: 'host' });
  site(db, 'export.test');
  offer(db, 'export.test', 'plugin', 'akismet', '5.3', '5.3.1');
  return db;
}

function discord(ok = true) {
  const sent: string[] = [];
  const d: Discord = {
    configured: true,
    send: async (content) => {
      sent.push(content);
      return ok;
    },
  };
  return { d, sent };
}

describe('ready to update', () => {
  it('leads with a failed backup, then each site’s backup and its updates, majors marked', () => {
    const ready = readyToUpdate(sites(), UPDATE + 60_000, UPDATE);
    expect(ready.sites.map((s) => [s.siteId, s.backup.state])).toEqual([
      ['broken.test', 'failed'],
      ['export.test', 'export'],
      ['fresh.test', 'fresh'],
      ['kinsta.test', 'host'],
    ]);
    expect(ready.sites[0]!.backup).toEqual({
      state: 'failed',
      step: 'backup',
      problem: 'craftish: not on the allowlist',
      at: new Date(NIGHT + 15 * 60_000).toISOString(),
    });
    expect(ready.sites[2]!.updates).toEqual([
      { name: 'WordPress', from: '6.8.3', to: '6.9.0', major: true, security: false },
      { name: 'akismet', from: '5.3', to: '5.3.1', major: false, security: false },
    ]);
    expect(ready.sites[3]!.backup).toEqual({ state: 'host', host: 'Kinsta' });

    const message = readyMessage(ready, 'https://kamaji.example/');
    expect(message.split('\n')).toEqual([
      '**Kamaji: a backup failed before the update time.** Fix it before updating.',
      '4 updates waiting. Nothing is approved until you approve it.',
      '- broken.test: backup failed: craftish: not on the allowlist. Fix it before updating · 1 update (1 major)',
      '- export.test: pre-update export only · 1 update',
      '- fresh.test: backed up Tue 03:04 · 2 updates (1 major)',
      '- kinsta.test: Kinsta’s backups · nothing waiting',
      '<https://kamaji.example/updates>',
    ]);
    // Discord gets counts, never the plugins' names.
    expect(message).not.toMatch(/akismet|woocommerce|WordPress/);
  });

  it('says so when a site with backups on had none at all for this update', () => {
    const db = testDb();
    site(db, 'quiet.test', { backups: 'weekly' });
    snapshot(db, 'quiet.test', NIGHT - 7 * 24 * HOUR, true);
    expect(readyToUpdate(db, UPDATE, UPDATE).sites[0]!.backup).toEqual({
      state: 'failed',
      step: 'backup',
      problem: 'no backup ran for this update',
      at: null,
    });
  });

  it('at the update time: rechecks every site first, sends once, and shows on Overview a day', async () => {
    const db = sites();
    const { d, sent } = discord();
    const order: string[] = [];
    const recheck = async () => {
      order.push('recheck');
      return [{ id: 'kinsta.test', ok: false, problem: 'Craftish Care didn’t answer' }];
    };
    const deps = { discord: d, kamajiUrl: 'https://kamaji.example', recheck };
    expect(await checkReady(db, UPDATE - 60_000, deps)).toBe(false);
    expect(order).toEqual([]);
    expect(await checkReady(db, UPDATE + 2 * 60_000, deps)).toBe(true);
    expect(await checkReady(db, UPDATE + 7 * 60_000, deps)).toBe(false);
    expect(order).toEqual(['recheck']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('kinsta.test: Kinsta’s backups · nothing waiting · not rechecked');
    const shown = readReady(db, UPDATE + 23 * HOUR);
    expect(shown?.sites.find((s) => s.siteId === 'kinsta.test')?.note).toMatch(
      /^Recheck all couldn’t reach it/,
    );
    expect(readReady(db, UPDATE + 25 * HOUR)).toBeNull();
    expect(
      db.prepare("SELECT summary FROM events WHERE kind = 'kamaji.ready-to-update'").all(),
    ).toEqual([
      { summary: 'Ready to update, with 1 failed backup to fix first: 4 updates waiting' },
    ]);
  });

  it('retries a send Discord didn’t take, without rechecking again', async () => {
    const db = sites();
    const down = discord(false);
    let rechecks = 0;
    const recheck = async () => {
      rechecks += 1;
      return [];
    };
    await checkReady(db, UPDATE, { discord: down.d, kamajiUrl: 'https://k', recheck });
    const up = discord(true);
    await checkReady(db, UPDATE + 5 * 60_000, { discord: up.d, kamajiUrl: 'https://k', recheck });
    await checkReady(db, UPDATE + 10 * 60_000, { discord: up.d, kamajiUrl: 'https://k', recheck });
    expect(rechecks).toBe(1);
    expect(up.sent).toHaveLength(1);
  });

  it('doesn’t send last week’s when Kamaji starts long after the update time', async () => {
    const db = sites();
    const { d, sent } = discord();
    expect(
      await checkReady(db, UPDATE + 4 * HOUR, {
        discord: d,
        kamajiUrl: 'https://k',
        recheck: null,
      }),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  it('approves nothing', async () => {
    const db = sites();
    await checkReady(db, UPDATE, { discord: discord().d, kamajiUrl: 'https://k', recheck: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
  });
});

describe('ready to update, with the backup’s restore check', () => {
  /** A site backed up at its night, and its snapshot restore-checked once, passing or not. */
  function checked(ok: boolean) {
    const db = testDb();
    site(db, 'checked.test', { backups: 'weekly' });
    snapshot(db, 'checked.test', NIGHT + 4 * 60_000, true);
    db.prepare(
      `INSERT INTO restore_checks (site_id, snapshot_id, started_at, finished_at, ok, failed_step,
         problem)
       VALUES ('checked.test', ?, ?, ?, ?, ?, ?)`,
    ).run(
      'a'.repeat(64),
      NIGHT + 6 * 60_000,
      NIGHT + 9 * 60_000,
      ok ? 1 : 0,
      ok ? null : 'home page',
      ok ? null : 'the test copy’s home page gave HTTP 500',
    );
    return readyToUpdate(db, UPDATE, UPDATE);
  }

  it('both passed: backed up and restore-checked, with the day and time', () => {
    const ready = checked(true);
    expect(ready.sites[0]!.backup).toEqual({
      state: 'fresh',
      at: new Date(NIGHT + 4 * 60_000).toISOString(),
      restoredAt: new Date(NIGHT + 9 * 60_000).toISOString(),
    });
    expect(readyMessage(ready, 'https://k').split('\n').slice(0, 3)).toEqual([
      '**Kamaji: ready to update.**',
      '0 updates waiting. Nothing is approved until you approve it.',
      '- checked.test: backed up and restore-checked Tue 03:04 · nothing waiting',
    ]);
  });

  it('the restore check failed: it leads, named, with what to do', () => {
    const ready = checked(false);
    expect(ready.sites[0]!.backup).toMatchObject({ state: 'failed', step: 'restore' });
    expect(readyMessage(ready, 'https://k').split('\n').slice(0, 3)).toEqual([
      '**Kamaji: a restore check failed before the update time.** Fix it before updating.',
      '0 updates waiting. Nothing is approved until you approve it.',
      '- checked.test: backed up Tue 03:04, but the restore check failed at “home page”: the test copy’s home page gave HTTP 500. Fix it before updating · nothing waiting',
    ]);
  });

  it('a snapshot not checked yet says only that it’s backed up', () => {
    const db = testDb();
    site(db, 'unchecked.test', { backups: 'weekly' });
    snapshot(db, 'unchecked.test', NIGHT + 4 * 60_000, true);
    expect(readyMessage(readyToUpdate(db, UPDATE, UPDATE), 'https://k')).toContain(
      '- unchecked.test: backed up Tue 03:04 · nothing waiting',
    );
  });

  it('reads a message stored before restore checks were part of it', () => {
    const stored = {
      for: new Date(UPDATE).toISOString(),
      sentAt: new Date(UPDATE).toISOString(),
      sites: [
        {
          siteId: 'old.test',
          siteName: 'old.test',
          backup: { state: 'fresh', at: new Date(NIGHT).toISOString() },
          updates: [],
          note: null,
        },
        {
          siteId: 'older.test',
          siteName: 'older.test',
          backup: { state: 'failed', problem: 'x', at: null },
          updates: [],
          note: null,
        },
      ],
    };
    const parsed = ReadyToUpdate.parse(stored);
    expect(parsed.sites.map((s) => s.backup)).toEqual([
      { state: 'fresh', at: new Date(NIGHT).toISOString(), restoredAt: null },
      { state: 'failed', problem: 'x', at: null, step: 'backup' },
    ]);
  });
});
