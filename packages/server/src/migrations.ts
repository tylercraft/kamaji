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
    // mini against components; what's installed where never leaves it. Informational records
    // (121 of 43,741 on 2026-11-09, like core's "All Known Versions" notes) are shown, never raised.
    sql: `
      CREATE TABLE vulnerabilities (
        id TEXT NOT NULL,
        software_type TEXT NOT NULL CHECK (software_type IN ('core', 'plugin', 'theme')),
        slug TEXT NOT NULL,
        software_name TEXT,
        title TEXT NOT NULL,
        informational INTEGER NOT NULL DEFAULT 0 CHECK (informational IN (0, 1)),
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
  {
    version: 11,
    name: 'must-use plugins',
    // Craftish Care 0.2.0 reports must-use plugins (docs/protocol.md): listed only, never
    // updated, looked up or matched. SQLite can't change a CHECK, so the table is rebuilt.
    sql: `
      CREATE TABLE components_new (
        site_id TEXT NOT NULL REFERENCES sites (id),
        type TEXT NOT NULL CHECK (type IN ('core', 'plugin', 'mu-plugin', 'theme')),
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
      INSERT INTO components_new SELECT * FROM components;
      DROP TABLE components;
      ALTER TABLE components_new RENAME TO components;
    `,
  },
  {
    version: 12,
    name: 'batches',
    // Approved updates (updater/, calcifer explore/kamaji.md, "Selecting and approving a batch").
    // A batch is the approval itself, bound to its exact items; each item's id is the job id sent
    // to the plugin, stored before it's sent, so a double click or a restart can't run it twice.
    // batch_sites holds each site's run: backup evidence, baseline checks, and whether it's held.
    // sites.updating_until is the updater's own pause of a site's uptime alerts (the mini's and
    // the Worker's), renewed as it goes, so it lapses by itself if the updater dies. It's apart
    // from paused_at, which is Tyler's.
    sql: `
      ALTER TABLE sites ADD COLUMN updating_until INTEGER;

      CREATE TABLE batches (
        id TEXT PRIMARY KEY,
        approved_at INTEGER NOT NULL,
        approved_by TEXT NOT NULL,
        one_site_first INTEGER NOT NULL CHECK (one_site_first IN (0, 1)),
        state TEXT NOT NULL CHECK (state IN ('approved', 'running', 'finished')),
        finished_at INTEGER
      );

      CREATE TABLE batch_sites (
        batch_id TEXT NOT NULL REFERENCES batches (id),
        site_id TEXT NOT NULL REFERENCES sites (id),
        position INTEGER NOT NULL,
        backup_kind TEXT NOT NULL CHECK (backup_kind IN ('kamaji', 'host', 'client', 'tyler')),
        backup TEXT,
        baseline TEXT,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'running', 'done', 'held')),
        held_reason TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY (batch_id, site_id)
      );

      CREATE TABLE batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches (id),
        site_id TEXT NOT NULL REFERENCES sites (id),
        position INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('core', 'plugin', 'theme')),
        item TEXT NOT NULL,
        name TEXT NOT NULL,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'sent', 'running', 'checking', 'done', 'held')),
        outcome TEXT CHECK (outcome IN ('passed', 'checks_failed', 'update_failed', 'incomplete')),
        detail TEXT,
        sent_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX batch_items_batch ON batch_items (batch_id, site_id, position);
    `,
  },
  {
    version: 13,
    name: 'backup_evidence',
    // Backup evidence as Kamaji recorded it (backups/evidence.ts): each export Kamaji asked craftish
    // for, before a run (batch_id) or from "Back up now" (requested_by), with what the export
    // answered: its own time, size and SHA-256, never the data. A failed attempt is kept too.
    // Runs before this table have only batch_sites.backup's words.
    sql: `
      CREATE TABLE backup_evidence (
        id INTEGER PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites (id),
        batch_id TEXT REFERENCES batches (id),
        requested_by TEXT,
        recorded_at INTEGER NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        exported_at TEXT,
        bytes INTEGER,
        sha256 TEXT,
        words TEXT NOT NULL
      );
      CREATE INDEX backup_evidence_site ON backup_evidence (site_id, recorded_at);
    `,
  },
  {
    version: 14,
    name: 'whole-site backups',
    // Whole-site backups (TY-166, ops/backups-plan.md): restic snapshots of a craftish site's
    // files and database, made by the backups process (sitebackups/), off by default. A client's
    // site needs the client's agreement first, recorded with who ticked it and when; Tyler's own
    // sites (`own`) don't ask. Requests from the Backups panel wait in site_backup_requests until
    // the process takes them.
    sql: `
      ALTER TABLE sites ADD COLUMN own INTEGER NOT NULL DEFAULT 0 CHECK (own IN (0, 1));
      ALTER TABLE sites ADD COLUMN site_backup_schedule TEXT NOT NULL DEFAULT 'off'
        CHECK (site_backup_schedule IN ('off', 'weekly', 'fortnightly'));
      ALTER TABLE sites ADD COLUMN site_backup_consent_at INTEGER;
      ALTER TABLE sites ADD COLUMN site_backup_consent_by TEXT;
      CREATE TABLE site_snapshots (
        id INTEGER PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites (id),
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        snapshot_id TEXT,
        bytes INTEGER,
        added_bytes INTEGER,
        database_bytes INTEGER,
        database_sha256 TEXT,
        wordpress TEXT,
        problem TEXT,
        forgotten_at INTEGER
      );
      CREATE INDEX site_snapshots_site ON site_snapshots (site_id, started_at);
      CREATE TABLE restore_checks (
        id INTEGER PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites (id),
        snapshot_id TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        failed_step TEXT,
        problem TEXT
      );
      CREATE INDEX restore_checks_site ON restore_checks (site_id, started_at);
      CREATE TABLE site_backup_requests (
        id INTEGER PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites (id),
        kind TEXT NOT NULL CHECK (kind IN ('backup', 'restore')),
        requested_at INTEGER NOT NULL,
        requested_by TEXT NOT NULL,
        taken_at INTEGER
      );
    `,
  },
  {
    version: 15,
    name: 'own sites',
    seed: true,
    // Tyler's own sites (2026-11-13): First & Last, Yoga and both accounting sites. Their
    // whole-site backups need no client's agreement.
    sql: `
      UPDATE sites SET own = 1 WHERE id IN ('firstandlastrecords.com', 'yogarecords.com',
        'accounting.firstandlastrecords.com', 'accounting.prettyearpublishing.com');
    `,
  },
  {
    version: 16,
    name: 'server updates',
    // TY-167: each package a server's report (format 2) says can be upgraded, with when Kamaji
    // first saw that version waiting, so "waiting over a day" and "the oldest for 30 days" don't
    // depend on how many reports are kept; a new version of a package starts its own clock. The
    // reports' observations keep only counts. issues.digested_at: when the morning digest last
    // listed an issue, for the kinds it lists only now and then (notify.ts, DIGEST_REPEAT).
    sql: `
      CREATE TABLE server_updates (
        server_id TEXT NOT NULL REFERENCES servers (id),
        name TEXT NOT NULL,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        suites TEXT NOT NULL,
        security INTEGER NOT NULL CHECK (security IN (0, 1)),
        esm INTEGER NOT NULL CHECK (esm IN (0, 1)),
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, name)
      );
      ALTER TABLE issues ADD COLUMN digested_at INTEGER;
    `,
  },
  {
    version: 17,
    name: 'proposals',
    // TY-151: a batch Calcifer proposes (updates/proposals.ts). Never an approval: Updates shows
    // the latest one ticked, with its notes. queue is the fingerprint of the queue it was made
    // from, so a newer queue makes it stale. items is JSON: siteId, type, item, from, to, note.
    sql: `
      CREATE TABLE proposals (
        id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        proposed_by TEXT NOT NULL,
        queue TEXT NOT NULL,
        first_site TEXT,
        items TEXT NOT NULL
      );
    `,
  },
  {
    version: 18,
    name: 'passkeys',
    // TY-170: writes that start or change work on a site need a passkey (passkeys/). Nonces are
    // single use; counters catch a cloned authenticator. The passkeys themselves are never here:
    // they're in a root-owned file. batches.approval keeps the signed request and its proof, which
    // the updater checks again before running.
    sql: `
      CREATE TABLE passkey_nonces (
        nonce TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE passkey_counters (
        id TEXT PRIMARY KEY,
        sign_count INTEGER NOT NULL
      );
      ALTER TABLE batches ADD COLUMN approval TEXT;
    `,
  },
  {
    version: 19,
    name: 'site icons',
    // Each site's favicon, fetched by Kamaji once a day (checks/icons.ts) so the page never loads
    // anything from a client site. The bytes are a file in the data dir named by their SHA-256;
    // this row says which, and its type. checked_at moves on every try; a failed try keeps the
    // last icon and says why in problem.
    sql: `
      CREATE TABLE site_icons (
        site_id TEXT PRIMARY KEY,
        sha256 TEXT,
        content_type TEXT,
        fetched_at INTEGER,
        checked_at INTEGER NOT NULL,
        problem TEXT
      );
    `,
  },
  {
    version: 20,
    name: 'dismissed issues and restore detail',
    // Dismiss (issues.ts): who hid an issue Kamaji can't check again, and when. fingerprint is what
    // the issue is about right now (a crash group's last crash, an end-of-life line and whether its
    // date has passed); the issue comes back when it moves on from the one it was dismissed at.
    // A restore check that failed in Docker keeps the end of what the command said, scrubbed.
    sql: `
      ALTER TABLE issues ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE issues ADD COLUMN dismissed_at INTEGER;
      ALTER TABLE issues ADD COLUMN dismissed_by TEXT;
      ALTER TABLE issues ADD COLUMN dismissed_fingerprint TEXT;
      ALTER TABLE restore_checks ADD COLUMN problem_detail TEXT;
    `,
  },
  {
    version: 21,
    name: 'site platforms and domain renewals',
    // What a site is built on: WordPress, or a static site or an app, which are monitoring only by
    // design (no Craftish Care, backups or updates). Every site so far is WordPress; Tyler sets the
    // others. Each registrable domain's renewal date, read through RDAP once a day
    // (checks/domains.ts): what the last read found, and how many reads in a row have failed.
    sql: `
      ALTER TABLE sites ADD COLUMN platform TEXT NOT NULL DEFAULT 'wordpress'
        CHECK (platform IN ('wordpress', 'static', 'app'));
      CREATE TABLE domains (
        domain TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        expires_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('ok', 'no-rdap', 'no-date', 'failed')),
        problem TEXT,
        failures INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 22,
    name: 'update time and site time zones',
    // One weekly update time (sitebackups/schedule.ts), set on Settings: whole-site backups run at
    // 03:00 in each site's own time zone on the last night before it, and "Ready to update" goes
    // at it. Every site starts in NZ time; weekly and fortnightly schedules carry over as they are.
    sql: `
      ALTER TABLE sites ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Pacific/Auckland';
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );
    `,
  },
  {
    version: 23,
    name: 'whole-site backups before updates',
    // Before an update, a site with whole-site backups on whose latest good snapshot is over a day
    // old gets a fresh one instead of the database export (backups/beforeUpdate.ts). The updater
    // asks the backups process for it through site_backup_requests, naming its batch, and the
    // snapshot keeps that batch. backup_evidence says which one ran; every row so far is an export.
    sql: `
      ALTER TABLE backup_evidence ADD COLUMN kind TEXT NOT NULL DEFAULT 'export'
        CHECK (kind IN ('export', 'snapshot'));
      ALTER TABLE site_backup_requests ADD COLUMN batch_id TEXT;
      ALTER TABLE site_snapshots ADD COLUMN batch_id TEXT;
    `,
  },
  {
    version: 24,
    name: 'run messages and what’s new',
    // A finished run goes to Discord once (updates/announce.ts): announced_at is when, and a run
    // carried on after a hold is announced again for the sites it finishes. Runs that finished
    // before this count as announced. offer_seen_at is when WordPress first offered a component's
    // current update, for Updates' "new" dots; offers from before this aren't new. viewer_seen:
    // when each login last opened Overview, Sites and Updates.
    sql: `
      ALTER TABLE batches ADD COLUMN announced_at INTEGER;
      UPDATE batches SET announced_at = finished_at WHERE finished_at IS NOT NULL;
      ALTER TABLE components ADD COLUMN offer_seen_at INTEGER;
      CREATE TABLE viewer_seen (
        login TEXT NOT NULL,
        page TEXT NOT NULL CHECK (page IN ('overview', 'sites', 'updates')),
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (login, page)
      );
    `,
  },
  {
    version: 25,
    name: 'kinsta whole-site backups',
    // Whole-site backups of Kinsta sites (Tyler, 2026-11-18), pulled over SSH with the backups
    // process's own key (sitebackups/kinsta.ts). Each site's SSH host, port and user (not secret;
    // the key never leaves the mini's ~/.ssh). "Test connection" is a request the backups process
    // takes, like the panel's; it records what it found, and the sizes the 20 GB check uses. Over
    // 20 GB, the first pull waits for Tyler's okay of that size.
    sql: `
      CREATE TABLE kinsta_access (
        site_id TEXT PRIMARY KEY REFERENCES sites (id),
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        user TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        test_requested_at INTEGER,
        tested_at INTEGER,
        test_ok INTEGER CHECK (test_ok IN (0, 1)),
        test_problem TEXT,
        wordpress_path TEXT,
        wordpress TEXT,
        wp_cli TEXT,
        wp_content_bytes INTEGER,
        database_bytes INTEGER,
        size_ok_bytes INTEGER,
        size_ok_at INTEGER,
        size_ok_by TEXT
      );
    `,
  },
  {
    version: 26,
    name: 'restore check notes',
    // What a passed restore check did differently, for the site page (Tyler, 2026-11-19): the
    // major.minor WordPress image it ran on when Docker Hub didn't have the release's own yet.
    sql: `
      ALTER TABLE restore_checks ADD COLUMN note TEXT;
    `,
  },
];
