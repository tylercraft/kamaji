/* global AbortController, Buffer, fetch, Headers, Request, setTimeout, structuredClone, WebSocket */
// Browser smoke check, for the laptop after `npm run build`: `npm run smoke`.
//
// Serves the built app over an in-memory database (the estate's seed rows, then data from the
// repo's own fixtures: a Craftish Care report, Wordfence records, craftish's apt list, molcajete's
// captured readers), and loads every page in headless Chrome at desktop and phone widths, light
// and dark. It fails on an uncaught error, a console error, a page that renders nothing or says it
// couldn't load, a disclosure that can't take focus, or a button without a name. Nothing leaves
// the laptop: no site, server or service is asked anything.
//
// CHROME overrides the browser's path; SMOKE_SHOTS=<folder> saves a screenshot of each page.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'packages/server/src');
const DIST = join(ROOT, 'packages/server/dist');
const WEB = join(ROOT, 'packages/web/dist');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SMOKE_SHOTS;

for (const [path, what] of [
  [join(DIST, 'app.js'), 'the server build'],
  [join(WEB, 'index.html'), 'the web build'],
]) {
  if (!existsSync(path)) {
    console.error(`smoke: ${what} is missing; run npm run build first`);
    process.exit(1);
  }
}
if (!existsSync(CHROME)) {
  console.error(`smoke: no Chrome at ${CHROME}; set CHROME to its path`);
  process.exit(1);
}

const imp = (path) => import(join(DIST, path));
const { serve } = await import('@hono/node-server');
const { createApp } = await imp('app.js');
const { testDb } = await imp('testing.js');
const { recordObservation } = await imp('observations.js');
const { storeReport } = await imp('inventory/report.js');
const { checkWordfence } = await imp('wordfence/feed.js');
const { checkServers, parseReport } = await imp('checks/serverReport.js');
const { checkMolcajete } = await imp('molcajete/check.js');
const { TOOLS } = await imp('molcajete/read.js');
const { queue } = await imp('updates/queue.js');
const { proposeBatch } = await imp('updates/proposals.js');
const { loadPasskeys } = await imp('passkeys/store.js');
const { CareReport } = await import('@kamaji/shared');

const fixture = (path) => readFileSync(join(SRC, path), 'utf8');
const now = Date.now();
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const db = testDb({ seed: true });

// Sites: one connected and healthy, one connected with a problem of each kind.
const OK = 'aleyahoerlein.com';
const BAD = 'firstandlastrecords.com';
db.exec(`UPDATE sites SET mode = 'connected', backup_expectation = 'kamaji',
  site_backup_schedule = 'weekly', site_backup_consent_at = ${now - 2 * DAY},
  site_backup_consent_by = 'smoke@localhost' WHERE id = '${OK}';
  UPDATE sites SET mode = 'connected', backup_expectation = 'kamaji', own = 1,
  site_backup_schedule = 'weekly' WHERE id = '${BAD}';
  UPDATE sites SET backup_expectation = 'host' WHERE id = 'photogravure.com';
  UPDATE sites SET paused_at = ${now - DAY} WHERE id = 'sweetleisure.com';`);
const obs = (id, source, ago, ok, value, check = 'http') =>
  recordObservation(db, {
    resourceType: 'site',
    resourceId: id,
    check,
    source,
    at: now - ago,
    ok,
    value,
  });
for (const id of [OK, 'photogravure.com', 'mintonhomesllc.com']) {
  obs(id, 'mini', 2 * MIN, true, { responseMs: 240, problem: null });
  obs(id, 'worker', 3 * MIN, true, { problem: null });
  obs(
    id,
    'mini',
    10 * MIN,
    true,
    { validTo: now + 60 * DAY, daysLeft: 60, problem: null },
    'certificate',
  );
}
obs('briardalewealth.com', 'mini', 3 * H, true, { responseMs: 410, problem: null });
obs(BAD, 'mini', MIN, false, { responseMs: null, problem: 'No answer within 20 seconds' });
obs(BAD, 'worker', 2 * MIN, true, { problem: null });
obs(
  BAD,
  'mini',
  5 * MIN,
  false,
  { validTo: null, daysLeft: null, problem: 'No answer within 20 seconds' },
  'certificate',
);
const hello = {
  plugin: '0.2.2',
  protocol: 1,
  wordpress: '7.1.4',
  php: '8.3.6',
  multisite: false,
  capabilities: {
    can_report: true,
    can_update: true,
    update_blockers: [],
    auto_updates: { all_disabled: true, plugins: false, themes: false },
    maintenance: { present: false, age_seconds: null },
    wp_cron_disabled: true,
    loopback: { ok: true },
  },
};
for (const [id, loopback] of [
  [OK, true],
  [BAD, false],
])
  obs(
    id,
    'plugin',
    2 * DAY,
    true,
    {
      ok: true,
      hello: { ...hello, capabilities: { ...hello.capabilities, loopback: { ok: loopback } } },
    },
    'hello',
  );

// Inventories: the captured report, and on the problem site a plugin with known vulnerabilities
// whose offered update fixes only some (wordfence/fixtures: wpvivid, fixed in 0.9.138).
const base = CareReport.parse(JSON.parse(fixture('inventory/fixtures/care-report.json')));
const reportOf = (r) => ({
  ok: true,
  refreshed: true,
  locale: 'en_US',
  php: r.php,
  database: r.database.server,
  checkedAt: r.checked_at,
  siteHealth: r.site_health,
  muPlugins: false,
  counts: { plugins: r.plugins.length, themes: r.themes.length, offers: 1 },
});
storeReport(db, { id: OK, name: 'Aleya Hoerlein' }, base, now - 20 * MIN);
obs(OK, 'plugin', 20 * MIN, true, reportOf(base), 'report');
const bad = structuredClone(base);
bad.plugins.push({
  file: 'wpvivid-backuprestore/wpvivid-backuprestore.php',
  slug: 'wpvivid-backuprestore',
  name: 'WPvivid',
  version: '0.9.137',
  active: true,
  auto_update: false,
  offer: { version: '0.9.138', package: true },
});
storeReport(db, { id: BAD, name: 'First & Last Records' }, bad, now - 5 * H);
obs(BAD, 'plugin', 5 * H, true, reportOf(bad), 'report');
await checkWordfence(db, {
  apiKey: undefined,
  feedPath: '',
  localFile: join(SRC, 'wordfence/fixtures/feed.json'),
  now: () => now,
  signal: new AbortController().signal,
});

// Backups: exports, snapshots and restore checks, good on one site and failing on the other.
const snap =
  db.prepare(`INSERT INTO site_snapshots (site_id, started_at, finished_at, ok, snapshot_id,
  bytes, added_bytes, database_bytes, wordpress, problem, forgotten_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
snap.run(
  OK,
  now - DAY,
  now - DAY + 95_000,
  1,
  'c'.repeat(64),
  184e6,
  1.9e6,
  9.3e6,
  '7.1.4',
  null,
  null,
);
snap.run(
  BAD,
  now - 12 * DAY,
  now - 12 * DAY + 70_000,
  1,
  'e'.repeat(64),
  90e6,
  1e6,
  4e6,
  '7.1.3',
  null,
  null,
);
snap.run(
  BAD,
  now - 2 * DAY,
  now - 2 * DAY + 5000,
  0,
  null,
  null,
  null,
  null,
  null,
  'craftish: tar exited 2',
  null,
);
const restore =
  db.prepare(`INSERT INTO restore_checks (site_id, snapshot_id, started_at, finished_at, ok,
  failed_step, problem) VALUES (?,?,?,?,?,?,?)`);
restore.run(OK, 'c'.repeat(64), now - 50 * DAY, now - 50 * DAY + 90_000, 1, null, null);
restore.run(
  BAD,
  'e'.repeat(64),
  now - 3 * DAY,
  now - 3 * DAY + 80_000,
  0,
  'wordpress',
  'WordPress didn’t start within 60 s',
);
const evidence = db.prepare(`INSERT INTO backup_evidence (site_id, requested_by, recorded_at, ok,
  exported_at, bytes, sha256, words) VALUES (?, 'smoke@localhost', ?, ?, ?, ?, ?, ?)`);
evidence.run(
  OK,
  now - H,
  1,
  '20261113T004147Z',
  2.4e6,
  'd'.repeat(64),
  'Kamaji exported the database on craftish',
);
evidence.run(BAD, now - 2 * H, 0, null, null, null, 'kamaji-db-export exited 1');

// Runs: a finished three-site run, an older partly failed one, and one held now.
const batch = db.prepare(
  'INSERT INTO batches (id, approved_at, approved_by, one_site_first, state, finished_at) VALUES (?,?,?,?,?,?)',
);
const bsite = db.prepare(
  'INSERT INTO batch_sites (batch_id, site_id, position, backup_kind, backup, state, held_reason, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?)',
);
const bitem = db.prepare(
  'INSERT INTO batch_items (id, batch_id, site_id, position, type, item, name, from_version, to_version, state, outcome, detail, sent_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
);
batch.run('recent', now - 4 * H, 'smoke@localhost', 1, 'finished', now - 4 * H + 600_000);
['mintonhomesllc.com', 'photogravure.com', OK].forEach((id, i) => {
  bsite.run(
    'recent',
    id,
    i,
    ['tyler', 'host', 'kamaji'][i],
    'Recorded for the run',
    'done',
    null,
    now - 4 * H,
    now - 4 * H + 100_000,
  );
  bitem.run(
    `r${i}`,
    'recent',
    id,
    0,
    'plugin',
    'craftish-care/craftish-care.php',
    'Craftish Care',
    '0.2.1',
    '0.2.2',
    'done',
    'passed',
    null,
    now - 4 * H,
    now - 4 * H,
  );
});
batch.run('earlier', now - 5 * H, 'smoke@localhost', 0, 'finished', now - 5 * H + 400_000);
bsite.run(
  'earlier',
  'mintonhomesllc.com',
  0,
  'tyler',
  'Tyler confirmed a backup',
  'done',
  null,
  now - 5 * H,
  now - 5 * H + 380_000,
);
bitem.run(
  'e0',
  'earlier',
  'mintonhomesllc.com',
  0,
  'plugin',
  'mainwp-child/mainwp-child.php',
  'MainWP Child',
  '6.4.1',
  '6.4.2',
  'done',
  'passed',
  null,
  now - 5 * H,
  now - 5 * H,
);
bitem.run(
  'e1',
  'earlier',
  'mintonhomesllc.com',
  1,
  'plugin',
  'forms/forms.php',
  'Forms',
  '2.0.3',
  '2.1.0',
  'done',
  'checks_failed',
  'The home page answered 500 after the update',
  now - 5 * H,
  now - 5 * H,
);
batch.run('held', now - 10 * MIN, 'smoke@localhost', 0, 'running', null);
bsite.run(
  'held',
  BAD,
  0,
  'kamaji',
  'Database exported on craftish',
  'held',
  'The home page didn’t answer after the update',
  now - 9 * MIN,
  null,
);
bitem.run(
  'h0',
  'held',
  BAD,
  0,
  'plugin',
  'akismet/akismet.php',
  'Akismet',
  '5.3',
  '5.7.2',
  'held',
  null,
  'Updated; the home page check then timed out',
  now - 9 * MIN,
  null,
);
const issue = db.prepare(
  "INSERT INTO issues (id, resource_type, resource_id, kind, severity, summary, first_seen_at, last_seen_at) VALUES (?, 'site', ?, ?, ?, ?, ?, ?)",
);
issue.run(
  'i1',
  'mintonhomesllc.com',
  'eol-database',
  'normal',
  'Minton Homes runs MySQL 5.7, past end of support',
  now - 2 * DAY,
  now - MIN,
);
issue.run(
  'i2',
  BAD,
  'backup-failed',
  'urgent',
  'First & Last Records’ whole-site backup failed',
  now - 2 * DAY,
  now - MIN,
);
db.prepare(
  "INSERT INTO events (at, kind, summary, resource_type, resource_id) VALUES (?, 'site.backup', ?, 'site', ?)",
).run(now - DAY, 'Aleya Hoerlein backed up: 184 MB, 1.9 MB new', OK);

// craftish: its report fixture with the captured apt list, read through the script's own parsing.
{
  const script = readFileSync(join(ROOT, 'server-report/kamaji-report'), 'utf8');
  const fn = (n) => new RegExp(`^${n}\\(\\) \\{[\\s\\S]*?^\\}\\n`, 'm').exec(script)[0];
  const block = script.slice(
    script.indexOf('# BEGIN upgradable'),
    script.indexOf('# END upgradable'),
  );
  const upgradable = JSON.parse(
    execFileSync(
      '/bin/bash',
      ['-c', `${fn('js')}${fn('lines')}${block}\nprintf '{%s}' "$(upgradable_json)"`],
      {
        input: fixture('checks/fixtures/apt-upgradable.craftish.txt'),
        encoding: 'utf8',
      },
    ),
  );
  const report = {
    ...parseReport(fixture('checks/fixtures/kamaji-report.ubuntu-container.json')).report,
    format: 2,
    ...upgradable,
    rebootRequired: false,
    rebootPackages: [],
    rebootRequiredSince: null,
  };
  for (const at of [now - 2 * DAY, now - 4 * MIN])
    await checkServers(db, {
      now: () => at,
      signal: new AbortController().signal,
      keyPath: '/nonexistent',
      knownHostsPath: '/nonexistent',
      read: async () => ({ ok: true, report }),
    });
}

// molcajete: its readers answered from the captured fixtures, as its tests do.
{
  const f = (name) => fixture(`molcajete/fixtures/${name}`);
  const out = (stdout, code = 0) => Promise.resolve({ code, stdout, stderr: '' });
  const exec = (file, args) => {
    if (file === TOOLS.launchctl && args[0] === 'list') return out(f('launchctl-list.txt'));
    if (file === TOOLS.launchctl && args[0] === 'print') return out(f('launchctl-print-today.txt'));
    if (file === TOOLS.mount) return out(f('mount.txt'));
    if (file === TOOLS.diskutil) {
      const name =
        String(args[2]) === '/' ? 'root' : String(args[2]).split('/').pop().toLowerCase();
      return out(f(`diskutil-${name}.plist`));
    }
    if (file === TOOLS.softwareupdate) return out(f('softwareupdate-list.txt'));
    if (file === TOOLS.docker && args[0] === 'version') return out(f('docker-version.json'));
    if (file === TOOLS.docker && args[0] === 'ps') return out(f('docker-ps.jsonl'));
    if (file === TOOLS.tailscale) return out(f('tailscale-status.json'));
    if (file === TOOLS.sysctl) return out(f('boottime.txt'));
    return out('', 1);
  };
  const fs = {
    exists: () => true,
    agentLabels: () => [],
    tail: (path) => (path.endsWith('repo-pull.log') ? f('repo-pull.log') : null),
  };
  await checkMolcajete(db, {
    now: () => now,
    signal: new AbortController().signal,
    exec,
    fs,
    crashFiles: { path: join(mkdtempSync(join(tmpdir(), 'kamaji-smoke-')), 'crashes.jsonl') },
    repoPullLog: '/logs/calcifer-repo-pull.log',
  });
}

// The app, on a free port, with the one login it allows.
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const LOGIN = 'smoke@localhost';
// Passkeys: a file of the smoke's own, filled from the Passkeys page by Chrome's virtual
// authenticator. A passkey can't belong to an IP address, so that part runs on localhost.
const passkeyFile = join(mkdtempSync(join(tmpdir(), 'kamaji-smoke-passkeys-')), 'passkeys');
writeFileSync(passkeyFile, '');
const passkeys = {
  load: () => loadPasskeys(passkeyFile, { trustOwner: true }),
  rpId: 'localhost',
  origin: '',
};
const app = createApp({
  db,
  login: LOGIN,
  webDist: WEB,
  workerOn: true,
  passkeys,
  statusInput: () => ({
    version: 'smoke',
    commit: null,
    startedAt: now,
    now: Date.now(),
    cycleSeconds: 300,
    heartbeatConfigured: false,
    alertsConfigured: false,
  }),
});
const appPort = await freePort();
passkeys.origin = `http://localhost:${appPort}`;
const server = serve({
  fetch: (req) =>
    app.fetch(
      new Request(req, { headers: new Headers([...req.headers, ['tailscale-user-login', LOGIN]]) }),
    ),
  port: appPort,
  hostname: '127.0.0.1',
});

// Chrome, driven over its debugging protocol.
const cdpPort = await freePort();
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--hide-scrollbars',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kamaji-smoke-chrome-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let target;
for (let i = 0; i < 50 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch(`http://127.0.0.1:${cdpPort}/json`)
    .then((r) => r.json())
    .then((ts) => ts.find((t) => t.type === 'page'))
    .catch(() => undefined);
}
if (!target) {
  console.error('smoke: Chrome didn’t start');
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
let problems = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown')
    problems.push(
      `uncaught: ${m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails.text}`,
    );
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    problems.push(
      `console: ${m.params.args
        .map((a) => a.value ?? a.description)
        .join(' ')
        .slice(0, 200)}`,
    );
  pending.get(m.id)?.(m);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++seq, resolve);
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result?.value;
await send('Runtime.enable');

const PAGES = [
  '/',
  '/sites',
  `/sites/${OK}`,
  `/sites/${BAD}`,
  '/sites/photogravure.com',
  '/updates',
  '/servers',
  '/activity',
  '/rules',
  '/sites/new',
  '/passkeys',
];
const VIEWS = [
  { name: 'desktop', width: 1300, mobile: false, scheme: 'light' },
  { name: 'phone', width: 390, mobile: true, scheme: 'light' },
  { name: 'desktop-dark', width: 1300, mobile: false, scheme: 'dark' },
];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const failures = [];
for (const view of VIEWS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: view.width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: view.mobile,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: view.scheme }],
  });
  for (const path of PAGES) {
    problems = [];
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}${path}` });
    // Long enough for every resource on the page to load once.
    await new Promise((r) => setTimeout(r, 1500));
    const state = JSON.parse(
      await evaluate(`JSON.stringify({
      text: (document.querySelector('main') ?? document.body).innerText.length,
      failed: /Couldn’t load/.test(document.body.innerText),
      loading: /^Loading /m.test(document.body.innerText),
      unfocusable: [...document.querySelectorAll('summary')].filter((s) => s.tabIndex < 0).length,
      unnamed: [...document.querySelectorAll('button, a[href], input, select')]
        .filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || el.labels?.length || el.title || el.placeholder)).length,
      wide: document.documentElement.scrollWidth > window.innerWidth + 1,
    })`),
    );
    if (state.text < 40) problems.push('rendered almost nothing');
    if (state.failed) problems.push('says it couldn’t load');
    if (state.loading) problems.push('still loading after 1.5 s');
    if (state.unfocusable) problems.push(`${state.unfocusable} disclosures can’t take focus`);
    if (state.unnamed) problems.push(`${state.unnamed} controls have no name`);
    if (state.wide) problems.push('scrolls sideways');
    if (SHOTS) {
      const height = Math.min(8000, await evaluate('document.documentElement.scrollHeight'));
      await send('Emulation.setDeviceMetricsOverride', {
        width: view.width,
        height,
        deviceScaleFactor: 1,
        mobile: view.mobile,
      });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(
        join(SHOTS, `${view.name}${path.replace(/[/.]/g, '-')}.png`),
        Buffer.from(shot.result.data, 'base64'),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: view.width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: view.mobile,
      });
    }
    const label = `${view.name} ${path}`;
    if (problems.length) failures.push(`${label}: ${problems.join('; ')}`);
    else console.log(`ok   ${label}`);
  }
}
// Keyboard: a disclosure opens with Enter; Review selected updates is disabled until something is
// selected, opens the review with Enter, and starts nothing.
{
  problems = [];
  const key = async (k, code) => {
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: k,
        code,
        windowsVirtualKeyCode: { Enter: 13, ' ': 32 }[k],
        // The character is what makes Chrome activate the focused control, as a real key does.
        ...(type === 'keyDown' ? { text: { Enter: '\r', ' ': ' ' }[k] } : {}),
      });
  };
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1300,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/sites/${BAD}` });
  await new Promise((r) => setTimeout(r, 1500));
  await evaluate(`document.querySelector('#configure summary').focus()`);
  await key('Enter', 'Enter');
  await new Promise((r) => setTimeout(r, 200));
  if (!(await evaluate(`document.getElementById('configure').open`)))
    problems.push('Enter didn’t open Configure');

  const runs = () => Number(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n);
  const runsBefore = runs();
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/updates` });
  await new Promise((r) => setTimeout(r, 1500));
  const review = `[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Review selected updates'))`;
  if (!(await evaluate(`${review}?.disabled`)))
    problems.push('Review selected updates isn’t disabled before a selection');
  await evaluate(`document.querySelector('input[type=checkbox]').focus()`);
  await key(' ', 'Space');
  await new Promise((r) => setTimeout(r, 200));
  if (await evaluate(`${review}?.disabled`))
    problems.push('a selection didn’t enable Review selected updates');
  await evaluate(`${review}.focus()`);
  await key('Enter', 'Enter');
  await new Promise((r) => setTimeout(r, 300));
  if (
    !(await evaluate(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('Approve and run'))`,
    ))
  )
    problems.push('Enter on Review selected updates didn’t open the review');
  const runsAfter = runs();
  if (runsAfter !== runsBefore) problems.push('reviewing started a run');
  // Sections remember being left open or closed, across sites; Remove always starts closed.
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/sites/${BAD}` });
  await new Promise((r) => setTimeout(r, 1500));
  await evaluate(`document.querySelector('#checks summary').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/sites/${OK}` });
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await evaluate(`document.getElementById('checks').open`)))
    problems.push('Check details didn’t stay open on another site');
  await evaluate(`document.querySelector('#checks summary').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 1500));
  if (await evaluate(`document.getElementById('checks').open`))
    problems.push('Check details didn’t stay closed after a reload');
  if (
    await evaluate(
      `[...document.querySelectorAll('summary')].find((s) => s.textContent.includes('Remove site'))?.parentElement.open`,
    )
  )
    problems.push('Remove site started open');
  if (problems.length) failures.push(`keyboard: ${problems.join('; ')}`);
  else console.log('ok   keyboard: disclosures, review without approving, remembered sections');
}
// A proposed batch (prepare_batch) arrives ticked with its notes, and starts nothing.
{
  problems = [];
  const runsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n);
  const items = queue(db)
    .items.slice(0, 2)
    .map(({ siteId, type, item, from, to }) => ({
      siteId,
      type,
      item,
      from,
      to,
      note: 'Smoke note',
    }));
  const proposed = proposeBatch(
    db,
    { items, firstSite: items[0].siteId, by: 'Calcifer' },
    Date.now(),
  );
  if (!proposed.ok) problems.push(`the proposal was refused: ${proposed.problems.join('; ')}`);
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/updates` });
  await new Promise((r) => setTimeout(r, 1500));
  const ticked = await evaluate(`document.querySelectorAll('input[type=checkbox]:checked').length`);
  if (SHOTS) {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    writeFileSync(join(SHOTS, 'proposal.png'), Buffer.from(shot.result.data, 'base64'));
  }
  if (ticked !== items.length) problems.push(`${ticked} boxes ticked, not ${items.length}`);
  const text = await evaluate('document.body.innerText');
  if (!text.includes('Calcifer proposed 2 updates')) problems.push('no line about the proposal');
  if (!text.includes('Calcifer: Smoke note')) problems.push('the notes don’t show');
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n) !== runsBefore)
    problems.push('a proposal started a run');
  if (problems.length) failures.push(`proposal: ${problems.join('; ')}`);
  else console.log('ok   proposal: ticked with its notes, nothing started');
}

// Passkeys, in Chrome's virtual authenticator (Touch ID that always says yes): make one on the
// Passkeys page, install its line, then a write that needs one ("I've looked, carry on") asks for
// it, signs, and goes through. Before the line is installed, the same write is refused.
{
  problems = [];
  const at = `http://localhost:${appPort}`;
  await send('WebAuthn.enable');
  await send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click() ?? 'missing'`,
    );
  const held = () =>
    String(db.prepare("SELECT state FROM batch_sites WHERE state = 'held' LIMIT 1").get()?.state);
  const spent = () =>
    Number(
      db.prepare('SELECT COUNT(*) AS n FROM passkey_nonces WHERE used_at IS NOT NULL').get().n,
    );

  // Before any passkey is installed: refused, with words, and nothing carried on.
  await send('Page.navigate', { url: `${at}/updates` });
  await wait(1500);
  await click('I’ve looked, carry on');
  await wait(1500);
  if (held() !== 'held') problems.push('carried on without a passkey installed');
  if (!(await evaluate('document.body.innerText')).includes('no passkeys set up'))
    problems.push('no words for a write waiting on passkeys');

  await send('Page.navigate', { url: `${at}/passkeys` });
  await wait(1500);
  await evaluate(`(() => {
    const input = document.getElementById('passkey-label');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Smoke');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);
  await click('Create a passkey on this device');
  await wait(1500);
  const tee = await evaluate(
    `[...document.querySelectorAll('pre code')].map((c) => c.textContent).find((t) => t.includes('tee -a'))`,
  );
  const line = /^echo '(.+)' \| /.exec(tee ?? '')?.[1];
  if (!line) problems.push('the Passkeys page didn’t give a line to install');
  else {
    writeFileSync(passkeyFile, `${line}\n`);
    await send('Page.reload');
    await wait(1500);
    if (!(await evaluate('document.body.innerText')).includes('Smoke'))
      problems.push('the installed passkey isn’t listed');
    const before = spent();
    await send('Page.navigate', { url: `${at}/updates` });
    await wait(1500);
    await click('I’ve looked, carry on');
    await wait(2000);
    if (spent() !== before + 1) problems.push('the write wasn’t signed with the passkey');
    if (held() === 'held') problems.push('carry on didn’t go through with the passkey');
  }
  if (problems.length) failures.push(`passkeys: ${problems.join('; ')}`);
  else console.log('ok   passkeys: made on the page, refused before install, signed after');
}

ws.close();
chrome.kill();
server.close();
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`smoke: ${PAGES.length * VIEWS.length} page loads, no problems`);
process.exit(0);
