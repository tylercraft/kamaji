# site-push

What Kamaji runs on a site's host to roll back an update run, and to undo that (`ops/rollback-plan.md`; Kamaji's side is `packages/server/src/rollback/`). One script, `push`, for both hosts that Kamaji reaches over SSH:

- **craftish:** installed at `/usr/local/lib/kamaji/site-push`, run as `www-data` through one sudo rule by the forced command `kamaji-site-push`, under its own user, `kamaji-push`, with Kamaji's own key. It has its own allowlist, `/etc/kamaji/site-push.sites`, separate from the pull's.
- **Kinsta:** no sudo and no forced commands, so the backups process sends `push` over SSH as it is in the repo, as `bash -c '<push>' kamaji-push kinsta …`, with Kinsta's own key, as the pulls go. There's no allowlist on Kinsta's side: the gates are Kamaji's (the passkey's signature, checked again before the push; the site's saved SSH access) and the plan's checks below.

## What it takes

```
push <host> rollback <site> <id>             a tar on stdin: plan.txt first, then the files
push <host> undo <site> <id> files|database  puts back what that rollback replaced
push <host> result <site> <id> rollback|undo what that one ended with
push <host> count <site> <id> <since>        what the database box would lose, read only
```

`plan.txt` is one fact a line, each checked against a pattern: `format 1`, `id`, `site`, one `item <type> <item> <now> <back>` per plugin, theme or core, and, when the database comes too, `database export <time>` (craftish: the export db-export made before the run, already on the server) or `database tar` (Kinsta: `database.sql` in the tar). Nothing arrives that the plan doesn't name: no other folders, no links pointing out of their folder, no devices, no `..`.

## What it does

Each step prints one line to stdout, `{"format":1,"step":"…","ok":true}`. The last line is the result, kept as `result.json` (`undo-result.json`) in the rollback's folder, so `result` can read it back after a dropped connection. A problem also goes to stderr as `{"format":1,"ok":false,"step":"…","problem":"…","changed":"…"}`, where `changed` is `none`, `files` (the database couldn't be put back, and is as it was), `partial` or `broken`.

1. **check:** the site's home URL is the site's; each item is at the version the run left, and is writable; the site isn't in maintenance mode; the export named is there; there's room. On craftish, the site is on the allowlist. One rollback at a time per site (`flock`), and none while an earlier one stopped part way.
2. **stage:** the files unpacked into the rollback's folder, and each one's Version header checked. Core comes from wordpress.org (`wp core download --skip-content`, in the site's language or else en_US) and must pass `wp core verify-checksums`. Staged copies get what a copy made in place would have: a plugin or theme folder inherits its parent's default ACL; core takes the group and modes of the files it replaces and, where their owner isn't this user and can't write through the group, an ACL entry so they still can. `www-data` can't give files away, so new core files are owned by `www-data`.
3. **save:** `wp db export` of the site as it is now, whatever's asked, to `before.sql.gz`.
4. **maintenance**, **swap**, **database**: maintenance mode on; each live folder renamed into the folder's `old/`, then the staged one into place, each rename written to a journal first; `wp db import` if asked. A swap that fails is reversed from the journal. A database that won't import gets `before.sql.gz` imported back. From maintenance mode on, it ignores HUP, INT and TERM: a dropped connection doesn't stop it halfway.
5. Maintenance mode off, `wp cache flush`, and on Kinsta `wp kinsta cache purge`.

It touches only the plugin and theme folders the plan names, core's `wp-admin`, `wp-includes` and root files (never `wp-config.php`, `wp-content` or `.htaccess`), the database through wp-cli, and its holding folder beside the site, mode 700: `/var/www/<site>/.kamaji-rollback/` on craftish, `~/.kamaji-rollback/` on Kinsta. That folder keeps the replaced copies and the export for 14 days, for Undo, and is cleaned by the next push after that.

**Count** is for the rollback dialog, before the passkey: orders (WooCommerce only), comments and users since `<since>` (the restore point's database time, as db-export names times), through `wp db query`, read only. It takes no lock, makes no folder and keeps nothing: one line, `{"format":1,"step":"count","ok":true,"orders":12,"comments":3,"users":1}`, with `orders` null off WooCommerce.

**Undo** checks the site is as the rollback left it, saves the database again, then, under maintenance mode, moves what the rollback put in aside and the replaced copies back, journaled the same way. With `database`, it imports `before.sql.gz`.

**The export on craftish** is read by `www-data`, which already owns it: `fetch-export` streams the same files as `www-data`. So nothing about `/var/backups/kamaji/` is loosened, no copy is kept on the mini, and there's no second sudo rule.

## Checks

- **`check`** runs `push` and `kamaji-site-push` the way Kamaji does, against a made-up craftish site and a made-up Kinsta home, with a stand-in `wp`: every refusal, the count (and that it changes nothing), the swap and its reversal, the database's way back, a hang-up mid-swap, undo, cleanup after 14 days, and core's group and modes. Only in a throwaway container, never on craftish (it writes `/var/www/site.test` and `/etc/kamaji/`):

```
docker run --rm --network none -v "$PWD/site-push":/sp:ro ubuntu:24.04 /sp/check
```

With the `acl` package installed in the image it checks the ACL paths too.

- **`ddev.test.ts`** rolls back a real run on the laptop's DDEV WordPress, end to end: a real pull for the restore point, real updates through wp-cli, Kamaji's own code between them, files only and then with the database, each undone, then the site put back as it was. `npm run test:rollback`, laptop only.
- **`fixtures/wp-cli-2.12.txt`:** what wp-cli 2.12 said in DDEV for each command `push` uses (2026-11-19), so its exit codes and lines aren't guessed. `push` reads only exit codes and single values from wp-cli.

## The authorized_keys line

In `/var/lib/kamaji-push/.ssh/authorized_keys` on craftish, with molcajete's public key (`~/.ssh/kamaji-push.pub` on the mini) in place of the last part:

```
restrict,command="/usr/local/bin/kamaji-site-push",from="100.106.213.63" ssh-ed25519 AAAA… kamaji-push@molcajete
```

## The sudo rule

`/etc/sudoers.d/kamaji-push`, mode 440:

```
kamaji-push ALL=(www-data) NOPASSWD: /usr/local/lib/kamaji/site-push
```

## Installing on craftish

The numbered steps are in Kamaji's runbook, `ops/README.md`, "Rollback". To let a site be rolled back, add its line to `/etc/kamaji/site-push.sites`.
