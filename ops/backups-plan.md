# Backups plan (TY-166)

The plan before code, for Tyler to agree or change. Only for sites on craftish: Kinsta and WP Engine keep their own backups; Minton has no SSH.

## Three things to settle first

1. **launchd can't reach Respaldo.** calcifer `ops/molcajete/README.md` says macOS privacy controls block `/Volumes/Respaldo` for launchd jobs; only a compiled binary that holds the permission, or Docker Desktop, gets through. Kamaji's processes are launchd jobs, so restic can't simply run from one. **Recommendation:** run restic in Docker (a pinned `restic/restic` image with the repository folder mounted), which uses Docker Desktop's own access, the way the stack already reaches the drives. The other route is an echoocho-mirror-style compiled wrapper as the LaunchAgent's program. That's more to build, and a rebuilt binary loses the permission. Step 1 of Tyler's steps proves the Docker route from launchd before any code is written.
2. **calcifer `explore/kamaji.md` disagrees.** "Backups as a service" (2026-11-08) says home is the wrong place for clients' data, with S3 as the main copy, and the client's consent switched on in the plugin. TY-166 (2026-11-13) puts the first copy on Respaldo, with S3 later and the switch under Configure. TY-166 is the newer decision, so this plan follows it. explore wins over everything, though, so a Calcifer session should update it, or tell me it still stands.
3. **Arq backs up Respaldo.** The restic repository would go to Arq Cloud too: ciphertext only, and an offsite copy until S3 arrives, but it doubles the storage. Exclude `/Volumes/Respaldo/kamaji` in Arq, or keep it there as the interim offsite copy. **Recommendation:** keep it until `restic copy` to S3 exists.

## craftish

- **A new user, `kamaji-pull`,** not `kamaji-backup`. `kamaji-backup` can make an export but can't read one, and that's worth keeping. `kamaji-pull` can read, and only through its two forced commands. It's a system user with no password and no shell, like `kamaji-backup`.
- **Two keys, two forced commands,** each `restrict`ed and accepted only `from="100.106.213.63"` (molcajete):
  - **The app's download key** → `kamaji-fetch-export <site> <time>`. It streams one existing export, `/var/backups/kamaji/<site>/<time>.sql.gz`, and nothing else. The site must be a plain domain on `/etc/kamaji/db-export.sites`, and the time must match db-export's `^\d{8}T\d{6}Z$`. It runs `cat` as `www-data` through one sudo rule. Paths are never accepted.
  - **The backup process's key** → `kamaji-site-pull <site>`. The site must be on a new list, `/etc/kamaji/site-pull.sites`. It's separate from the export list on purpose: a site can have exports before updates without whole-site pulls. As `www-data` (one sudo rule), it writes one tar to stdout:
    - `wp-content/`, without `cache/`, `upgrade/`, `ai1wm-backups/`, `updraft/`, `backups*/` or `*.log`;
    - `.htaccess`, if there is one;
    - `database.sql`: a fresh `wp db export --single-transaction`, uncompressed so restic can deduplicate it, written to a www-data-only temp file and deleted after;
    - `manifest.json`, written last: the format, site, time, WordPress version, table prefix, the names (not values) of wp-config's constants, and each part's bytes and SHA-256.
- **What it reads:** `/var/www/<site>/public/wp-content`, `.htaccess`, the database through wp-cli, and the exports folder. Never `wp-config.php`, core files or another site.
- **Leaving out wp-config.php:** that keeps the database password, the salts and any keys in constants out of the backup. A restore writes a new wp-config from the manifest: the table prefix plus fresh salts. Logging everyone out is the only cost, and the constants' names show what to put back. The database still holds what plugins keep in options, API keys included. That's unavoidable, which is why it's encrypted on the mini.
- `tar --sort=name`, so an unchanged site gives an almost identical stream, and restic stores almost nothing new.

## How files travel

**tar over SSH, piped straight into restic.** The backup process runs `ssh … kamaji-site-pull <site>` and pipes it into `docker run -i … restic backup --stdin --stdin-filename <site>.tar`. Nothing is written to the mini outside the repository.

The alternative, rsync through `rrsync -ro` into a mirror folder on the mini, sends only changed files. But it keeps a plain copy of every client's files in home, the opposite of encrypted at rest. With weekly runs and a few sites, sending the whole site each time is fine.

A pull counts only if both sides exit 0 and the manifest arrived and checks out. If not, the process deletes the snapshot it just made (`restic forget <id>`) and records the failure with the reason.

## The download

The **Download** button on a site's Backups panel, for the latest export (Tyler's login only, like every request):

1. The app looks up the latest `exported` row in `backup_evidence`.
2. It runs `ssh … kamaji-fetch-export <site> <exported_at>` with the download key.
3. It streams the output to the browser as `<site>-<time>.sql.gz`, computing the SHA-256 as it goes. A mismatch with the evidence is logged and shown afterwards.

- **Where the file lives:** only on craftish, under the export's own retention (14 days, always the newest 3). Nothing is stored on the mini, and the copy that lands in the laptop's Downloads is Tyler's to delete. Once craftish has pruned it, the button says so.
- The download key is the app's, in `~/.ssh/kamaji-fetch` (`KAMAJI_FETCH_SSH_KEY`, not a secret value). The app never holds the pull key or the restic password.

## restic

- **One repository** at `/Volumes/Respaldo/kamaji/restic`, mode 700, owned by `tylercraft`. It uses repository format 2 (compressed), with snapshots tagged `site:<id>`. One repository lets WordPress and plugin files deduplicate across sites. `restic copy --tag site:<id>` can still split it into per-client repositories in S3 later, matching explore's "one prefix per client".
- **Retention:** after each site's snapshot, `restic forget --tag site:<id> --keep-weekly 4 --keep-monthly 6`. `restic prune` runs once a week, on Sundays. `restic check --read-data-subset 5%` runs monthly.
- **The password:** `RESTIC_PASSWORD` in a new Doppler config, **`backup`**, not `checker`, so the app never has it. It's scoped to `~/.kamaji-backups` like the updater's. It's made with `openssl rand` piped straight into `doppler secrets set … > /dev/null`, and never printed, logged or put on argv. It reaches the container through `-e RESTIC_PASSWORD` with no value, so the environment passes it.
- **Losing the password loses every backup.** If Doppler is the only copy, a lost Doppler account means unreadable backups. **Recommendation:** after making it, Tyler copies it once from Doppler's dashboard into his password manager.

## The process and the schedule

- **A third process,** `dev.craftish.kamaji-backups` (`packages/server/src/backups/main.ts`), the same shape as the updater. It runs under Doppler's `backup` config, holds the pull key and the password, takes a lock in `kamaji.db`, does its work, writes what happened to `kamaji.db`, and exits.
- **Nightly at 03:15** (StartCalendarInterval, the mini's NZ time). It backs up each site whose last good snapshot is older than its setting (weekly: 6½ days; fortnightly: 13½), one site at a time. Then it runs at most one restore check, for the site whose last check is oldest, if that's more than 30 days ago.
- **On demand:** "Back up site now" and "Check restore now" on the Backups panel queue a request row, and the app kickstarts the agent, as it does the updater.
- **Configure → Backups** gets "Whole-site backups: off / weekly / fortnightly", off by default, shown only on craftish sites. A site also has to be on craftish's `site-pull.sites`. Until it is, the first pull fails with "not on the allowlist" and the panel says so.
- **If Respaldo isn't mounted or Docker isn't running,** the process records why and stops. Kamaji already alerts on an unmounted Respaldo. A site overdue by more than a day goes in the morning digest's "backups overdue".

## The restore check ("restore to a test copy")

On the mini, in Docker, with nothing reachable from outside and nothing reaching out:

1. Restore the site's latest snapshot into a temporary Docker volume.
2. Check every part against the manifest's SHA-256.
3. Start a pinned MariaDB and a `wordpress` image matching the manifest's version, on an `--internal` Docker network with no internet, so the copy can't send email, call payment APIs or run cron against the world.
4. Import `database.sql`, write a fresh wp-config (the manifest's table prefix, new salts, `WP_HOME` set to the test address, `DISABLE_WP_CRON`), and put back `wp-content`.
5. Fetch the home page inside the network. It passes on a 200 that contains the expected text from the site's own baseline check.
6. Record pass or fail, the step that failed, and how long it took. explore: "restores are the product", and timed.
7. Remove the containers, the network and the volume, pass or fail.

## What Kamaji records and shows

- **New tables:**
  - `site_snapshots`: site, restic snapshot id, time, the tar's bytes, the database's bytes, the data restic added, and ok or the reason it failed.
  - `restore_checks`: site, snapshot id, time, result, the step that failed, seconds taken.
  - The site's backup schedule goes on `sites`.
- **The Backups panel adds:**
  - "Download latest export";
  - Whole-site backups: the schedule, the last and next run, and the snapshot list (time, size, what was new);
  - the repository's total size;
  - the last restore check and its time;
  - "Back up site now" and "Check restore now".
- Discord gets labels and a link only, as now: "whole-site backup failed for 1 site".

## Tyler's steps

Full commands go in `ops/README.md` with the code. These are the steps, in order.

1. [mini] Prove the route: a test LaunchAgent runs `docker run --rm -v /Volumes/Respaldo/kamaji:/repo alpine touch /repo/ok`. Check the file appears, then delete it.
2. [mini] Make the folder: `/Volumes/Respaldo/kamaji`, mode 700.
3. [Doppler] Add a config `backup` to project `kamaji`, beside `updater`.
4. [Doppler] Create `RESTIC_PASSWORD` in `backup` from `openssl rand`, piped straight in, never printed (laptop).
5. [Doppler] Copy the password from the dashboard into your password manager.
6. [Doppler] Make a read-only service token for `kamaji` → `backup`.
7. [mini] Scope that token to `/Users/tylercraft/.kamaji-backups`, pasted at a silent prompt.
8. [mini] Initialise the repository with the pinned restic image (`restic init --repository-version 2`).
9. [mini] Make the pull key, `~/.ssh/kamaji-pull` (no passphrase).
10. [mini] Make the download key, `~/.ssh/kamaji-fetch` (no passphrase).
11. [mini] Show both public keys, to paste on craftish.
12. [craftish] Add the `kamaji-pull` system user, with no password and no shell.
13. [craftish] Install `kamaji-fetch-export`, `kamaji-site-pull` and their two helpers, owned by root (scp'd up from the laptop).
14. [craftish] Add the two sudo rules (`kamaji-pull` → the two helpers as `www-data`, nothing else), checked with `visudo -c`.
15. [craftish] Put the two `authorized_keys` lines for `kamaji-pull` in place (restrict, forced command, `from` molcajete).
16. [craftish] Create `/etc/kamaji/site-pull.sites` with `aleyahoerlein.com`.
17. [mini] Check each key is refused anything else (expect "not a site name", not `uid=`).
18. [mini] Deploy Kamaji (`ops/deploy.sh`).
19. [mini] Install and load the `dev.craftish.kamaji-backups` LaunchAgent.
20. [Kamaji] Configure → aleyahoerlein.com → Whole-site backups: weekly, then "Back up site now".
21. [Kamaji] "Check restore now" on aleyahoerlein.com, and note the time it took.
22. [Arq] Exclude `/Volumes/Respaldo/kamaji`, or don't (see "Three things to settle first").

## Not in this

- S3 (`restic copy`, with the Arq replacement).
- Sites off craftish.
- Restoring for real: the check proves a restore. Putting one back on craftish is a runbook for later.
