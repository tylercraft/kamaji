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
