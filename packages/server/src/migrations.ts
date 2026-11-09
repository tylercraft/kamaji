// Schema migrations, applied in order at startup, each in its own transaction. Never edit one
// that has shipped: add the next number. Times are integer milliseconds since the epoch (UTC).
// Everything is kept (decided 2026-11-08), so rows are marked removed or resolved, not deleted.

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Seeds data (the estate) rather than shaping the schema; tests leave these out by default. */
  seed?: boolean;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'shell',
    sql: `
      CREATE TABLE sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        host_kind TEXT NOT NULL CHECK (host_kind IN ('craftish', 'kinsta', 'wpengine', 'other')),
        client_slug TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('connected', 'monitoring')),
        setup TEXT NOT NULL DEFAULT 'identify'
          CHECK (setup IN ('identify', 'connect', 'configure', 'done')),
        important_pages TEXT NOT NULL DEFAULT '[]',
        expected_text TEXT,
        backup_expectation TEXT CHECK (backup_expectation IN ('kamaji', 'host', 'client', 'tyler')),
        notifications TEXT NOT NULL DEFAULT 'normal' CHECK (notifications IN ('normal', 'digest')),
        paused_at INTEGER,
        removed_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('linux-ssh', 'local-mac')),
        address TEXT NOT NULL,
        removed_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('site', 'server', 'kamaji')),
        resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('urgent', 'normal')),
        summary TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        notified_at INTEGER,
        resolved_at INTEGER
      );
      -- One open issue per resource and kind: a recurring failure updates last_seen_at.
      CREATE UNIQUE INDEX issues_open ON issues (resource_type, resource_id, kind)
        WHERE resolved_at IS NULL;

      -- The activity log, newest first in the UI.
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX events_at ON events (at);

      -- Jobs: a row per unit of work, claimed with a lease so a restart picks up where it left
      -- off and nothing runs twice. A job whose lease runs out is marked interrupted, never
      -- silently retried: its kind decides what recovery means (for an update, asking the site).
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        dedupe_key TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
        run_after INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        lease_owner TEXT,
        lease_until INTEGER,
        result TEXT,
        error TEXT
      );
      -- At most one queued or running job per dedupe key.
      CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key)
        WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');
      CREATE INDEX jobs_claim ON jobs (state, run_after);
      CREATE INDEX jobs_kind ON jobs (kind, created_at);

      -- Small facts about Kamaji itself (the last heartbeat ping, and so on), as JSON.
      CREATE TABLE state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'observations',
    sql: `
      -- Every check result, kept. value is the check's JSON detail; ok is whether it passed.
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('site', 'server', 'kamaji')),
        resource_id TEXT NOT NULL,
        check_name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('mini', 'worker', 'plugin', 'ssh')),
        at INTEGER NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        value TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX observations_latest ON observations (resource_type, resource_id, check_name, source, at);

      -- Discord bookkeeping: when the reminder (24 hours on) and the recovery message went.
      ALTER TABLE issues ADD COLUMN reminded_at INTEGER;
      ALTER TABLE issues ADD COLUMN recovery_notified_at INTEGER;

      ALTER TABLE sites ADD COLUMN tailnet_only INTEGER NOT NULL DEFAULT 0 CHECK (tailnet_only IN (0, 1));
    `,
  },
  {
    version: 3,
    name: 'estate',
    seed: true,
    // The estate as of 2026-11-08 (calcifer explore/kamaji.md), all monitoring only until
    // Craftish Care (M3). Expected text was read from each home page on 2026-11-09.
    sql: `
      INSERT INTO sites (id, name, url, host_kind, client_slug, mode, setup, expected_text, tailnet_only, created_at) VALUES
        ('accounting.firstandlastrecords.com', 'F&L accounting', 'https://accounting.firstandlastrecords.com/', 'craftish', NULL, 'monitoring', 'done', 'Label Accounting', 1, unixepoch() * 1000),
        ('accounting.prettyearpublishing.com', 'Pretty Ear accounting', 'https://accounting.prettyearpublishing.com/', 'craftish', NULL, 'monitoring', 'done', 'Label Accounting', 1, unixepoch() * 1000),
        ('aleyahoerlein.com', 'Aleya Hoerlein', 'https://aleyahoerlein.com/', 'craftish', NULL, 'monitoring', 'done', 'Aleya Hoerlein', 0, unixepoch() * 1000),
        ('briardalewealth.com', 'Briardale', 'https://briardalewealth.com/', 'kinsta', 'briardale', 'monitoring', 'done', 'Briardale', 0, unixepoch() * 1000),
        ('firstandlastrecords.com', 'First & Last Records', 'https://firstandlastrecords.com/', 'craftish', NULL, 'monitoring', 'done', 'Last Records', 0, unixepoch() * 1000),
        ('mintonhomesllc.com', 'Minton Homes', 'https://mintonhomesllc.com/', 'other', 'minton-homes', 'monitoring', 'done', 'Minton Homes', 0, unixepoch() * 1000),
        ('photogravure.com', 'Photogravure', 'https://photogravure.com/', 'kinsta', 'katzman', 'monitoring', 'done', 'Photogravure', 0, unixepoch() * 1000),
        ('photoseed.com', 'PhotoSeed', 'https://photoseed.com/', 'kinsta', 'photoseed', 'monitoring', 'done', 'PhotoSeed', 0, unixepoch() * 1000),
        ('sweetleisure.com', 'Sweet Leisure', 'https://sweetleisure.com/', 'kinsta', NULL, 'monitoring', 'done', 'Sweet Leisure', 0, unixepoch() * 1000),
        ('yogarecords.com', 'Yoga Records', 'https://yogarecords.com/', 'craftish', NULL, 'monitoring', 'done', 'Yoga Records', 0, unixepoch() * 1000),
        ('www.ashburylegal.com', 'Ashbury', 'https://www.ashburylegal.com/', 'wpengine', 'ashbury', 'monitoring', 'done', 'Ashbury Legal', 0, unixepoch() * 1000),
        ('tylercraft.com', 'tylercraft.com', 'https://tylercraft.com/', 'other', NULL, 'monitoring', 'done', 'Tyler Craft', 0, unixepoch() * 1000),
        ('craftish.dev', 'craftish.dev', 'https://craftish.dev/', 'other', NULL, 'monitoring', 'done', 'Craftish', 0, unixepoch() * 1000),
        ('romaji.craftish.dev', 'Romaji', 'https://romaji.craftish.dev/', 'craftish', NULL, 'monitoring', 'done', 'Romaji', 0, unixepoch() * 1000);
    `,
  },
  {
    version: 4,
    name: 'servers',
    seed: true,
    // craftish reports over its forced-command SSH key, at its tailnet address; molcajete is read
    // locally.
    sql: `
      INSERT INTO servers (id, name, kind, address, created_at) VALUES
        ('craftish', 'craftish', 'linux-ssh', 'kamaji-report@100.77.122.31', unixepoch() * 1000),
        ('molcajete', 'molcajete', 'local-mac', 'localhost', unixepoch() * 1000);
    `,
  },
  {
    version: 5,
    name: 'crashes',
    // Calcifer's crash log, as groups (job + type + where) and their crash times. Never a
    // message or traceback (molcajete/crashes.ts).
    sql: `
      CREATE TABLE crash_groups (
        id TEXT PRIMARY KEY,
        job TEXT NOT NULL,
        type TEXT NOT NULL,
        where_at TEXT,
        line INTEGER,
        frames TEXT NOT NULL DEFAULT '[]',
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
      CREATE TABLE crashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES crash_groups (id),
        at INTEGER NOT NULL,
        pid INTEGER
      );
      CREATE INDEX crashes_group ON crashes (group_id, at);
    `,
  },
  {
    version: 6,
    name: 'done-test site, romaji on Pages',
    seed: true,
    // romaji.craftish.dev is on Cloudflare Pages, built from GitHub, like craftish.dev and
    // tylercraft.com, not on craftish (migration 3 had it wrong).
    //
    // TEMPORARY, for M2's done-test (calcifer explore/kamaji/plan.md): one static page on
    // craftish (dev.craftish.dev, behind Cloudflare), taken down and restored by hand. Any non-2xx
    // (a 404 included) or the text missing is a failed check. Remove it with a later migration
    // that sets removed_at; don't delete this one.
    sql: `
      UPDATE sites SET host_kind = 'other' WHERE id = 'romaji.craftish.dev';
      INSERT INTO sites (id, name, url, host_kind, mode, setup, expected_text, tailnet_only, created_at)
      VALUES ('kamaji-test', 'TEST: Kamaji done-test page', 'https://dev.craftish.dev/kamaji-test.html',
        'craftish', 'monitoring', 'done', 'Kamaji test page', 0, unixepoch() * 1000);
    `,
  },
  {
    version: 7,
    name: 'done-test site, tailnet only',
    seed: true,
    // TEMPORARY, M2's done-test, second pass: tailnet-only sites aren't sent to the Worker, so
    // Kamaji announces this page going down itself. Removed with the site.
    sql: `UPDATE sites SET tailnet_only = 1 WHERE id = 'kamaji-test';`,
  },
  {
    version: 8,
    name: 'done-test site removed',
    seed: true,
    // M2's done-test passed both ways (Worker, then Kamaji). Its history stays; the site goes.
    sql: `UPDATE sites SET removed_at = unixepoch() * 1000 WHERE id = 'kamaji-test' AND removed_at IS NULL;`,
  },
  {
    version: 9,
    name: 'inventory',
    // What craftish-care reports (inventory/report.ts): one row per site and component, the
    // current state. Changes go to events and every report to observations, so history is kept;
    // a component no longer reported gets gone_at rather than being deleted.
    //
    // plugin_directory is wordpress.org's answer per plugin slug (inventory/directory.ts): listed,
    // closed (a closed plugin never offers an update), or not there at all (paid or custom).
    sql: `
      CREATE TABLE components (
        site_id TEXT NOT NULL REFERENCES sites (id),
        type TEXT NOT NULL CHECK (type IN ('core', 'plugin', 'theme')),
        item TEXT NOT NULL,
        slug TEXT,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        auto_update INTEGER CHECK (auto_update IN (0, 1)),
        parent TEXT,
        offer_version TEXT,
        offer_package INTEGER CHECK (offer_package IN (0, 1)),
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        gone_at INTEGER,
        PRIMARY KEY (site_id, type, item)
      );

      CREATE TABLE plugin_directory (
        slug TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('listed', 'closed', 'not-listed')),
        latest_version TEXT,
        last_updated INTEGER,
        tested TEXT,
        closed_date TEXT,
        closed_reason TEXT,
        checked_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 10,
    name: 'vulnerabilities',
    // The Wordfence Intelligence v3 feed (wordfence/feed.ts): one row per record and affected
    // software, all of it, replaced whole on each good download, so a newly installed plugin is
    // matched on the next cycle without waiting for the next download. Matching happens on the
    // mini against components; what's installed where never leaves it.
    sql: `
      CREATE TABLE vulnerabilities (
        id TEXT NOT NULL,
        software_type TEXT NOT NULL CHECK (software_type IN ('core', 'plugin', 'theme')),
        slug TEXT NOT NULL,
        software_name TEXT,
        title TEXT NOT NULL,
        affected TEXT NOT NULL,
        patched INTEGER NOT NULL CHECK (patched IN (0, 1)),
        patched_versions TEXT NOT NULL DEFAULT '[]',
        remediation TEXT,
        cve TEXT,
        cvss_score REAL,
        cvss_rating TEXT,
        reference TEXT,
        published TEXT,
        PRIMARY KEY (id, software_type, slug)
      );
      CREATE INDEX vulnerabilities_software ON vulnerabilities (software_type, slug);
    `,
  },
];
