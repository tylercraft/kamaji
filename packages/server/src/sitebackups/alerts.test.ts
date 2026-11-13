import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { Discord } from '../discord.js';
import { recordEvent } from '../events.js';
import { notifyNow, sendDigest, type NotifyOptions } from '../notify.js';
import { testDb } from '../testing.js';
import { checkBackupsOverdue } from './alerts.js';
import { fakeRestic } from './fakeRestic.js';
import { backUpSite, checkRestore, type BackupsDeps } from './run.js';
import { pullOf } from './testTar.js';

const DAY = 24 * 60 * 60_000;
const T = Date.UTC(2026, 10, 13, 20, 0); // 09:00 in Christchurch, after the digest's 07:30
const options: NotifyOptions = {
  kamajiUrl: 'https://kamaji.test',
  workerAlerts: true,
  digestAt: '07:30',
};

function outbox() {
  const sent: string[] = [];
  const discord: Discord = {
    configured: true,
    send: async (content) => {
      sent.push(content);
      return true;
    },
  };
  return { sent, discord };
}

function site(db: Db, id: string, schedule = 'weekly') {
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, own, site_backup_schedule, created_at)
     VALUES (?, ?, ?, 'craftish', 'connected', 'done', 1, ?, 0)`,
  ).run(id, id, `https://${id}/`, schedule);
}

function deps(db: Db, pull: (s: string) => Buffer | { problem: string }, now: number) {
  const restore: { value: Awaited<ReturnType<BackupsDeps['restore']>> } = { value: { ok: true } };
  const d: BackupsDeps = {
    db,
    restic: fakeRestic(pull).restic,
    restore: async () => restore.value,
    pullCommand: () => [],
    now: () => now,
    log: () => {},
  };
  return { d, restore };
}

const snapshot = (db: Db, siteId: string, at: number) =>
  db
    .prepare(
      `INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(siteId, at, at, 'a'.repeat(64));

describe('backup alerts', () => {
  it('sends a failed backup to Discord at once, and its recovery when the next one works', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { sent, discord } = outbox();
    await backUpSite(
      deps(db, () => ({ problem: 'craftish: the database export failed' }), T).d,
      'one.test',
    );
    await notifyNow(db, T, discord, options);
    expect(sent).toEqual([
      '**Kamaji**\n- Whole-site backup of one.test failed: craftish: the database export failed\n<https://kamaji.test>',
    ]);
    await backUpSite(deps(db, (s) => pullOf(s), T + 60_000).d, 'one.test');
    await notifyNow(db, T + 60_000, discord, options);
    expect(sent[1]).toMatch(/^\*\*Kamaji\*\*\n- Resolved: Whole-site backup of one.test failed/);
  });

  it('counts a snapshot that didn’t read back as a failed backup', async () => {
    const db = testDb();
    site(db, 'one.test');
    const { sent, discord } = outbox();
    await backUpSite(deps(db, () => pullOf('other.test'), T).d, 'one.test');
    await notifyNow(db, T, discord, options);
    expect(sent[0]).toContain('the backup is of another site; the snapshot was discarded');
  });

  it('sends a failed restore check at once', async () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', T - DAY);
    const { sent, discord } = outbox();
    const { d, restore } = deps(db, (s) => pullOf(s), T);
    restore.value = { ok: false, step: 'database', problem: 'database.sql didn’t import' };
    await checkRestore(d, 'one.test');
    await notifyNow(db, T, discord, options);
    expect(sent).toEqual([
      '**Kamaji**\n- one.test’s restore check failed at “database”: database.sql didn’t import\n<https://kamaji.test>',
    ]);
  });
});

describe('overdue backups', () => {
  it('go in the morning digest 2 days past the week or fortnight, never at once', async () => {
    const db = testDb();
    site(db, 'late.test');
    snapshot(db, 'late.test', T - 9 * DAY - 60_000);
    site(db, 'grace.test');
    snapshot(db, 'grace.test', T - 8 * DAY);
    site(db, 'fortnight.test', 'fortnightly');
    snapshot(db, 'fortnight.test', T - 12 * DAY);
    site(db, 'never.test');
    recordEvent(db, T - 10 * DAY, {
      kind: 'site.backup-schedule',
      summary: 'Whole-site backups of never.test: weekly',
      resourceType: 'site',
      resourceId: 'never.test',
    });
    site(db, 'off.test', 'off');
    checkBackupsOverdue(db, T);
    const { sent, discord } = outbox();
    expect(await notifyNow(db, T, discord, options)).toBe(0);
    expect(await sendDigest(db, T, discord, options)).toBe(true);
    expect(sent).toEqual([
      [
        '**Kamaji, this morning:** 2 to look at when you have a moment',
        '- late.test’s whole-site backup is overdue: the last good one was 9 days ago',
        '- never.test has no whole-site backup yet, 10 days after they were turned on',
        '<https://kamaji.test>',
      ].join('\n'),
    ]);
  });

  it('clears once there’s a fresh backup, or the backups are turned off', () => {
    const db = testDb();
    site(db, 'one.test');
    snapshot(db, 'one.test', T - 10 * DAY);
    checkBackupsOverdue(db, T);
    const open = () =>
      db
        .prepare("SELECT kind FROM issues WHERE resolved_at IS NULL AND resource_id = 'one.test'")
        .all()
        .map((r) => r.kind);
    expect(open()).toEqual(['backup-overdue']);
    snapshot(db, 'one.test', T);
    checkBackupsOverdue(db, T);
    expect(open()).toEqual([]);
    snapshot(db, 'one.test', T - 30 * DAY);
    db.prepare('DELETE FROM site_snapshots WHERE started_at = ?').run(T);
    checkBackupsOverdue(db, T);
    expect(open()).toEqual(['backup-overdue']);
    db.prepare("UPDATE sites SET site_backup_schedule = 'off'").run();
    checkBackupsOverdue(db, T);
    expect(open()).toEqual([]);
  });
});
