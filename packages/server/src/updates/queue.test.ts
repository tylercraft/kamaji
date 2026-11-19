// The queue's security flag and fix count, against the real feed records (wordfence/fixtures)
// plus a second, later-fixed record for the same plugin: an offered update can fix some of a
// plugin's vulnerabilities and not others, and must say which.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CareReport } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { storeReport } from '../inventory/report.js';
import { recordObservation } from '../observations.js';
import { testDb } from '../testing.js';
import { checkWordfence } from '../wordfence/feed.js';
import { queue } from './queue.js';

const T = Date.UTC(2026, 10, 13, 0, 0);
const SITE = { id: 'kamaji-wp.ddev.site', name: 'Kamaji test' };
const FEED = JSON.parse(
  readFileSync(new URL('../wordfence/fixtures/feed.json', import.meta.url), 'utf8'),
) as Record<string, { software: { slug: string }[] }>;
const BASE = CareReport.parse(
  JSON.parse(
    readFileSync(new URL('../inventory/fixtures/care-report.json', import.meta.url), 'utf8'),
  ),
);

/** The wpvivid record (fixed in 0.9.138), and a copy fixed only in 0.9.200. */
function feedFile(): string {
  const [id, wpvivid] = Object.entries(FEED).find(([, r]) =>
    r.software.some((s) => s.slug === 'wpvivid-backuprestore'),
  )!;
  const later = structuredClone(wpvivid) as unknown as {
    id: string;
    software: Record<string, unknown>[];
  };
  later.id = `${id}-later`;
  later.software[0]!.affected_versions = {
    '[*, 0.9.200)': {
      from_version: '*',
      from_inclusive: true,
      to_version: '0.9.200',
      to_inclusive: false,
    },
  };
  later.software[0]!.patched_versions = ['0.9.200'];
  const file = join(mkdtempSync(join(tmpdir(), 'kamaji-feed-')), 'feed.json');
  writeFileSync(file, JSON.stringify({ [id]: wpvivid, [later.id]: later }));
  return file;
}

async function siteOffering(offer: string) {
  const db = testDb();
  db.prepare(
    `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
     VALUES (?, ?, 'https://kamaji-wp.ddev.site/', 'craftish', 'connected', 'done', ?)`,
  ).run(SITE.id, SITE.name, T);
  recordObservation(db, {
    resourceType: 'site',
    resourceId: SITE.id,
    check: 'hello',
    source: 'plugin',
    at: T,
    ok: true,
    value: {
      ok: true,
      hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
    },
  });
  const r = structuredClone(BASE);
  r.plugins.push({
    file: 'wpvivid-backuprestore/wpvivid-backuprestore.php',
    slug: 'wpvivid-backuprestore',
    name: 'WPvivid',
    version: '0.9.137',
    active: true,
    auto_update: false,
    offer: { version: offer, package: true },
  });
  storeReport(db, SITE, r, T);
  await checkWordfence(db, {
    apiKey: undefined,
    feedPath: '',
    localFile: feedFile(),
    now: () => T,
    signal: new AbortController().signal,
  });
  const item = queue(db).items.find((i) => i.name === 'WPvivid')!;
  const summary = String(
    db
      .prepare("SELECT summary FROM issues WHERE kind LIKE 'vulnerable:%' AND resolved_at IS NULL")
      .get()?.summary,
  );
  return { item, summary };
}

describe('an update’s security fixes', () => {
  it('counts a partial fix as partial', async () => {
    const { item, summary } = await siteOffering('0.9.150');
    expect(item).toMatchObject({ security: true, fixes: 1, findings: 2 });
    expect(summary).toBe(
      'Kamaji test: a plugin has 2 known vulnerabilities; the offered update fixes 1 of 2',
    );
  });

  it('counts a full fix as full', async () => {
    const { item, summary } = await siteOffering('0.9.200');
    expect(item).toMatchObject({ security: true, fixes: 2, findings: 2 });
    expect(summary).toBe(
      'Kamaji test: a plugin has 2 known vulnerabilities, all fixed by the update WordPress offers',
    );
  });

  it('isn’t a security fix when the offer fixes none', async () => {
    const { item, summary } = await siteOffering('0.9.137.1');
    expect(item).toMatchObject({ security: false, fixes: 0, findings: 2 });
    expect(summary).toBe(
      'Kamaji test: a plugin has 2 known vulnerabilities, with a fix WordPress isn’t offering yet',
    );
  });
});

describe('an offer for what a rollback put back', () => {
  function site() {
    const db = testDb();
    db.prepare(
      `INSERT INTO sites (id, name, url, host_kind, mode, setup, created_at)
       VALUES (?, ?, 'https://kamaji-wp.ddev.site/', 'craftish', 'connected', 'done', ?)`,
    ).run(SITE.id, SITE.name, T);
    recordObservation(db, {
      resourceType: 'site',
      resourceId: SITE.id,
      check: 'hello',
      source: 'plugin',
      at: T,
      ok: true,
      value: {
        ok: true,
        hello: { plugin: '0.2.2', capabilities: { can_update: true, update_blockers: [] } },
      },
    });
    // Akismet at 5.3, offered 5.7.2 (the fixture's report).
    storeReport(db, SITE, BASE, T);
    db.prepare(
      `INSERT INTO batches (id, approved_at, approved_by, one_site_first, state) VALUES ('b', 0, 'tyler', 0, 'finished')`,
    ).run();
    return db;
  }
  const rollback = (
    db: ReturnType<typeof testDb>,
    id: string,
    at: number,
    /** The plugin file, its name, the version it went back from, and to. */
    item: [string, string, string, string],
    o: { kind?: 'rollback' | 'undo'; undoes?: string; changed?: string } = {},
  ) => {
    db.prepare(
      `INSERT INTO rollbacks (id, kind, undoes, site_id, batch_id, host, requested_at, requested_by,
         with_database, state, changed, finished_at)
       VALUES (?, ?, ?, ?, 'b', 'craftish', ?, 'tyler', 0, 'done', ?, ?)`,
    ).run(
      id,
      o.kind ?? 'rollback',
      o.undoes ?? null,
      SITE.id,
      at,
      o.changed ?? 'files',
      at + 60_000,
    );
    if ((o.kind ?? 'rollback') === 'rollback')
      db.prepare(
        `INSERT INTO rollback_items (rollback_id, position, type, item, name, now_version, back_version)
         VALUES (?, 0, 'plugin', ?, ?, ?, ?)`,
      ).run(id, ...item);
  };
  const AKISMET: [string, string, string, string] = [
    'akismet/akismet.php',
    'Akismet',
    '5.7.2',
    '5.3',
  ];
  const akismet = (db: ReturnType<typeof testDb>) =>
    queue(db).items.find((i) => i.item === 'akismet/akismet.php')!.rolledBackAt;

  it('says when it was put back from that same version', () => {
    const db = site();
    expect(akismet(db)).toBeNull();
    rollback(db, 'r1', T + 1000, AKISMET);
    expect(akismet(db)).toBe(new Date(T + 61_000).toISOString());
  });

  it('not once it’s undone, nor for a newer version than the one put back', () => {
    const db = site();
    rollback(db, 'r1', T + 1000, AKISMET);
    rollback(db, 'u1', T + 2000, AKISMET, { kind: 'undo', undoes: 'r1' });
    expect(akismet(db)).toBeNull();
    const newer = site();
    rollback(newer, 'r1', T + 1000, ['akismet/akismet.php', 'Akismet', '5.7.1', '5.3']);
    expect(akismet(newer)).toBeNull();
  });

  it('by the item’s own latest rollback: a later one of something else leaves it marked', () => {
    const db = site();
    rollback(db, 'r1', T + 1000, AKISMET);
    rollback(db, 'r2', T + 5000, ['hello.php', 'Hello Dolly', '1.7.3', '1.7.2']);
    expect(akismet(db)).toBe(new Date(T + 61_000).toISOString());
    // A rollback that changed nothing doesn't count.
    const none = site();
    rollback(none, 'r1', T + 1000, AKISMET, {
      changed: 'none',
    });
    expect(akismet(none)).toBeNull();
  });
});
