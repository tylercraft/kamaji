// Whole-site backups of Kinsta sites (Tyler, 2026-11-18; ops/backups-plan.md, "Kinsta"). Kinsta
// gives each site its own SSH host, port and user, and no sudo, so there's no forced command as on
// craftish: the backups process sends one of two fixed scripts from the repo (kinsta-pull/) over
// SSH with its own key, made for Kinsta alone and kept in the mini's ~/.ssh, never in the repo
// or the database. `pull` writes the same tar as craftish's site-pull, so the read-back and the
// restore check don't change; `test` is Configure's "Test connection".
//
// The app never holds the key: it saves the access and asks for a test through kinsta_access,
// and the backups process answers. The first pull of a site measured over 20 GB waits for
// Tyler's okay.
import { readFileSync } from 'node:fs';
import type { KinstaAccess, KinstaAccessInput, KinstaTest } from '@kamaji/shared';
import { z } from 'zod';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';

/** Over this, the first pull waits for Tyler's okay of the size. */
export const LARGE = 20 * 1024 ** 3;

const iso = (ms: number) => new Date(ms).toISOString();
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MB`;
const size = (bytes: number) => (bytes >= 1024 ** 3 ? gb(bytes) : mb(bytes));

type Row = Record<string, unknown>;

function accessRow(db: Db, siteId: string): Row | undefined {
  return db.prepare('SELECT * FROM kinsta_access WHERE site_id = ?').get(siteId);
}

function siteName(db: Db, siteId: string): string {
  return String(db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId)?.name ?? siteId);
}

/** Whether a Kinsta site has had a good test and, over 20 GB, Tyler's okay: null when ready. */
export function blocked(row: Row | undefined): string | null {
  if (!row) return 'set its SSH host, port and user, then Test connection';
  if (row.tested_at === null || Number(row.test_ok) !== 1) return 'Test connection first';
  const total = Number(row.wp_content_bytes) + Number(row.database_bytes);
  if (total > LARGE && row.size_ok_at === null)
    return `it measured ${gb(total)}, over 20 GB: okay that size first`;
  return null;
}

export function kinstaBlocked(db: Db, siteId: string): string | null {
  return blocked(accessRow(db, siteId));
}

export function kinstaView(db: Db, siteId: string): KinstaAccess | null {
  const r = accessRow(db, siteId);
  if (!r) return null;
  const tested = r.tested_at === null ? null : Number(r.tested_at);
  const asked = r.test_requested_at === null ? null : Number(r.test_requested_at);
  const test: KinstaTest | null =
    tested === null
      ? null
      : Number(r.test_ok) === 1
        ? {
            ok: true,
            at: iso(tested),
            path: String(r.wordpress_path),
            wordpress: String(r.wordpress),
            wpCli: String(r.wp_cli),
            wpContentBytes: Number(r.wp_content_bytes),
            databaseBytes: Number(r.database_bytes),
          }
        : { ok: false, at: iso(tested), problem: String(r.test_problem ?? 'it failed') };
  return {
    host: String(r.host),
    port: Number(r.port),
    user: String(r.user),
    testPending: asked !== null && asked > (tested ?? -1) ? iso(asked) : null,
    test,
    sizeOk:
      r.size_ok_at === null
        ? null
        : {
            at: iso(Number(r.size_ok_at)),
            by: String(r.size_ok_by),
            bytes: Number(r.size_ok_bytes),
          },
    blocked: blocked(r),
  };
}

/** Saves a Kinsta site's access. A change of any of it clears the last test and the okay. */
export function saveAccess(
  db: Db,
  siteId: string,
  input: KinstaAccessInput,
  login: string,
  now: number,
): 'saved' | 'not-kinsta' {
  const site = db
    .prepare("SELECT 1 FROM sites WHERE id = ? AND host_kind = 'kinsta' AND removed_at IS NULL")
    .get(siteId);
  if (!site) return 'not-kinsta';
  const before = accessRow(db, siteId);
  if (
    before &&
    before.host === input.host &&
    Number(before.port) === input.port &&
    before.user === input.user
  )
    return 'saved';
  db.prepare(
    `INSERT INTO kinsta_access (site_id, host, port, user, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id) DO UPDATE SET host = excluded.host, port = excluded.port,
       user = excluded.user, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
       test_requested_at = NULL, tested_at = NULL, test_ok = NULL, test_problem = NULL,
       wordpress_path = NULL, wordpress = NULL, wp_cli = NULL, wp_content_bytes = NULL,
       database_bytes = NULL, size_ok_bytes = NULL, size_ok_at = NULL, size_ok_by = NULL`,
  ).run(siteId, input.host, input.port, input.user, now, login);
  recordEvent(db, now, {
    kind: 'site.kinsta-access',
    summary: `${siteName(db, siteId)}’s Kinsta SSH access set: ${input.user}@${input.host}, port ${input.port}`,
    resourceType: 'site',
    resourceId: siteId,
  });
  return 'saved';
}

/** "Test connection": asked of the backups process, which holds the key. */
export function requestTest(
  db: Db,
  siteId: string,
  now: number,
): 'queued' | 'no-access' | 'already' {
  const view = kinstaView(db, siteId);
  if (!view) return 'no-access';
  if (view.testPending) return 'already';
  db.prepare('UPDATE kinsta_access SET test_requested_at = ? WHERE site_id = ?').run(now, siteId);
  return 'queued';
}

/** Okays the measured size of a site over 20 GB, for its first pull. */
export function okSize(
  db: Db,
  siteId: string,
  login: string,
  now: number,
): 'okayed' | 'not-needed' {
  const r = accessRow(db, siteId);
  if (!r || Number(r.test_ok) !== 1) return 'not-needed';
  const total = Number(r.wp_content_bytes) + Number(r.database_bytes);
  if (total <= LARGE) return 'not-needed';
  db.prepare(
    'UPDATE kinsta_access SET size_ok_bytes = ?, size_ok_at = ?, size_ok_by = ? WHERE site_id = ?',
  ).run(total, now, login, siteId);
  recordEvent(db, now, {
    kind: 'site.kinsta-size-ok',
    summary: `Whole-site backups of ${siteName(db, siteId)} okayed at ${gb(total)} (by ${login})`,
    resourceType: 'site',
    resourceId: siteId,
  });
  return 'okayed';
}

/** Tests asked for and not yet answered, for the backups process. */
export function testsWaiting(db: Db): string[] {
  return db
    .prepare(
      `SELECT k.site_id FROM kinsta_access k JOIN sites s ON s.id = k.site_id
       WHERE s.removed_at IS NULL AND k.test_requested_at IS NOT NULL
         AND k.test_requested_at > COALESCE(k.tested_at, -1)
       ORDER BY k.test_requested_at`,
    )
    .all()
    .map((r) => String(r.site_id));
}

/** The test script's one line (kinsta-pull/test): Kamaji's own format, written there. */
const TestLine = z.discriminatedUnion('ok', [
  z.object({
    format: z.literal(1),
    ok: z.literal(true),
    path: z.string().regex(/^\/[A-Za-z0-9._/-]+$/),
    wordpress: z.string().regex(/^[0-9][0-9.a-zA-Z-]*$/),
    home: z.string(),
    wpContentBytes: z.number().int().nonnegative(),
    databaseBytes: z.number().int().nonnegative(),
    wpCli: z.string().regex(/^[0-9][0-9.a-zA-Z-]*$/),
  }),
  z.object({ format: z.literal(1), ok: z.literal(false), problem: z.string().max(200) }),
]);

export type TestResult =
  | {
      ok: true;
      path: string;
      wordpress: string;
      wpCli: string;
      wpContentBytes: number;
      databaseBytes: number;
    }
  | { ok: false; problem: string };

/** What ssh's exit and the script's line say, in words Kamaji can store: never ssh's stderr. */
export function readTest(siteId: string, ran: { code: number | null; stdout: string }): TestResult {
  if (ran.code === 255 || ran.code === null)
    return {
      ok: false,
      problem:
        ran.code === null
          ? 'SSH didn’t finish in time'
          : 'SSH couldn’t connect or log in: check the host, port and user, and that Kamaji’s key is in MyKinsta',
    };
  const last = ran.stdout.trim().split('\n').pop() ?? '';
  let line: z.infer<typeof TestLine>;
  try {
    const parsed = TestLine.safeParse(JSON.parse(last));
    if (!parsed.success) return { ok: false, problem: 'the test’s answer wasn’t readable' };
    line = parsed.data;
  } catch {
    return { ok: false, problem: 'the test’s answer wasn’t readable' };
  }
  if (!line.ok) return { ok: false, problem: `Kinsta: ${line.problem}` };
  // The login must be this site's, as the pull checks too.
  let host: string;
  try {
    host = new URL(line.home).hostname.replace(/^www\./, '');
  } catch {
    return { ok: false, problem: 'the test’s answer wasn’t readable' };
  }
  if (host !== siteId.replace(/^www\./, ''))
    return { ok: false, problem: `this SSH login is another site (its WordPress is ${host})` };
  return {
    ok: true,
    path: line.path,
    wordpress: line.wordpress,
    wpCli: line.wpCli,
    wpContentBytes: line.wpContentBytes,
    databaseBytes: line.databaseBytes,
  };
}

export function recordTest(db: Db, siteId: string, result: TestResult, now: number): void {
  if (result.ok)
    db.prepare(
      `UPDATE kinsta_access SET tested_at = ?, test_ok = 1, test_problem = NULL, wordpress_path = ?,
         wordpress = ?, wp_cli = ?, wp_content_bytes = ?, database_bytes = ? WHERE site_id = ?`,
    ).run(
      now,
      result.path,
      result.wordpress,
      result.wpCli,
      result.wpContentBytes,
      result.databaseBytes,
      siteId,
    );
  else
    db.prepare(
      'UPDATE kinsta_access SET tested_at = ?, test_ok = 0, test_problem = ? WHERE site_id = ?',
    ).run(now, result.problem, siteId);
  const name = siteName(db, siteId);
  recordEvent(db, now, {
    kind: result.ok ? 'site.kinsta-test' : 'site.kinsta-test-failed',
    summary: result.ok
      ? `Kinsta connection to ${name} works: WordPress ${result.wordpress} at ${result.path}, wp-content ${size(result.wpContentBytes)}, database ${size(result.databaseBytes)}`
      : `Kinsta connection to ${name} failed: ${result.problem}`,
    resourceType: 'site',
    resourceId: siteId,
  });
}

// --- The SSH command -----------------------------------------------------------------------------

export type Script = 'pull' | 'test';

const scriptsDir = new URL('../../../../kinsta-pull/', import.meta.url);

/** The script as it is in the repo, read when it's sent. */
export const readScript = (script: Script) => readFileSync(new URL(script, scriptsDir), 'utf8');

/** Single-quoted for the login shell sshd runs the command with. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** What the login shell runs: the script, named, with the site as its one argument. */
export const remoteCommand = (body: string, script: Script, siteId: string) =>
  `bash -c ${quote(body)} kamaji-${script} ${quote(siteId)}`;

export interface KinstaSsh {
  key: string;
  /** Kamaji's own known_hosts for Kinsta: each host's key is kept from the first connection. */
  knownHosts: string;
}

/** ssh's argv for one script on one site, from its saved access, or null when there's none. */
export function kinstaCommand(
  db: Db,
  ssh: KinstaSsh,
  siteId: string,
  script: Script,
  body: string = readScript(script),
): string[] | null {
  return kinstaSsh(db, ssh, siteId, remoteCommand(body, script, siteId));
}

/** ssh's argv to run `remote` on a Kinsta site's login (rollback/ssh.ts sends the push this way). */
export function kinstaSsh(db: Db, ssh: KinstaSsh, siteId: string, remote: string): string[] | null {
  const r = accessRow(db, siteId);
  if (!r) return null;
  return [
    '/usr/bin/ssh',
    '-i',
    ssh.key,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${ssh.knownHosts}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    '-T',
    '-p',
    String(Number(r.port)),
    '-l',
    String(r.user),
    '--',
    String(r.host),
    remote,
  ];
}
