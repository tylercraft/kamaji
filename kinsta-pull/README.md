# kinsta-pull

What Kamaji's backups process runs on a Kinsta site, over SSH, for whole-site backups (`ops/backups-plan.md`, "Kinsta"; `packages/server/src/sitebackups/kinsta.ts`). Kinsta has no sudo, so there's no forced command. The process sends one of these files, exactly as it is in the repo, as `bash -c '<file>' kamaji-<name> '<site>'`, with its own key, `~/.ssh/kamaji-kinsta` on the mini. It runs as the site's SSH user, whose WordPress is `~/public`.

- **`pull`** writes one GNU tar to stdout, the same as craftish's `server-pull/site-pull`, with the same exclusions word for word. It holds `wp-content/`, `.htaccess`, `database.sql` and `manifest.json` last, and never `wp-config.php` or core files. First it checks the site's home URL is the site's, so a login for another site is refused. The dump goes in a folder in the user's home, outside `public`, readable only by that user. It's removed however the pull ends; one left by a pull killed outright is removed by the next. A problem goes to stderr as `{"format":1,"ok":false,"problem":"…"}`, and any non-zero exit means restic keeps no snapshot.
- **`test`** is Configure's "Test connection". It only reads. It writes one JSON line: the WordPress path, its version and home URL, wp-cli's version, and the sizes of wp-content (`du -sk`) and the database (`wp db size --size_format=b`), which the 20 GB check uses.
- **`check`** runs both, sent the way Kamaji sends them, against a made-up home with a stand-in `wp`. It checks the tar, the exclusions, the test's line, and that no work folder is left after a pull that worked, one that failed, and one hung up mid-dump. It needs GNU tar, so run it in Ubuntu:

```
docker run --rm --network none -v "$PWD/kinsta-pull":/kp:ro -v /tmp/kp-out:/out ubuntu:24.04 /kp/check
```
