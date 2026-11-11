# kamaji-watch, the outside checks

A Cloudflare Worker on a 5-minute cron. It makes the same home page check the mini makes (status, expected text, PHP error text) from Cloudflare's network, and posts to `#kamaji` itself after two failures running and again when the site is back, so a site going down is noticed even when the mini is dark. Kamaji sends it the public sites (`PUT /v1/sites`) and pulls the results (`GET /v1/results`) each cycle, both with a bearer token. While it's running, the Worker announces public sites going down and Kamaji doesn't; if it goes quiet for 20 minutes, Kamaji raises an urgent issue and alerts for the sites itself.

- **State:** one KV key, written once per pass (288 writes a day, under the free plan's 1,000). Each site keeps a day of results.
- **Secrets** (`wrangler secret put`): `KAMAJI_TOKEN` (the same value as `KAMAJI_WORKER_TOKEN` in Doppler `kamaji/checker`) and `DISCORD_WEBHOOK_URL` (a copy of the one in Doppler). Var: `KAMAJI_URL`, the link in messages.
- **Deployed from the laptop** with a Cloudflare API token, never from the mini. `wrangler` lives only in this folder's `package.json`, outside the npm workspaces, so the mini never installs it.
- **Release channel:** on `care.craftish.dev`, a custom domain on the Worker, it serves `channel/` as static files: Craftish Care's signed `info.json` and zips under `/craftish-care/` (`docs/protocol.md`, "Self-update"). Cloudflare serves them before the Worker's code runs; anything else on that host is a plain 404, so the API answers only on the `workers.dev` address. Releases are built on the laptop by `scripts/care-release.mjs` into `channel/craftish-care/`, committed, and go live with the next deploy. Old zips stay; `info.json` names the current one.
- **Tests:** `watch.test.js`, run by the root `npm run check`. Locally: `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` runs a pass (put `KAMAJI_TOKEN=…` in a gitignored `.dev.vars`).

## The Cloudflare API token

An account-owned token on the Craftish account (dash.cloudflare.com → Manage account → Account API tokens):

- Workers Admin
- Workers KV Storage Write
- Account Settings Read
- Zone → Workers Routes → Edit, and Zone → DNS → Edit, for `craftish.dev` only (the release channel's custom domain, from M4)

Account-owned tokens have no user permissions, so wrangler can't look the account up itself: `account_id` is set in `wrangler.toml` (not a secret). The token lives in Doppler, project `kamaji`, config `deploy`, as `CLOUDFLARE_API_TOKEN` (with `CLOUDFLARE_ACCOUNT_ID`). Only the laptop reads that config: the mini's config, `checker`, never holds Cloudflare credentials, so a compromised mini can't redeploy or change the Worker. The API is served on the `workers.dev` address; the zone permissions are only for `care.craftish.dev`.

## Deploy

From the laptop, in this folder (linked to `kamaji/deploy` with `doppler setup`):

1. `cd /Users/tyler/kamaji/worker`
2. `/usr/bin/git pull --rebase`
3. `doppler run -- npx wrangler deploy`

Doppler passes the token to wrangler for that one command; it's never exported or typed in. The output lists the `workers.dev` address, `care.craftish.dev` and the cron. Secrets and the KV data carry over between deploys.
