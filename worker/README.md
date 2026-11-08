# kamaji-watch, the outside checks

A Cloudflare Worker on a 5-minute cron. It makes the same home page check the mini makes (status, expected text, PHP error text) from Cloudflare's network, and posts to `#kamaji` itself after two failures running and again when the site is back, so a site going down is noticed even when the mini is dark. Kamaji sends it the public sites (`PUT /v1/sites`) and pulls the results (`GET /v1/results`) each cycle, both with a bearer token. While it's running, the Worker announces public sites going down and Kamaji doesn't; if it goes quiet for 20 minutes, Kamaji raises an urgent issue and alerts for the sites itself.

- **State:** one KV key, written once per pass (288 writes a day, under the free plan's 1,000). Each site keeps a day of results.
- **Secrets** (`wrangler secret put`): `KAMAJI_TOKEN` (the same value as `KAMAJI_WORKER_TOKEN` in Doppler `kamaji/checker`) and `DISCORD_WEBHOOK_URL` (a copy of the one in Doppler). Var: `KAMAJI_URL`, the link in messages.
- **Deployed from the laptop** with a Cloudflare API token, never from the mini. `wrangler` lives only in this folder's `package.json`, outside the npm workspaces, so the mini never installs it.
- **Tests:** `watch.test.js`, run by the root `npm run check`. Locally: `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` runs a pass (put `KAMAJI_TOKEN=…` in a gitignored `.dev.vars`).

## The Cloudflare API token

A custom token at dash.cloudflare.com → My Profile → API Tokens, restricted to Tyler's account, no zones:

- Account › Workers Scripts › Edit
- Account › Workers KV Storage › Edit
- Account › Account Settings › Read
- User › User Details › Read
- User › Memberships › Read

It lives on the laptop only, entered when deploying. The Worker is served on its `workers.dev` address, so it needs no zone or route permissions.
