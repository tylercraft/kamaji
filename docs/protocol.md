# craftish-care protocol, v1

The contract between Kamaji and the WordPress plugin. Written 2026-11-08, before any code; the build (calcifer `explore/kamaji/plan.md`, M3 and M4) implements it and changes this file when it has to. Moved into the kamaji repo as the working copy on 2026-11-09 (Tyler); calcifer's copy is a pointer here. The design rules behind it are in `../kamaji.md`, "The child plugin". The short version: **it can report, run updates WordPress itself offers, and forget its keys. Nothing else.**

## Keys

- Two Ed25519 key pairs, **report** and **update**. Kamaji holds the private keys (Doppler, `kamaji` project: the checker config has only the report key, the updater config only the update key). Every site stores both public keys.
- Signing and verifying use libsodium: `sodium_crypto_sign_verify_detached` in PHP (built in since 7.2; WordPress also bundles sodium_compat) and Node's `crypto.verify(null, …)` with Ed25519. No other crypto.
- Each key has a short id (`r1`, `u1`) so a later rotation can run old and new side by side. v1 has no rotation endpoint: rotating means reinstalling the plugin with new keys, which is acceptable at a dozen sites.
- The public keys arrive in the zip Kamaji builds at "Add site" (`craftish-care-keys.php`, plain constants). On activation the plugin copies them into an option and refuses to run without them. Reactivating a copy with no keys file (as after a self-update) keeps the keys already stored.
- From 0.2.0, a third pair, **release** (`p1`), signs Craftish Care's own packages ("Self-update" below). It never signs a request, and its id can't be a request key's. Its private half is in the `release` config, read only on the laptop; checker holds its public half for the zip. The plugin stores it with autoload off, on activation, or the first time wp-admin or Kamaji's requests run after "Replace current with uploaded" (which doesn't run the activation hook). It never replaces one already stored.

## Requests

- `POST https://<site>/wp-json/craftish-care/v1/<endpoint>`, JSON body, HTTPS only (the plugin refuses plain HTTP unless `WP_ENVIRONMENT_TYPE` is `local`). Where a security plugin blocks `/wp-json/`, Kamaji retries with `/?rest_route=/craftish-care/v1/<endpoint>`.
- Headers:
  - `X-Care-Key`: the key id (`r1` or `u1`)
  - `X-Care-Time`: Unix seconds
  - `X-Care-Nonce`: 16 random bytes, base64url
  - `X-Care-Signature`: base64url Ed25519 signature over the string below
- The signed string, lines joined with `\n`:

  ```
  craftish-care-v1
  POST
  <host, lowercase, no port unless non-default>
  /craftish-care/v1/<endpoint>
  <X-Care-Key>
  <X-Care-Time>
  <X-Care-Nonce>
  <hex SHA-256 of the exact body bytes>
  ```

  The host binds a request to one site, so a request captured from one site can't be replayed at another. The plugin compares it with the host of its own `home_url()`, and the route with the route it was called on, whichever URL form reached it.

## Checks, in this order (the plugin refuses at the first failure)

1. All four headers present and well formed. → `400 malformed`
2. Key id known. → `401 unknown_key`
3. Key allowed for this endpoint (table below). `401 wrong_key`: the report key can never update.
4. Time within 300 seconds of the site's clock. → `401 stale`
5. Signature valid over the string built from **the request as received**. → `401 bad_signature`
6. Nonce not seen before: stored as an option `craftish_care_n_<sha256(nonce)>` (autoload off) by `INSERT IGNORE`, so the option table's unique key lets exactly one of two racing requests in. Not `add_option`: it inserts with `ON DUPLICATE KEY UPDATE`, so both could succeed (found in the M3 build). Nonces older than 15 minutes are swept by WP-Cron and also on each request, since some sites run with cron off. → `401 replay`
7. Host matches `home_url()`. → `401 wrong_host`

Before the checks, and not counted as refusals: anything under the namespace that isn't a `POST` to an endpoint in the table → `404 not_found`; the rate limit's block → `429 rate_limited`; after `disconnect` → `410 disconnected`. A plain-HTTP request where `WP_ENVIRONMENT_TYPE` isn't `local` → `403 https_required`, which is counted. The plugin handles its namespace in `rest_pre_dispatch`, so none of WordPress's own REST handling (parameter parsing, its JSON errors, the route index) runs first.

Only after all seven does the endpoint read the body: it must be a JSON object, else `400 bad_body`. Every refusal is logged (below). More than 20 refusals in a minute → `429` for 10 minutes, without checking signatures. Error bodies are `{"error": "<code>"}` and never echo input.

## Endpoints

| Endpoint     | Key    | Does                                                                                                                                                                                                                        |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`      | report | Who and what: plugin, WordPress and PHP versions; multisite (not supported in v1, reported); capabilities (below)                                                                                                           |
| `report`     | report | The inventory (below). `{"refresh": true}` reruns WordPress's own update checks first, at most once per 10 minutes                                                                                                          |
| `status`     | report | One job's state: `{"job": "<id>"}`                                                                                                                                                                                          |
| `update`     | update | Start one update job                                                                                                                                                                                                        |
| `disconnect` | update | Delete the stored keys and every nonce; the plugin answers `410 disconnected` to everything after, including after deactivating and activating it again. Reconnecting means deleting the plugin and installing a fresh copy |

### Capabilities (`hello`)

`can_update`, with `update_blockers` listing the reasons when false (codes: `below_floor`, `file_mods_disallowed`, `filesystem_not_direct`, `plugins_not_writable`, `themes_not_writable`, `core_not_writable`): `DISALLOW_FILE_MODS` set, `get_filesystem_method()` not `direct` (it needs FTP or SSH credentials the plugin will never hold), the plugin, theme or core directory not writable, or below the floor (WordPress 6.6, PHP 8.1). Also: auto-updates allowed by the host, `.maintenance` present and its age, WP-Cron disabled, and whether loopback requests work (Site Health's own test).

### The report

Core (installed, offered updates with version and locale), every plugin (file, slug, name, version, active, auto-update on or off, offered version if any, and whether the offer has a package: a paid plugin with no licence offers a version but no package), every theme (likewise, plus which is active and its parent), from 0.2.0 every must-use plugin (`mu_plugins`: file, name and version from the header of each top-level file in `wp-content/mu-plugins`, as `get_mu_plugins()` reads them; listed only, since WordPress never updates them; absent before 0.2.0, which Kamaji shows as unknown, never as none), PHP and database versions, the last time WordPress checked for updates, and Site Health's critical direct tests. Nothing else: no users, options, content or file lists.

### Update jobs

Request:

```json
{
  "job": "8b1f6e3c-…",
  "type": "plugin",
  "item": "advanced-custom-fields-pro/acf.php",
  "from": "6.3.1",
  "to": "6.3.2"
}
```

`type` is `core`, `plugin` or `theme`; `item` is `core`, the plugin file or the theme stylesheet.

- **One item per job.** Kamaji runs the checks between items, so one item at a time is all it needs, and it keeps the plugin simple.
- **Idempotent by job id.** The same job id again returns that job's state and never starts a second run. Kamaji generates ids and stores them before sending.
- The plugin refuses with `409 version_changed` unless `from` is what's installed and `to` is exactly what WordPress's own update data offers right now, and `409 no_package` when the offer has no package. It never takes a version, URL or package from the request: Kamaji names a version, the plugin checks it against WordPress's offer, and WordPress's upgrader fetches it.
- The same id with a different item or versions is `409 job_id_reused`.
- One job at a time per site (`409 busy`), with a lock that expires after 15 minutes.
- Answer `202 {"job": …, "state": "queued"}` straight away, then run in the same PHP process once the answer has gone: `fastcgi_finish_request()` (PHP-FPM) or `litespeed_finish_request()` closes the connection and the job carries on, with `ignore_user_abort`. No WP-Cron event and no loopback request, so `DISABLE_WP_CRON` and blocked loopbacks don't matter (tested on DDEV with `DISABLE_WP_CRON` set). Where neither function exists, the job runs before the answer is sent: Kamaji's request waits, or times out and asks for the status.
- Runs through WordPress's own upgrader classes with a silent skin, so WordPress's temporary backup and rollback apply: `Plugin_Upgrader::bulk_upgrade()` and `Theme_Upgrader::bulk_upgrade()` with one item (unlike `upgrade()`, bulk keeps an active plugin active, as WordPress's Updates screen does), and `Core_Upgrader::upgrade()`.
- **While it runs the site is in maintenance mode**, as with WordPress's own Updates screen: every request, `status` included, gets WordPress's `503` "Briefly unavailable" page. Kamaji reads a 503 during a job as "still running", never as a failure, until the job's timeout.
- `status` states: `queued`, `running`, `succeeded`, `failed`. A result has the installed version read back from disk after the run, an error code if any (the upgrader's, or `version_not_changed`, or `interrupted` for a run whose lock expired or vanished while it was still marked queued or running), a short message in fixed words, and whether `.maintenance` was left behind. The last 20 jobs are kept.
- The site's log records each job queued and finished, with the item and versions.

### Self-update

From 0.2.0, Craftish Care updates itself through WordPress's own update path, never through a request:

- Its `Update URI` header is `https://care.craftish.dev/craftish-care/`, so WordPress never confuses it with a wordpress.org plugin, and asks that channel during its usual update checks (`update_plugins_care.craftish.dev`).
- The channel's `info.json`: `version`, `package` (a zip under the same channel), `sha256` (the zip's, hex), `key` (the release key's id) and `signature`: Ed25519 over `craftish-care-release-v1\n<version>\n<sha256>`, base64. The plugin offers the release only when the signature checks out against its stored release key and the version is newer than its own.
- Before WordPress installs the package (`upgrader_pre_download`), the plugin downloads it itself and refuses it (`craftish_care_bad_package`) unless its SHA-256 matches the signed one. Any package for Craftish Care that isn't that exact signed one is refused too.
- WordPress's automatic updates are off for it: Kamaji updates it with an ordinary `update` job, like any plugin, once WordPress offers the release.
- A release carries no site's keys file. Built on the laptop by `scripts/care-release.mjs` with the release key from Doppler; every release goes to the DDEV site first, then aleyahoerlein.com alone, then the rest, since a release that breaks the plugin can only be fixed over SFTP.

The plugin's answer is evidence, not the verdict: Kamaji's checks after the job decide the outcome (`../kamaji.md`, "Updating, end to end").

## Never

No endpoint, option or hook for: uploading or fetching a zip, URL or code (the one exception is its own signed releases, from the channel fixed in its code: "Self-update"; nothing in a request ever names a package, URL or version beyond the `to` checked against WordPress's offer); installing, activating, deactivating or deleting anything; users or roles; editing files; changing settings (auto-update flags come later, for Rules, as their own endpoint behind the update key); exporting the database or files (backups, if they come, get a separate capability, key and the client's switch: `../kamaji.md`, "Backups as a service"). A request for something not in the table is `404`.

## What it stores

Only its own options. The two request keys are autoloaded; everything else (the release key, the last verified release, the jobs and their lock, nonces, the log, the rate-limit counter, the last refresh time) is stored with autoload off, so it never weighs on the site's page loads. Uninstalling deletes all of it and its cron event.

## The site's own log

The last 200 entries (time, endpoint, key id, result; for updates the item and versions) in an option, shown read-only under Tools → Craftish Care, along with what the plugin can and can't do in plain words. That page is the client's view of what Tyler's tool did on their site, and needs `manage_options`. Entries are events only: never a request body, header value or IP address.

## Tests the plugin ships with

In `plugin/tests/`, run by `npm run test:plugin` against the local DDEV WordPress (`dev/README.md`). `updates.test.ts` runs with `DISABLE_WP_CRON` set throughout: a job answered at once and run after the answer, keeping the plugin active; one job at a time, and a 15-minute-old lock no longer blocking; the same id answered with its state, never a second run; a run that died reported as `interrupted`. Self-update from a local channel: the release key stored apart from the request keys; a tampered zip refused; an unsigned or older release never offered; a signed one installed by an ordinary job, the keys kept, and no keys file left.

One per refusal: missing header, unknown key, report key on `update` and `disconnect`, old and future timestamps, a body changed after signing, the host or route changed after signing, a reused nonce, two concurrent requests with the same nonce, a job id reused, a `to` that isn't WordPress's offer, a `from` that isn't installed, a second job while one runs, the rate limit, and every endpoint after `disconnect`. Plus the happy paths against a DDEV WordPress site, and a site with `FS_METHOD` set to `ftpext` and one with `DISALLOW_FILE_MODS`, which must report `can_update: false` with the right reason.
