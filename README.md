# Kamaji

Tyler's operations dashboard: keeps the WordPress sites he looks after, his servers and his own systems current, available and recoverable. Replaces MainWP. Runs on molcajete, reachable only on the tailnet.

The decisions live in calcifer, not here: `explore/kamaji.md` (the source of truth) and `explore/kamaji/plan.md` (milestones, repo shape, records). The plugin's contract is here, in `docs/protocol.md` (the working copy since 2026-11-09). Linear project "Kamaji", one issue per milestone.

## Layout

| Path              | What                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `packages/shared` | The API's contract: zod schemas for every response, shared by server and web  |
| `packages/server` | Node: HTTP API (Hono), job runner, check cycle, SQLite (`node:sqlite`)        |
| `packages/web`    | React + Vite + Emotion: the six tabs, built to static files the server serves |
| `worker`          | Cloudflare Worker: the outside checks and their alerts (`worker/README.md`)   |
| `server-report`   | `kamaji-report`, the read-only JSON report craftish runs for Kamaji's SSH key |
| `ops`             | The LaunchAgent, deploy script and runbook (`ops/README.md`)                  |

Still to come: `packages/mcp` (M5) and `plugin/craftish-care` (M3).

## Commands

Node 22.13 or later.

- `npm run dev`: server on `127.0.0.1:10002` (rebuilt on change, 60-second cycle) and Vite on `http://localhost:5173`. Vite's proxy adds the login header, standing in for tailscale serve.
- `npm run check`: Prettier, ESLint, TypeScript and the tests. Passes before every push. Writes nothing to `dist`, so it's safe anywhere, including on the mini.
- `npm run build`: what `ops/deploy.sh` runs on the mini. Refused by `scripts/guard.mjs` wherever Kamaji is installed, unless the deploy asks.

## Rules of the code

- **Unknown is never zero.** Anything Kamaji hasn't observed is `Known<T>` with `known: false` and a reason, and the UI says so. Never default a missing value to 0, "up" or "none".
- **Every response has a schema** in `packages/shared`. The server's return types come from it and the web app parses with it.
- **Jobs are rows.** Work goes through `jobs/store.ts` with a lease. A job whose process died is marked interrupted, never silently retried: its kind decides recovery.
- **No secrets in logs, errors, events or the database.** Secrets arrive as environment variables from `doppler run`.
- Times are integer milliseconds (UTC) in SQLite and ISO strings on the wire. Records are kept: mark removed or resolved, don't delete.
