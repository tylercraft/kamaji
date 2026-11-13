# kamaji-pull

What Kamaji on molcajete may read from craftish: one database export to download, and one site's files and database for a whole-site backup (`ops/backups-plan.md`, TY-166). It's the read side of `server-export/`, kept apart from it: `kamaji-backup` can make an export but never read one.

- **Its own user,** `kamaji-pull`, a system user with no password, holding two of Kamaji's keys and nothing else. Its shell is `/bin/sh` only because sshd runs a forced command through it; each key can run only its one command.
- **Two keys, each forced to one command,** each `restrict`ed (no shell, terminal, forwarding or `~/.ssh/rc`) and accepted only from molcajete's tailnet address (`100.106.213.63`):
  - the app's **download key** runs `kamaji-fetch-export`, which takes `<site> <time>`;
  - the backup process's **pull key** runs `kamaji-site-pull`, which takes `<site>`.
- **Site names and export times, never paths.** Each forced command refuses anything that isn't a plain domain name (and, for a download, db-export's time, `20261113T004147Z`) before sudo. It then runs its helper as `www-data` through one sudo rule. The helper checks the name again, against its own allowlist, owned by root:
  - `fetch-export` against `/etc/kamaji/db-export.sites`, the export's list;
  - `site-pull` against `/etc/kamaji/site-pull.sites`, a separate list, so a site can have exports before updates without whole-site pulls.
- **The download** streams `/var/backups/kamaji/<site>/<time>.sql.gz`, a plain file (never a link), or one JSON line saying why not: `{"format":1,"ok":false,"problem":"…"}`. A gzip starts with bytes `1f 8b` and the JSON with `{`, which is how Kamaji tells them apart.
- **The pull** writes one GNU tar to stdout:
  - `wp-content/`, without `cache/`, `upgrade/`, `ai1wm-backups/`, `updraft/`, `backups*/` or `*.log`;
  - `.htaccess`, if there is one;
  - `database.sql`, from `wp db export --single-transaction` into a www-data-only work folder under `/var/backups/kamaji/.pull`, deleted after;
  - `manifest.json`, always last: `format`, `site`, `at`, `wordpress`, `tablePrefix`, `config` (wp-config's names from `wp config list --fields=name`, never values) and `database` (`bytes`, `sha256`).

  Never `wp-config.php` or core files. A problem goes to stderr as the same JSON line, and any non-zero exit means restic keeps no snapshot. A file that changes while tar reads it is a warning, not a failure.

Not yet run on craftish or in a Debian container. The forced commands' refusals were checked locally with bash (2026-11-13); the sudo side and the tar are untested until Tyler's steps.

## The authorized_keys lines

In `/var/lib/kamaji-pull/.ssh/authorized_keys` on craftish, with molcajete's public keys (`~/.ssh/kamaji-fetch.pub` and `~/.ssh/kamaji-pull.pub` on the mini) in place of the last parts:

```
restrict,command="/usr/local/bin/kamaji-fetch-export",from="100.106.213.63" ssh-ed25519 AAAA… kamaji-fetch@molcajete
restrict,command="/usr/local/bin/kamaji-site-pull",from="100.106.213.63" ssh-ed25519 AAAA… kamaji-pull@molcajete
```

## The sudo rule

`/etc/sudoers.d/kamaji-pull`, mode 440:

```
kamaji-pull ALL=(www-data) NOPASSWD: /usr/local/lib/kamaji/fetch-export, /usr/local/lib/kamaji/site-pull
```

## Installing on craftish

The numbered steps are in Kamaji's runbook, `ops/README.md`, "Whole-site backups". To let a site be pulled, add its line to `/etc/kamaji/site-pull.sites`.
