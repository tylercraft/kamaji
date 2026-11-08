# Kamaji

Read `README.md` first: layout, commands, rules of the code. The product decisions are in `~/calcifer/explore/kamaji.md` (it wins over everything else), with `kamaji/plan.md` and `kamaji/protocol.md` beside it. Read the milestone you're on in `plan.md` before starting, and its Linear issue (project "Kamaji").

## Where you are

- **Laptop** (`/Users/tyler/kamaji`): Node, DDEV and PHP. Build and run freely (`npm run dev`).
- **molcajete** (`/Users/tylercraft/kamaji`): the same clone is what runs, under the LaunchAgent `dev.craftish.kamaji` (`ops/README.md`). Editing a file there changes nothing until a deploy, and it must stay that way:
  - Check work with `npm run check`. It writes nothing outside your edits.
  - Never `npm run build` or `npm run dev` there: the process serves `packages/web/dist` from disk and restarts into `packages/server/dist`. `scripts/guard.mjs` refuses both wherever the LaunchAgent is installed.
  - Never restart, `launchctl` or deploy Kamaji yourself. Deploys are Tyler's step (`ops/deploy.sh`).
  - Never open `data/kamaji.db` for writing; read it with `sqlite3 -readonly` if you must.
- Either machine: `git pull --rebase` before working; both push to `main`.

## Before you push

- `npm run check` passes (Prettier, ESLint, TypeScript, tests).
- Small commits, one topic each, ending with the attribution line the harness gives.
- A new secret or environment variable goes in `ops/README.md` ("Secrets"), by name only, and Tyler adds it to Doppler.

## Never

- Put a secret, webhook URL, token or traceback in a log line, event, error message, the database or a commit. Discord gets labels and a link, never details: it's a third party.
- Send anything to a client site beyond the plain HTTP checks in `packages/server/src/checks/`. Updates are M4, through the updater only.
- Edit anything in `~/calcifer`. When a decision changes something there, tell Tyler; a Calcifer session makes the edit.
- Guess the format of a machine's output (launchctl, diskutil, SMART, logs). Parse captured fixtures in `packages/server/src/**/fixtures/`, and ask Tyler for one when it's missing.
