# kamaji-db-export

A database export on craftish before Kamaji updates a site there: the backup evidence of the strongest kind, "Kamaji did it" (calcifer `explore/kamaji.md`, "Backup evidence"). Kamaji on molcajete asks over SSH, naming one site; the export stays on craftish, and Kamaji gets one JSON line back: the time, size and SHA-256, never the data.

- **Its own user,** `kamaji-backup`, a system user with no password, holding only Kamaji's backup key. It can't read the exports.
- **The key** is `restrict`ed (no shell, terminal, forwarding or `~/.ssh/rc`), accepted only from molcajete's tailnet address (`100.106.213.63`), and forced to run `kamaji-db-export` whatever the client asks.
- **A site name, never a path.** `kamaji-db-export` takes the SSH command as the site name and refuses anything that isn't a plain domain name. It then runs `db-export` as `www-data` through one sudo rule, and `db-export` checks the name again, against `/etc/kamaji/db-export.sites`, one site per line, owned by root.
- **The export:** `wp db export` with `--single-transaction` (consistent, without locking the site), for `/var/www/<site>/public`, gzipped into `/var/backups/kamaji/<site>/<UTC time>.sql.gz`, readable by `www-data` only. Exports older than 14 days are deleted, always keeping the newest 3.

Tested in a Debian container with a stand-in `wp` (2026-11-11): the export runs as `www-data`; bad names, paths, injected commands and sites off the allowlist are refused; the sudo rule allows nothing else; old exports are pruned; a failed export leaves no partial file.

## The authorized_keys line

In `/var/lib/kamaji-backup/.ssh/authorized_keys` on craftish, with molcajete's public key (`~/.ssh/kamaji-backup.pub` on the mini) in place of the last part:

```
restrict,command="/usr/local/bin/kamaji-db-export",from="100.106.213.63" ssh-ed25519 AAAA… kamaji-backup@molcajete
```

## Installing on craftish

The numbered steps are in Kamaji's runbook, `ops/README.md`, "craftish's database export". To add a site, add its line to `/etc/kamaji/db-export.sites`.
