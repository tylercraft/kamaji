// Schema migrations, applied in order at startup, each in its own transaction. Never edit one
// that has shipped: add the next number. Times are integer milliseconds since the epoch (UTC).
// Everything is kept (decided 2026-11-08), so rows are marked removed or resolved, not deleted.

export interface Migration {
  version: number;
  name: string;
  sql: string;
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
];
