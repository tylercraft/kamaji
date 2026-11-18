import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { realExec } from '../sitebackups/exec.js';
import { fakeRestic } from '../sitebackups/fakeRestic.js';
import type { Exec } from '../sitebackups/restore.js';
import { tarOf } from '../sitebackups/testTar.js';
import { testDb } from '../testing.js';
import { requestRollback, requestUndo } from './request.js';
import { headerVersion, orphaned, planText, readPush, runRollback, type PushDeps } from './push.js';
import { AKISMET, DAY, installed, run, site, T, THEME } from './testRollback.js';

const NOW = T + 2 * DAY;
const plugin = (v: string) =>
  Buffer.from(`<?php\n/**\n * Plugin Name: Akismet\n * Version: ${v}\n */\n`);
const theme = (v: string) => Buffer.from(`/*\nTheme Name: Twenty X\nVersion: ${v}\n*/\n`);

/** The pull as it was before the run: the old versions, and things the run didn't touch. */
function snapshotTar(o: { akismet?: string; theme?: string } = {}) {
  return tarOf([
    ['wp-content/', null],
    ['wp-content/plugins/', null],
    ['wp-content/plugins/akismet/', null],
    ['wp-content/plugins/akismet/akismet.php', plugin(o.akismet ?? '5.3')],
    ['wp-content/plugins/akismet/class.php', Buffer.from('<?php // old')],
    ['wp-content/plugins/untouched/', null],
    ['wp-content/plugins/untouched/untouched.php', plugin('2.0')],
    ['wp-content/themes/', null],
    ['wp-content/themes/twentyx/', null],
    ['wp-content/themes/twentyx/style.css', theme(o.theme ?? '1.6')],
    ['wp-content/uploads/', null],
    ['wp-content/uploads/photo.jpg', Buffer.from('jpeg')],
    ['database.sql', Buffer.from('-- the dump from before\n')],
    ['manifest.json', Buffer.from('{}')],
  ]);
}

const DONE =
  '{"format":1,"step":"check","ok":true}\n{"format":1,"step":"stage","ok":true}\n{"format":1,"step":"save","ok":true}\n{"format":1,"step":"maintenance","ok":true}\n{"format":1,"step":"swap","ok":true}\n{"format":1,"ok":true,"step":"done","database":false,"warnings":[]}\n';

function setup(
  o: {
    tar?: Buffer;
    answer?: (words: string) => { code: number; stdout: string; stderr?: string };
  } = {},
) {
  const db = testDb();
  site(db);
  const { restic } = fakeRestic(() => o.tar ?? snapshotTar());
  // The snapshot the run made, at the id the run's snapshot row has.
  return { db, restic, ...harness(db, restic, o.answer) };
}

function harness(
  db: Db,
  restic: ReturnType<typeof fakeRestic>['restic'],
  answer: (words: string) => { code: number; stdout: string; stderr?: string } = () => ({
    code: 0,
    stdout: DONE,
  }),
) {
  const workDir = mkdtempSync(join(tmpdir(), 'kamaji-rollback-'));
  const sent: { words: string; members: string[]; plan: string | null; database: string | null }[] =
    [];
  const tarExec = realExec();
  const exec: Exec = async (command, args, options) => {
    if (command !== '/usr/bin/ssh') return tarExec(command, args, options);
    const words = args.at(-1)!;
    let members: string[] = [];
    let plan: string | null = null;
    let database: string | null = null;
    if (options?.stdinFile) {
      members = execFileSync('/usr/bin/tar', ['-tf', options.stdinFile], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      plan = execFileSync('/usr/bin/tar', ['-xOf', options.stdinFile, 'plan.txt'], {
        encoding: 'utf8',
      });
      if (members.includes('database.sql'))
        database = execFileSync('/usr/bin/tar', ['-xOf', options.stdinFile, 'database.sql'], {
          encoding: 'utf8',
        });
    }
    sent.push({ words, members, plan, database });
    const a = answer(words);
    return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? '' };
  };
  const logged: string[] = [];
  const deps: PushDeps = {
    db,
    restic,
    exec,
    workDir,
    tar: '/usr/bin/tar',
    pushCommand: (_site, _host, words) => ['/usr/bin/ssh', 'host', words.join(' ')],
    now: () => NOW,
    sleep: async () => {},
    log: (m) => logged.push(m),
  };
  return { deps, sent, workDir, logged };
}

/** The fake restic's first snapshot id: its dump is the given tar. */
async function snapshotted(restic: ReturnType<typeof fakeRestic>['restic'], db: Db) {
  const made = await restic.backup('one.test', []);
  if (!made.ok) throw new Error('no snapshot');
  db.prepare('UPDATE site_snapshots SET snapshot_id = ?').run(made.snapshotId);
  return made.snapshotId;
}

const row = (db: Db) =>
  db.prepare('SELECT * FROM rollbacks ORDER BY requested_at DESC, rowid DESC LIMIT 1').get()!;

async function asked(
  db: Db,
  restic: ReturnType<typeof fakeRestic>['restic'],
  withDatabase = false,
  runOptions: Parameters<typeof run>[1] = {},
) {
  run(db, runOptions);
  await snapshotted(restic, db);
  const a = requestRollback(db, 'one.test', { batchId: 'batch1', withDatabase }, 'tyler', NOW);
  if (!a.ok) throw new Error(a.why);
  return a.id;
}

describe('the push', () => {
  it('sends only the folders the run changed, from the snapshot, with the plan first', async () => {
    const { db, restic, deps, sent, workDir } = setup();
    const id = await asked(db, restic);
    await runRollback(deps, id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.words).toBe(`rollback one.test ${id}`);
    expect(sent[0]!.members[0]).toBe('plan.txt');
    expect(sent[0]!.members).toEqual(
      expect.arrayContaining([
        'wp-content/plugins/akismet/akismet.php',
        'wp-content/plugins/akismet/class.php',
        'wp-content/themes/twentyx/style.css',
      ]),
    );
    expect(sent[0]!.members.join(' ')).not.toMatch(/untouched|uploads|database\.sql|manifest|\._/);
    expect(sent[0]!.plan).toBe(
      `format 1\nid ${id}\nsite one.test\nitem plugin akismet/akismet.php 5.3.1 5.3\nitem theme twentyx 1.6.1 1.6\n`,
    );
    expect(row(db)).toMatchObject({
      state: 'done',
      step: 'done',
      changed: 'all',
      problem: null,
      checked_at: null,
    });
    // Paused while it runs; the updater's checks end the pause.
    expect(
      Number(db.prepare('SELECT updating_until FROM sites').get()!.updating_until),
    ).toBeGreaterThan(NOW);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('with the database on craftish, names the export the server already has; on Kinsta, sends the dump', async () => {
    const one = setup();
    const id = await asked(one.db, one.restic, true, {
      snapshot: 'relied',
      exportAt: '20261119T025500Z',
    });
    await runRollback(one.deps, id);
    expect(one.sent[0]!.plan).toContain(
      'database export 20261119T025500Z\nsince 20261119T025500Z\n',
    );
    expect(one.sent[0]!.database).toBeNull();

    const db = testDb();
    site(db, 'one.test', 'kinsta');
    const { restic } = fakeRestic(() => snapshotTar());
    const k = harness(db, restic);
    const kid = await asked(db, restic, true);
    await runRollback(k.deps, kid);
    expect(k.sent[0]!.plan).toContain('database tar\nsince 20261119T025000Z\n');
    expect(k.sent[0]!.database).toBe('-- the dump from before\n');
    expect(readdirSync(k.workDir)).toEqual([]);
  });

  it('records the count, and what the script said when it stopped', async () => {
    const { db, restic, deps } = setup({
      answer: () => ({
        code: 1,
        stdout:
          '{"format":1,"step":"check","ok":true}\n{"format":1,"step":"count","ok":true,"orders":12,"comments":3,"users":1}\n{"format":1,"ok":false,"step":"database","problem":"the database didn’t import; it’s as it was, and the files were rolled back","changed":"files"}\n',
      }),
    });
    const id = await asked(db, restic, true);
    await runRollback(deps, id);
    expect(row(db)).toMatchObject({
      state: 'failed',
      step: 'database',
      changed: 'files',
      counts: JSON.stringify({ orders: 12, comments: 3, users: 1 }),
      checked_at: null,
    });
  });

  it('refuses a snapshot whose copy isn’t what the run replaced, sending nothing', async () => {
    const { db, restic, deps, sent } = setup({ tar: snapshotTar({ akismet: '5.2' }) });
    const id = await asked(db, restic);
    await runRollback(deps, id);
    expect(sent).toEqual([]);
    expect(row(db)).toMatchObject({
      state: 'failed',
      step: 'snapshot',
      changed: 'none',
      problem:
        'the restore point’s Akismet is 5.2, not 5.3: it’s older than a change made outside Kamaji',
    });
    // Nothing changed: told at once, with its pause ended.
    expect(row(db).checked_at).toBe(NOW);
    expect(db.prepare('SELECT updating_until FROM sites').get()!.updating_until).toBeNull();
    expect(
      db.prepare("SELECT summary FROM events WHERE kind = 'site.rollback-failed'").get()!.summary,
    ).toContain('stopped at “snapshot” with nothing changed');
  });

  it('asks again before it starts: a site that moved on since isn’t rolled back', async () => {
    const { db, restic, deps, sent } = setup();
    const id = await asked(db, restic);
    installed(db, 'one.test', 'theme', THEME.item, '1.6.2');
    await runRollback(deps, id);
    expect(sent).toEqual([]);
    expect(row(db)).toMatchObject({ state: 'failed', step: 'check', changed: 'none' });
    expect(String(row(db).problem)).toContain('Twenty X went from 1.6.1 to 1.6.2');
  });

  it('reads the result back when the connection drops after the site began changing', async () => {
    let calls = 0;
    const { db, restic, deps, sent } = setup({
      answer: (words) => {
        calls += 1;
        if (words.startsWith('rollback'))
          return {
            code: 255,
            stdout: '{"format":1,"step":"check","ok":true}\n{"format":1,"step":"save","ok":true}\n',
          };
        return calls < 3
          ? {
              code: 0,
              stdout:
                '{"format":1,"ok":false,"step":"unknown","problem":"it has no result yet","changed":"unknown"}\n',
            }
          : {
              code: 0,
              stdout:
                '{"format":1,"ok":true,"step":"done","database":false,"warnings":["Kinsta’s cache couldn’t be cleared"]}\n',
            };
      },
    });
    const id = await asked(db, restic);
    await runRollback(deps, id);
    expect(sent.map((s) => s.words)).toEqual([
      `rollback one.test ${id}`,
      `result one.test ${id} rollback`,
      `result one.test ${id} rollback`,
    ]);
    expect(row(db)).toMatchObject({
      state: 'done',
      changed: 'all',
      warnings: JSON.stringify(['Kinsta’s cache couldn’t be cleared']),
    });
  });

  it('says nothing changed when SSH couldn’t connect, and part way when the result never comes', async () => {
    const down = setup({
      answer: () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host: Connection refused' }),
    });
    const id = await asked(down.db, down.restic);
    await runRollback(down.deps, id);
    expect(row(down.db)).toMatchObject({
      state: 'failed',
      step: 'connection',
      changed: 'none',
      problem: 'SSH couldn’t connect to the host',
    });

    const lost = setup({
      answer: (words) =>
        words.startsWith('rollback')
          ? { code: 255, stdout: '{"format":1,"step":"swap","ok":true}\n' }
          : { code: 255, stdout: '' },
    });
    const lid = await asked(lost.db, lost.restic);
    await runRollback(lost.deps, lid);
    expect(row(lost.db)).toMatchObject({ state: 'failed', step: 'connection', changed: 'unknown' });
    expect(lost.sent).toHaveLength(4);
  });

  it('undoes with its words only, naming the rollback’s folder', async () => {
    const { db, restic, deps, sent } = setup({
      answer: () => ({ code: 0, stdout: DONE.replace('"database":false', '"database":true') }),
    });
    const id = await asked(db, restic, true);
    await runRollback(deps, id);
    db.prepare('UPDATE rollbacks SET checked_at = ?, checks_ok = 1').run(NOW);
    installed(db, 'one.test', 'plugin', AKISMET.item, AKISMET.from);
    installed(db, 'one.test', 'theme', THEME.item, THEME.from);
    const undo = requestUndo(db, 'one.test', { rollbackId: id, withDatabase: true }, 'tyler', NOW);
    if (!undo.ok) throw new Error(undo.why);
    await runRollback(deps, undo.id);
    expect(sent.at(-1)).toMatchObject({ words: `undo one.test ${id} database`, members: [] });
    expect(row(db)).toMatchObject({ kind: 'undo', state: 'done', changed: 'all' });
  });

  it('marks one a stopped backups process left running', () => {
    const db = testDb();
    site(db);
    run(db);
    db.prepare(
      `INSERT INTO rollbacks (id, kind, site_id, batch_id, host, requested_at, requested_by, with_database, state)
       VALUES ('r1', 'rollback', 'one.test', 'batch1', 'craftish', 0, 'tyler', 0, 'running')`,
    ).run();
    expect(orphaned(db, NOW)).toBe(1);
    expect(row(db)).toMatchObject({ state: 'failed', changed: 'unknown', step: 'mini' });
  });
});

describe('the pieces', () => {
  it('reads a Version header as WordPress does', () => {
    expect(headerVersion('<?php\n/**\n * Plugin Name: Akismet\n * Version: 5.3\n */')).toBe('5.3');
    expect(headerVersion('/*\nTheme Name: X\nVersion: 1.6.1 */\n')).toBe('1.6.1');
    expect(headerVersion('<?php\n/* Plugin Name: Hello\nVersion: 1.7.2 */')).toBe('1.7.2');
    expect(headerVersion('# version: 2.0 ?> trailing')).toBe('2.0');
    expect(headerVersion('no header here')).toBeNull();
  });

  it('reads the script’s lines, ignoring anything else', () => {
    expect(
      readPush(
        'noise\n{"format":1,"step":"check","ok":true}\n{"format":1,"step":"count","ok":true,"orders":null,"comments":0,"users":2}\n{bad json\n{"format":1,"ok":true,"step":"done","database":true,"warnings":[]}\n',
      ),
    ).toEqual({
      steps: ['check', 'count'],
      counts: { orders: null, comments: 0, users: 2 },
      result: { format: 1, ok: true, step: 'done', database: true, warnings: [] },
    });
  });

  it('writes the plan one fact a line', () => {
    expect(
      planText({
        id: 'abc',
        site: 's.test',
        items: [{ ...AKISMET, name: 'A', now: '2', back: '1' }],
        database: { from: 'tar' },
        since: '20261119T030000Z',
      }),
    ).toBe(
      'format 1\nid abc\nsite s.test\nitem plugin akismet/akismet.php 2 1\ndatabase tar\nsince 20261119T030000Z\n',
    );
  });
});
