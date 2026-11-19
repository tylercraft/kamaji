# Rollback plan

Putting a site back the way it was before an update run, in one step from the site's page (promised to Briardale's maintenance plan). Written 2026-11-19 and approved by Tyler the same day, with his answers ("Settled", at the end); built on branch `rollback`. `backups-plan.md` is the ground it stands on: the pulls, the snapshots and the restore check. The script on the host is `site-push/` (its README says exactly what it touches); Kamaji's side is `packages/server/src/rollback/`; the steps on craftish are in `ops/README.md`, "Rollback".

## Where this differs from the brief

Tyler's brief, with the places I'd change it. Each one comes up again below.

1. **Core isn't in any snapshot.** The pulls never take core files (or `wp-config.php`), so a snapshot can't put WordPress back. Core comes from wordpress.org instead: `wp core download --version=<from> --skip-content` into the staging folder on the server, checked with `wp core verify-checksums` before anything is swapped. Plugins and themes come from the snapshot.
2. **Kinsta has no server-side allowlist.** Kinsta has no sudo and no forced commands, so the key that pulls is already a full shell as the site's user, and a second key would be just as powerful. On Kinsta the gates are Kamaji's side: the passkey, the site's `kinsta_access` row, and a push script that touches only what the plan in its tar names. craftish gets a real allowlist, as you described.
3. **Only the site's latest run that hasn't been rolled back.** Rolling back an older run while a newer one stands would either undo the newer run's items too or leave a mix nobody tested. A run that's no longer the latest says "Roll back the run on <date> first". Once that's rolled back, the one before becomes the latest, so going further back is a chain of single steps.
4. **"Inside the retention window" means the snapshot still exists,** not a fixed 14 days. restic's `--keep-within 14d` counts back from the newest snapshot, and `--keep-weekly 4 --keep-monthly 6` keep some older ones. Kamaji records `forgotten_at` when a snapshot is pruned, so Roll back is offered while the run's snapshot isn't forgotten, and its age is always shown.
5. **There's no per-site lock across processes today.** The updater runs one site at a time and the plugin refuses a second job (`busy`), but nothing stops the backups process and the updater working on the same site at once. Rollback adds one check both sides honour (below, "One thing at a time").
6. **The restore point isn't recorded as an id.** A fresh before-update snapshot carries its `batch_id`, but a snapshot the run relied on because it was under a day old is named only in `batch_sites.backup`'s words. A migration adds the ids, and backfills them for past runs.
7. **Files-only can leave older code on a newer database.** A plugin whose update migrated its tables (WooCommerce, Yoast and ACF do this on some versions) may not run cleanly on the old code. The database stays off by default, as you said, but the dialog says this in a line, and the checks afterwards are what tell.

## The flow

1. **Tyler opens the site's page** and finds the run under Updates. The run's line has **Roll back…** when the site can be rolled back (below). It's a quiet button on a run that went through, and a primary one, next to the ⚠️, on a run held after a failed check or one Tyler carried on past.
2. **The dialog** says exactly what will happen and asks for the passkey, every time: the 10-minute passkey window doesn't cover a rollback or an undo. With the database box ticked, it first asks the backups process to count what the database would lose (below) and shows the numbers before the button works.
3. **The app records the request** (`rollbacks`, state `waiting`) with the passkey's proof and the body as signed, and starts the backups process, as it does for "Back up now". The updater won't start the site while it waits.
4. **The backups process takes it** between sites, as it takes other requests. It holds the restic password and the SSH keys, which the app and the updater don't. It checks the signature again (as the updater does for a batch), so a row written straight into the database never runs; then it checks, builds the push, and runs the push script on the host, step by step (below, "The push").
5. **The app's cycle finishes it:** a fresh report (versions), the site's checks from the mini and from outside, a line in Activity, one Discord message and a toast for Tyler.
6. **Undo rollback** stays on the run for 14 days, and puts back what was there before the rollback, the same way.

### Wording

On the run, when it can be rolled back:

> **Roll back…** Restore point: whole-site backup, 19 Nov 03:02 (2 days ago).

The dialog:

> **Roll back Briardale Wealth to before the run on 19 Nov**
>
> Puts back:
>
> - WooCommerce 9.4.1 (now 9.5.0)
> - Yoast SEO 23.1 (now 23.2)
> - WordPress 7.1.4 (now 7.1.5), from wordpress.org, checked against its checksums
>
> From the whole-site backup of 19 Nov 03:02, 2 days ago.
>
> ☐ **Also put back the database**
> Everything written to the database since 19 Nov 03:02 (2 days ago) is lost: orders, form entries, new users, comments, and any settings changed since. Leave this off unless the site is broken without it.
>
> Ticked, it reads "Counting them on the site…" with the button off, then: "Everything written to the database since 19 Nov 03:02 (2 days ago) is lost: **12 orders, 3 comments and 1 new user**, along with form entries and any settings changed since." A count that fails says "Kamaji couldn't count them (why)" with the kinds as above, and the button works.
>
> With the database left as it is, an update that changed the plugin's tables may not run cleanly on the older version. The checks afterwards will say.
>
> Before changing anything, Kamaji saves the site's database as it is now and moves the current files aside, so this can be undone for 14 days. The site shows WordPress's maintenance page for about a minute.
>
> **[Roll back with passkey]**

With the database ticked, the restore point on craftish is the run's own database export where there is one, since it's newer than the snapshot: "the database export from 19 Nov 03:00, just before the update". Kinsta has only the snapshot's `database.sql`.

Where Roll back isn't offered, the run says why, in one line:

- "Rollback needs SSH, which Kamaji has only on craftish and Kinsta. <Host>'s own backups are the way back." (WP Engine, Minton, any other host.)
- "No whole-site backup came before this run, so Kamaji has no files to put back." (Whole-site backups off, or the run relied on the host's, the client's or Tyler's backups.)
- "This run's whole-site backup has been pruned (it kept 14 days, then one a week and one a month)."
- "Roll back the run on 21 Nov first."
- "Nothing changed in this run." (Every item failed to update.)
- "Since this run, Yoast SEO went from 23.2 to 23.3 outside Kamaji, so the site isn't the way the run left it." (The latest report doesn't show the run's to-versions.)
- "A rollback or update is already running for this site."

After a rollback, the line is about the run before it, so it names that run instead of "this run": "The run on 15 Nov can't be rolled back: no whole-site backup came before it." (aleyahoerlein.com trial, 2026-11-19.)

Discord gets counts and the site name only:

- `↩️ Rolled back Briardale Wealth: 3 updates put back, files only, checks passed`
- `↩️ Rolled back Briardale Wealth: 3 updates put back with the database from 2 days ago, checks passed`
- `⚠️ **Needs you:** Briardale Wealth's rollback stopped at the swap. Nothing was changed.`
- `⚠️ **Needs you:** Briardale Wealth was rolled back (3 updates), but its home page check failed.`

The toast says the same with the names and versions, and Activity records it as `site.rollback` or `site.rollback-failed`.

## Before it starts (on the mini, nothing touched yet)

The backups process refuses, with the line above, unless all of these hold:

- the site is on craftish (and on `site-push.sites`, which only the server can say) or Kinsta (with a `kinsta_access` row whose last test passed);
- the run is the site's latest one not rolled back, and finished;
- its snapshot exists in restic and isn't forgotten;
- no batch, backup, restore check or other rollback for the site is waiting or running;
- the latest report shows each item at the run's to-version (so nothing changed it since);
- in the snapshot, each plugin's and theme's version header is the run's from-version. This catches a snapshot older than a manual change, where putting it back would install a version the run never saw.

Then it reads only what it needs from the snapshot: `restic dump <snapshot> /<site>.tar` streams the tar, and GNU tar pulls out each updated plugin's folder (or single file, for a plugin like `hello.php`), each updated theme's folder, and `database.sql` when the database is ticked. They go into a mode-700 folder under `~/kamaji-restore`, like the restore check's, removed when the rollback ends.

The snapshot's `*.log` exclusion applies inside plugin folders too, so a plugin that ships a `.log` file comes back without it. I haven't seen one that does; noting it in case.

## The push

One tar on stdin, as the pulls send one on stdout. It holds `plan.json` first, then the files under `plugins/<slug>/` and `themes/<slug>/`, then `database.sql` if any. `plan.json` gives the rollback's id, the site, each item (type, slug, the version it should find now, the version it puts back) and whether the database comes too. The script trusts nothing in it beyond that: it refuses any tar member outside the folders the plan names, absolute paths, `..`, links pointing outside their folder, and device files.

### Steps on the server

Each prints one JSON line as it finishes, `{"format":1,"step":"stage","ok":true}`, and a problem as `{"format":1,"ok":false,"step":"…","problem":"…"}` on stderr, as the pulls do.

1. **check:** the home URL is the site's (as kinsta-pull does), each item is at the version the plan expects, and there's room for the staged copy plus the moved-aside one.
2. **stage:** unpack into `<hold>/<id>/new/`. For core, `wp core download --version=<from> --skip-content --path=<hold>/<id>/new/core`, then `wp core verify-checksums` against it. Check each staged plugin's and theme's version header again.
3. **save:** `wp db export --single-transaction` to `<hold>/<id>/before.sql`, always, database ticked or not, since an old plugin's activation can write to the database too.
4. **maintenance on:** `wp maintenance-mode activate`.
5. **swap:** for each item, rename the live folder to `<hold>/<id>/old/…`, then the staged one into place, writing each rename to `<hold>/<id>/journal` before it's made. For core, the same for `wp-admin`, `wp-includes` and the root files the download has (never `wp-config.php`, `wp-content` or `.htaccess`). Renames stay on one filesystem, so each is instant. The moved-aside copies sit outside the web root, so WordPress never sees two copies of a plugin.
6. **database** (ticked only): `wp db import`. On craftish from the run's export (`/var/backups/kamaji/<site>/<time>.sql.gz`, already on the server, so nothing to send), else the pushed `database.sql`.
7. **maintenance off,** then `wp cache flush`, and on Kinsta its page cache purge (open question 6).

Steps 4 to 7 are the critical part. The script ignores HUP, INT and TERM through them, so a dropped SSH connection doesn't stop it halfway; it carries on to the end and leaves its result in `<hold>/<id>/result.json`. The backups process reads that on its next connection if the first one dropped.

### Undo

The same script with `undo <id>`: maintenance on, swap `old/` back (journaled the same way), import `before.sql` if the rollback imported a database, maintenance off. It's offered for 14 days. Holding folders older than that are removed by the next push for the site, and on craftish by the script's own cleanup too.

### craftish

- **A new user, `kamaji-push`,** and a new key on the mini, `~/.ssh/kamaji-push`, held by the backups process. Not another key on `kamaji-pull`: that user only reads, and keeping it that way means a leaked pull key still can't change a site.
- **One forced command,** `kamaji-site-push`, `restrict`ed and `from="100.106.213.63"`, taking `<site> <id>` or `<site> undo <id>`. It refuses anything that isn't a plain domain and a rollback id (`^[0-9a-f]{16}$`) before sudo, then runs `/usr/local/lib/kamaji/site-push` as `www-data` through one sudo rule.
- **Its own allowlist,** `/etc/kamaji/site-push.sites`, owned by root. Your step on the server, per site.
- **Touches only** `/var/www/<site>/public/wp-content/plugins/<slug>`, `…/themes/<slug>`, core's `wp-admin`, `wp-includes` and root files, the database through wp-cli, and its holding folder, `/var/www/<site>/.kamaji-rollback/` (open question 1). Never `wp-config.php`, `uploads`, `.htaccess` or another site.
- Scripts in `server-push/`, with a README, a `check` like `server-pull/check-exclusions`, and the install steps in `ops/README.md`.

### Kinsta

- **The same key** as the pulls, `~/.ssh/kamaji-kinsta`, and the same way of sending: `bash -c '<push>' kamaji-push '<site>' '<id>'`, with the tar on stdin. Point 2 above says why a second key would gain nothing.
- **tar, not rsync.** The pull already relies on GNU tar there, and one tar over stdin needs nothing else. I haven't confirmed rsync exists on Kinsta and the plan doesn't need it. `test` will report `tar --version`, wp-cli and free space (`df` on the home folder) so Configure's Test connection says whether a site can be rolled back.
- **Touches** `~/public/wp-content/plugins/<slug>`, `…/themes/<slug>`, core under `~/public`, the database through wp-cli, and `~/.kamaji-rollback/` outside `public`, readable only by the site's user. Kinsta's own mu-plugin and drop-ins (`object-cache.php`, `advanced-cache.php`) are never touched.
- Scripts in `kinsta-push/` beside `kinsta-pull/`, with the same kind of `check` in Ubuntu.

## One thing at a time

A site is busy while it's in a batch that's approved or running, or has a backup, restore check or rollback waiting or running. Rollback is refused while it's busy, and while a rollback is waiting or running, the updater holds that site with "A rollback is running for this site" and the backups process skips its scheduled pull. One function, `siteBusy(db, siteId)`, that the app, the updater and the backups process all call. While the swap runs, the site's uptime alerts are paused through `sites.updating_until`, as the updater does, so the maintenance page doesn't page Tyler.

## Data model (migration 27)

- **The restore point, as built:** worked out when Roll back is offered, from what's already recorded, and kept on the rollback's row as used: the snapshot whose `batch_id` is the run's, else the newest good snapshot that finished before the run's site started and began within a day of it (the one the run relied on); and on craftish the run's own export from `backup_evidence`, while it's under 13 days old (craftish keeps 14). That gives the same answer the `batch_sites` columns would have, for past runs too, with nothing to backfill, so those columns weren't added.
- **`rollbacks`:** one row each for a rollback and an undo (`kind`; an undo names the rollback it `undoes`), so both go through the same states: `waiting`, `running`, then `done` or `failed`, with `step`, `problem`, a scrubbed `problem_detail`, and `changed` (what the push left: `none`, `files`, `all`, `partial`, `broken`, `unknown`). Also the restore point used (`snapshot_id`, `snapshot_at`, `export_time`, `database_at`), the passkey's `approval` (proof and body as signed), `warnings`, and the checks after (`checked_at`, `checks_ok`, `checks_problem`), then `announced_at`.
- **`rollback_counts`:** the dialog's count before the passkey: the site, the run, `since` (the restore point's database time), `state`, then `orders` (null off WooCommerce), `comments`, `users` or a `problem`.
- **`rollback_items`:** `rollback_id`, `type`, `item`, `name`, `from_version` (what it found), `to_version` (what it put back), `state`.
- **Shared:** a `Rollback` view on the site's run history, with `canRollBack` and `whyNot` worked out on the server, so the web shows them and doesn't decide.

Routes: `GET /api/sites/:id/rollback` (the offer or why not, the latest, and Undo or why not), `POST /api/sites/:id/rollback/count` (no passkey: it changes nothing; body `{ batchId }`, answers the count's id), `GET /api/sites/:id/rollback/count/:count`, `POST /api/sites/:id/rollback` (passkey each time, body `{ batchId, withDatabase }`), `POST /api/sites/:id/rollback/undo` (passkey each time, body `{ rollbackId, withDatabase }`).

Who does what: the backups process pushes (it holds the snapshots and the SSH keys); the updater runs the checks after, as it does after an update (it holds the Care keys), and ends the uptime pause. Site Health is measured against the site's last report from before the rollback or undo was asked for, and only without one against the run's own baseline, which may be days old and miss a release that came out since (aleyahoerlein.com trial, 2026-11-19); the app's cycle sends the one Discord line, and the toast goes to whoever asked.

## When a step fails

| Step                                        | What's left on the site                                             | What Kamaji says and does                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before it starts, on the mini               | Nothing touched                                                     | The line why. Activity records it, no Discord                                                                                                                                  |
| Reading the snapshot                        | Nothing touched                                                     | "Couldn't read the restore point" and restic's scrubbed tail                                                                                                                   |
| SSH, check or stage                         | Nothing touched; the staging folder is removed                      | "Stopped before changing anything", the step and why                                                                                                                           |
| Save (`before.sql`)                         | Nothing touched                                                     | Same. No rollback without a way back                                                                                                                                           |
| Maintenance on                              | Nothing touched                                                     | Same                                                                                                                                                                           |
| Swap, part way                              | The script reverses its journal, then turns maintenance off         | "Stopped at the swap. Nothing was changed." Discord ⚠️                                                                                                                         |
| Swap, and reversing fails too               | Some items back, some not, maintenance off                          | Which items are where, by name, on the site page; Discord ⚠️ Needs you; Undo offered                                                                                           |
| Database import                             | The script imports `before.sql` again, then turns maintenance off   | "The database didn't import; it's as it was. The files were rolled back." Discord ⚠️; Undo offered for the files                                                               |
| Database import, and `before.sql` fails too | Database part-imported                                              | Discord ⚠️ Needs you at once, with where `before.sql` is on the server. WordPress drops its maintenance page after 10 minutes by itself, so the site will show whatever it can |
| Maintenance off, cache flush                | Rolled back; maintenance page may stay up to WordPress's 10 minutes | Rollback counted done, with a warning                                                                                                                                          |
| Checks afterwards                           | Rolled back                                                         | Done, Discord ⚠️ "check failed", Undo shown prominently                                                                                                                        |
| SSH drops in steps 4 to 7                   | The script finishes regardless                                      | The backups process reads `result.json` next time. Until then the rollback stays `running` and the site stays busy                                                             |

## Testing

1. **Fixtures first.** Output captured from wp-cli for `maintenance-mode activate`, `core download`, `core verify-checksums`, `db import` and the push script's own lines, on the DDEV site. Nothing parsed from a guess.
2. **The scripts' `check`s,** in Ubuntu with a stand-in `wp`, as `kinsta-pull/check` does: refusals (bad names, members outside the plan, links, `..`), the swap and its reversal, HUP in the critical section, undo, and the cleanup of old holding folders.
3. **Kamaji's side with a fake SSH,** as the pulls are tested: each refusal line, each failure row in the table, the lock, the backfill, Discord's words with no names in them.
4. **The DDEV site,** end to end: update a plugin and a theme and core through Kamaji, roll back with and without the database, undo, and look at the site each time.
5. **aleyahoerlein.com,** on craftish, the same, with `site-push.sites` holding only that site.
6. **Then Briardale** (Kinsta), first with the files only, while you watch.

## Not in v1

- Sites without SSH (WP Engine, Minton). Their hosts' backups are the way back.
- Choosing which items to put back. It's the whole run or nothing.
- Rolling back an older run past a newer one (point 3).
- Anything in `uploads`, other content, or a merge that keeps orders since the restore point. Ticking the database is all or nothing.
- Rollback without a whole-site backup (database export only).
- Multisite.
- Rolling back automatically, ever.
- Telling the client. Their maintenance plan says rollback exists; who tells them it happened is open question 8.

## Settled (Tyler, 2026-11-19)

The answers to the questions below, and what was added:

1. The holding folder sits beside `public` on craftish: `/var/www/<site>` is `tyler:www-data` 775, on the same filesystem as `public`. The push checks the same disk before it starts.
2. A new `kamaji-push` user.
3. Core from wordpress.org. A major core rollback warns about the database in the dialog but doesn't insist.
4. Latest run only.
5. Undo for 14 days.
6. Kinsta's cache: `wp kinsta cache purge` (no `--all`). A failure is a warning, not a failed rollback.
7. `opcache.validate_timestamps` is at its default (on) on craftish, so swapped files are picked up.
8. Tyler tells the client; out of scope.
9. Orders (WooCommerce only), comments and users since the restore point are counted, read only. **Changed after review:** the count comes before the passkey, not with the outcome. Ticking the database box asks the backups process for it (`push … count`); the dialog shows "Counting…", then the numbers, and Roll back works only once they're in. A count that fails says so and leaves the box usable, with the kinds-only warning. The push itself no longer counts.
10. **Added:** Undo follows Roll back's rule: only while nothing has changed since the rollback (no newer run, the versions as the rollback left them). The push checks it on the server too.
11. **Added:** core files outside wp-content have no default ACL on craftish, and `www-data` can't give files to `tyler`. So staged core takes the replaced copy's group and modes (775 and 664 there), and an ACL entry for the replaced copy's owner when they can't write through the group; without `setfacl` on the server, a core rollback is refused before anything changes. Plugin and theme folders inherit their parent's default ACL, as a folder made in place would.
12. **Added:** `/var/backups/kamaji/<site>/` isn't loosened. The mini keeps no copy of the exports, so there's none to send, but `www-data` owns them (craftish's `fetch-export` already streams them as `www-data`), so the push, running as `www-data`, reads the one its plan names. No second sudo rule.
13. **Changed after review:** rollback and undo always sign, like approving a batch: no 10-minute passkey window for them. The row keeps the proof and the body as signed, and the backups process checks them again before it pushes (`rollbackApprovalProblem`): the proof for that exact route and body, the row as the body says (the run or the rollback undone, and the database box), and the nonce used once across batches and rollbacks.

## Open questions for Tyler (answered above)

1. **On craftish,** is `/var/www/<site>/` writable by `www-data` and on the same filesystem as `public`, so the holding folder can sit beside it? If not, `/var/backups/kamaji/<site>/rollback/` works, but the rename becomes a copy if it's another filesystem.
2. **A new `kamaji-push` user** (my recommendation), or a second key on `kamaji-pull`?
3. **Core from wordpress.org** via `wp core download` on the server: all right? And for a major core update (7.0 → 7.1), which can run a database upgrade, should Roll back insist on the database too, or only warn?
4. **Latest run only** (point 3): all right?
5. **14 days for Undo,** and on Kinsta, room for a moved-aside copy (usually small: a few plugin folders and core)?
6. **Kinsta's page cache:** what clears it from SSH? I'd rather capture it on Briardale than guess (`wp kinsta cache purge --all` is what I'd expect, unconfirmed).
7. **opcache on craftish:** does PHP-FPM check timestamps (`opcache.validate_timestamps`)? If it doesn't, the old code keeps running until FPM reloads, which `www-data` can't do.
8. **Telling the client:** does Briardale's plan say they hear about a rollback, and from whom?
9. **The database warning with numbers:** worth having the check step count orders, comments and users since the restore point (`wp db query`, read only), so the dialog says "12 orders and 3 comments since then" instead of only the kinds? It's one more read on the client's database.
