# The local WordPress

`craftish-care` is built and tested against a DDEV WordPress at `https://kamaji-wp.ddev.site`, on the laptop only. Nothing here touches a real site or the mini.

- `dev/wordpress/`: the DDEV project. Only `.ddev/` is in git; WordPress itself is downloaded by the setup and ignored. The plugin is mounted from `plugin/craftish-care` (`.ddev/docker-compose.craftish-care.yaml`), so edits show at once. `.ddev/mutagen/mutagen.yml` tells Mutagen to skip that path, since it's a bind mount inside the synced tree.
- `kamaji-wp-alias.ddev.site` is the same site under a second name, for the test that a request signed for, and sent to, another of the server's hostnames is refused (`wrong_host`).
- `dev/care-keys.env`: the two craftish-care keys for this site, made by `scripts/care-keys.mjs`. Gitignored, local only. Real keys live in Doppler.
- The admin login is `admin` / `admin`, local only.

## Set up

```
/Users/tyler/kamaji/dev/setup.sh
```

The first run asks for your password once: DDEV adds the two hostnames to `/etc/hosts`. Rerunning is safe.

## Test the plugin

```
cd /Users/tyler/kamaji && npm run test:plugin
```

Signs real requests against the DDEV site, one test per refusal in `docs/protocol.md`. It reinstalls the plugin with the dev keys first, and changes `wp-config.php` briefly for the `FS_METHOD` and `DISALLOW_FILE_MODS` cases. `npm run check` doesn't need DDEV and skips these.

## Vulnerabilities locally

The Wordfence key lives only in the mini's `checker` config. To test matching on the laptop, point the dev server at a saved feed instead: `KAMAJI_WORDFENCE_FEED_FILE=/path/to/feed.json npm run dev`. `packages/server/src/wordfence/fixtures/feed.json` is an invented one, with Akismet 5.3 (on the DDEV site) affected.
