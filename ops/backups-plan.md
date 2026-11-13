# Backups plan (TY-166)

How Kamaji backs up WordPress sites on craftish. Decided with Tyler on 2026-11-13; calcifer `explore/kamaji.md`, "Backups (TY-166)", is the product side. Only for sites on craftish: Kinsta and WP Engine keep their own backups, and Minton has no SSH.

## Settled (Tyler, 2026-11-13)

1. **The repository is on the mini's internal disk,** `/Users/tylercraft/kamaji-backups/restic` (mode 700), not Respaldo. launchd jobs can read home, so restic runs natively: no Docker and no compiled wrapper to reach it.
2. **Consent lives in Kamaji only.** Turning whole-site backups on for a client's site under Configure needs a tick that the client agreed. Kamaji records who ticked it and when. Tyler's own sites (First & Last, Yoga, both accounting sites) don't ask; a site's Configure says whether it's Tyler's own.
3. **Arq takes the repository off-site** as ciphertext, until `restic copy` to S3 comes with the Arq replacement. One of Tyler's steps checks that Arq's plan covers `/Users/tylercraft/kamaji-backups`.

## craftish

- **A new user, `kamaji-pull`,** not `kamaji-backup`. `kamaji-backup` can make an export but can't read one, and that's worth keeping. `kamaji-pull` can read, and only through its two forced commands. It's a system user with no password, like `kamaji-backup`, whose shell is there only for sshd to run the forced commands.
- **Two keys, two forced commands,** each `restrict`ed and accepted only `from="100.106.213.63"` (molcajete). Scripts and their README are in `server-pull/`.
  - **The app's download key** → `kamaji-fetch-export`, with `<site> <time>`. It streams one existing export, `/var/backups/kamaji/<site>/<time>.sql.gz`, and nothing else. The site must be a plain domain on `/etc/kamaji/db-export.sites`, and the time must match db-export's `^[0-9]{8}T[0-9]{6}Z$`. It runs as `www-data` through one sudo rule. Paths are never accepted.
  - **The backup process's key** → `kamaji-site-pull`, with `<site>`. The site must be on a new list, `/etc/kamaji/site-pull.sites`. It's separate from the export list on purpose: a site can have exports before updates without whole-site pulls. As `www-data` (one sudo rule), it writes one tar to stdout:
    - `wp-content/`, without `cache/`, `upgrade/`, `ai1wm-backups/`, `updraft/`, `backups*/` or `*.log`;
    - `.htaccess`, if there is one;
    - `database.sql`: a fresh `wp db export --single-transaction`, uncompressed so restic can deduplicate it, written to a www-data-only temp folder and deleted after;
    - `manifest.json`, written last: the format, site, time, WordPress version, table prefix, the names (never the values) of wp-config's constants, and `database.sql`'s bytes and SHA-256.
- **What it reads:** `/var/www/<site>/public/wp-content`, `.htaccess`, the database through wp-cli, and the exports folder. Never `wp-config.php`, core files or another site.
- **Leaving out wp-config.php:** that keeps the database password, the salts and any keys in constants out of the backup. A restore writes a new wp-config: the manifest's table prefix plus fresh salts. Logging everyone out is the only cost, and the constants' names show what to put back. The database still holds what plugins keep in options, API keys included. That's unavoidable, and it's why the repository is encrypted.
- `tar --sort=name`, so an unchanged site gives an almost identical stream and restic stores almost nothing new. A file that changes while it's read is a warning, not a failure: a live site's uploads can.

## How files travel

**tar over SSH, straight into restic:** `restic backup --stdin-from-command --stdin-filename <site>.tar -- /usr/bin/ssh … kamaji-pull@craftish <site>`. If ssh or the pull exits non-zero, restic makes no snapshot (restic's docs). Nothing is written on the mini outside the repository.

After each snapshot, the process reads it back (`restic dump`) through a tar reader that checks the stream ended properly, that `manifest.json` came last and names the site, and that `database.sql` matches the manifest's SHA-256. A snapshot that fails this is forgotten straight away, and the failure is recorded with the reason.

rsync through `rrsync -ro` would send only changed files, but it means a plain copy of every client's files on the mini. With weekly runs and a few sites, sending the whole site each time is fine.

## The download

The **Download** link on a site's Backups panel, for the latest export (Tyler's login only, like every request):

1. The app looks up the latest `exported` row in `backup_evidence`.
2. It runs `ssh … kamaji-pull@craftish <site> <exported_at>` with the download key.
3. It streams the result to the browser as `<site>-<time>.sql.gz`, computing the SHA-256 as it goes. A mismatch with the evidence is logged.

- **Where the file lives:** only on craftish, under the export's own retention (14 days, always the newest 3). Nothing is stored on the mini, and the copy that lands in the laptop's Downloads is Tyler's to delete. If craftish has pruned it, the answer says so.
- The download key is the app's, `~/.ssh/kamaji-fetch` (`KAMAJI_FETCH_SSH_KEY` overrides the path). The app never holds the pull key or the restic password.

## restic

- **One repository** at `/Users/tylercraft/kamaji-backups/restic`, made with `--repository-version 2` (compressed), with snapshots tagged `site:<id>`. One repository lets WordPress and plugin files deduplicate across sites. `restic copy --tag site:<id>` can still split it per client in S3 later.
- **restic from Homebrew** (`/opt/homebrew/bin/restic`, 0.17 or newer for `--stdin-from-command`). `KAMAJI_RESTIC` overrides the path.
- **Retention:** after each site's snapshot, `restic forget --tag site:<id> --group-by tags --keep-weekly 4 --keep-monthly 6`. `restic prune` runs on Sundays, and `restic check --read-data-subset 5%` on the 1st of the month.
- **The password:** `RESTIC_PASSWORD` in a new Doppler config, **`backup`**, not `checker`, so the app never has it. It's scoped to `~/.kamaji-backups` like the updater's to `~/.kamaji-updater`. It's made with `openssl rand` piped straight into `doppler secrets set … > /dev/null`, and never printed, logged or put on a command line. restic reads it from the environment.
- **Losing the password loses every backup.** Tyler keeps a copy in his password manager.
- The parsers follow restic's documented JSON (`restic.readthedocs.io`, "Scripting"); the fixtures in `packages/server/src/sitebackups/fixtures/` were written from those docs. One of Tyler's steps captures real ones on the mini to replace them.

## The process and the schedule

- **A third process,** `dev.craftish.kamaji-backups` (`packages/server/src/sitebackups/main.ts`), the same shape as the updater. It runs under Doppler's `backup` config, holds the pull key and the password, takes its own lock in `kamaji.db`, does its work, writes what happened to `kamaji.db`, and exits.
- **Nightly at 03:15** (StartCalendarInterval, the mini's NZ time), in this order:
  1. requests from the Backups panel;
  2. each site whose last good snapshot is older than its setting (weekly: 6½ days; fortnightly: 13½), one at a time;
  3. at most one restore check: the site whose last check is oldest, if that's more than 30 days ago;
  4. `prune` on Sundays, `check` on the 1st;
  5. the repository's size, for the panel.
- **On demand:** "Back up site now" and "Check restore now" on the Backups panel queue a request, and the app kickstarts the agent, as it does the updater.
- **Configure → Backups** gets "Whole-site backups: off / weekly / fortnightly", off by default, shown only on craftish sites, with the client-agreed tick on client sites. A site also has to be on craftish's `site-pull.sites`; until it is, a pull fails with "not on the allowlist".
- A failed pull or restore check is an event in Activity, with the reason.

## The restore check ("restore to a test copy")

On the mini:

1. `restic restore` the site's latest snapshot into a temporary folder under `~/kamaji-restore`, mode 700: outside `~/kamaji-backups`, so Arq never copies a test copy's plain files.
2. Unpack it and check `database.sql` against the manifest.
3. In Docker Desktop, which the mini already runs, start a throwaway MariaDB and the `wordpress` image matching the manifest's version. Both go on an `--internal` network with no internet, so the copy can't send email, call payment APIs or run cron against the world.
4. Import `database.sql`, and start WordPress with the restored `wp-content`, the manifest's table prefix, fresh salts, `WP_HOME` set to the test address and `DISABLE_WP_CRON`.
5. Fetch the home page inside the network. It passes on a 200 containing the site's expected text, from its own home page check.
6. Record pass or fail, the step that failed, and how long it took. explore: "restores are the product", and timed.
7. Remove the containers, the network and the folder, pass or fail.

Steps 1 and 2 need only restic. If Docker isn't answering, the check records "restored and checked; the test copy couldn't start" and counts as failed.

## What Kamaji records and shows

- **Migration 14:**
  - on `sites`: `own` (Tyler's own: seeded for the four), `site_backup_schedule` (off, weekly, fortnightly), and `site_backup_consent_at` / `site_backup_consent_by`;
  - `site_snapshots`: site, restic snapshot id, time, the tar's bytes, the data restic added, the database's bytes and SHA-256, and ok or the reason it failed;
  - `restore_checks`: site, snapshot id, time, result, the step that failed, seconds taken;
  - `site_backup_requests`: the panel's requests, until the process takes them.
  - Consent given and withdrawn are also events, so the record outlives a later change.
- **The Backups panel adds:**
  - "Download latest export";
  - Whole-site backups: the schedule and consent, the last good snapshot and when the next is due, the snapshot list (time, size, what was new);
  - the repository's total size;
  - the last restore check and how long it took;
  - "Back up site now" and "Check restore now".

## Tyler's steps

Full commands, with checks between them, are in `ops/README.md`, "Whole-site backups" (34 numbered steps). These are the steps in short, in order, each marked mini, craftish, Doppler, Arq or Kamaji.

1. [mini] Install restic: `brew install restic`, then check `restic version` is 0.17 or newer.
2. [mini] Make the folders: `/Users/tylercraft/kamaji-backups` and `/Users/tylercraft/kamaji-restore`, mode 700.
3. [Doppler] Add a config `backup` to project `kamaji`, beside `updater`.
4. [Doppler] Create `RESTIC_PASSWORD` in `backup` from `openssl rand`, piped straight in, never printed (on the laptop).
5. [Doppler] Copy the password from the dashboard into your password manager.
6. [Doppler] Make a read-only service token for `kamaji` → `backup`.
7. [mini] Scope that token to `/Users/tylercraft/.kamaji-backups`, pasted at a silent prompt.
8. [mini] Initialise the repository, under Doppler's `backup` scope.
9. [Arq] Check the backup plan covers `/Users/tylercraft/kamaji-backups`, and add it if not; `kamaji-restore` stays out.
10. [mini] Make the pull key, `~/.ssh/kamaji-pull` (no passphrase).
11. [mini] Make the download key, `~/.ssh/kamaji-fetch` (no passphrase).
12. [mini] Show both public keys, to paste on craftish.
13. [craftish] Add the `kamaji-pull` system user, with no password and no shell.
14. [craftish] Install the four `server-pull/` scripts, owned by root (scp'd up from the laptop).
15. [craftish] Add the sudo rule (`kamaji-pull` → the two helpers as `www-data`, nothing else), checked with `visudo -c`.
16. [craftish] Put the two `authorized_keys` lines for `kamaji-pull` in place.
17. [craftish] Create `/etc/kamaji/site-pull.sites` with `aleyahoerlein.com`.
18. [mini] Check each key is refused anything else (expect "not a site name", not `uid=`).
19. [mini] Deploy Kamaji (`ops/deploy.sh`): migration 14 runs.
20. [mini] Install and load the `dev.craftish.kamaji-backups` LaunchAgent.
21. [Kamaji] Configure → aleyahoerlein.com → Whole-site backups: weekly, the client-agreed tick, then "Back up site now".
22. [mini] Capture `restic snapshots --json` and `restic stats --json --mode raw-data` for the fixtures, and send them over.
23. [Kamaji] "Check restore now" on aleyahoerlein.com, and note how long it took.

## Not in this

- S3 (`restic copy`, with the Arq replacement).
- Sites off craftish.
- Restoring for real: the check proves a restore. Putting one back on craftish is a runbook for later.
- Overdue backups in the morning digest, and Discord for a failed pull: Activity only, for now.
