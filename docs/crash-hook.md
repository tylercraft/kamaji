# Calcifer's crash hook: what Kamaji reads

For M2's "errors from local jobs" (calcifer `explore/kamaji.md`, Servers). A Calcifer session adds the hook in calcifer's scripts; Kamaji only reads what it writes. Kamaji never edits calcifer.

## The hook

A small shared module in calcifer (for example `ops/molcajete/crash_hook.py`) that every Python entry point imports first and calls `install()`. It sets `sys.excepthook` and `threading.excepthook`, writes one record per uncaught exception, then hands over to the default hook so the traceback still reaches the job's log and the exit code stays non-zero. It must never raise: if writing fails, it gives up quietly.

**Where:** `/Users/tylercraft/Library/Logs/calcifer-crashes.jsonl`, mode 600, one JSON object per line, appended. When the file passes 5 MB the hook renames it to `calcifer-crashes.jsonl.1` (replacing any old one) before writing. Kamaji follows the rename.

**Each line:**

| Field       | What                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`         | `1`                                                                                                                                                                                        |
| `at`        | UTC time, ISO 8601 with `Z`                                                                                                                                                                |
| `job`       | the LaunchAgent label from `XPC_SERVICE_NAME` (launchd sets it), else the script's file name                                                                                               |
| `script`    | the entry script's path                                                                                                                                                                    |
| `pid`       | the process id                                                                                                                                                                             |
| `type`      | the exception's qualified name, e.g. `KeyError`, `urllib.error.HTTPError`                                                                                                                  |
| `where`     | the innermost frame inside the calcifer repo as `path/relative/to/calcifer.py:function` (no line number, so edits don't split a group); the innermost frame overall if none is in the repo |
| `line`      | that frame's line number, kept separately                                                                                                                                                  |
| `message`   | `str(exception)`, cut to 500 characters. **Allowlisted jobs only** (below); left out for every other job                                                                                   |
| `traceback` | the full formatted traceback, cut to 20,000 characters. **Allowlisted jobs only**; left out for every other job                                                                            |
| `frames`    | every job: the stack as a list of `{"file", "function", "line"}`, innermost last, `file` relative to calcifer where it's in the repo. No source text, no local values, no message          |

**The allowlist** (Tyler, 2026-11-09): jobs that never touch mail or untrusted text, so their messages and logs can't quote it: `hunt-*`, `repo-pull`, `echoocho-pull`, `echoocho-mirror`, `heartbeat`, `dashboard`, `dashboard-feed`, `desk-card`, `mini-status`, `update-stack`, `stack-at-login`, and Kamaji itself, matched on the label without its `dev.craftish.calcifer.` prefix. Triage, outbox, the today jobs, research, the phone threads (`*-rc`) and any job not listed get `type`, `where`, `line` and `frames` only. The list only widens by a commit.

Email text must never reach Kamaji's database. Where `message` and `traceback` are present, Kamaji keeps them on the mini, shows them only in its UI on the tailnet, and never sends them to Discord.

## What Kamaji does with it

- Groups crashes by `job` + `type` + `where`.
- One alert per new group: "triage crashed 3 times since 06:00", with a link. A group seen before stays quiet until it has gone 7 days without a crash.
- Beside it, from `launchctl`: each job's last exit code and last run. The log's tail (`~/Library/Logs/calcifer-<job>.log`, stdout and stderr together) only for allowlisted jobs; the others' logs are never opened.
- The reader treats `message` and `traceback` as optional, and drops them if they ever arrive for a job outside the allowlist.
