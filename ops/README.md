# Running Kamaji on molcajete

One Node process under the LaunchAgent `dev.craftish.kamaji`: the app, the check runner and the 5-minute cycle. It listens on `127.0.0.1:10002`; `tailscale serve` puts it on the tailnet at `https://molcajete.tailb3044a.ts.net:10002`. Every request must carry serve's `Tailscale-User-Login` header equal to `KAMAJI_LOGIN` (in the plist), as the Calcifer dashboard does. Built on the laptop, run on the mini.

- **Code:** `~/kamaji` on the mini, a clone of `tylercraft/kamaji`.
- **Records:** `~/kamaji/data/kamaji.db` (SQLite, WAL), mode 700 folder, gitignored. Not backed up yet: it joins the cold backup (`calcifer/explore/cold-backup.md`).
- **Log:** `~/Library/Logs/kamaji.log`: startup, one line per request (method, path, status; no headers), job failures. Never a secret.
- **Secrets:** Doppler project `kamaji`, config `checker`, whose service token is scoped to `~/kamaji`. The `updater` config (M4) is never in this process. Names only here, never values:
  - `HEALTHCHECKS_PING_URL`: the healthchecks.io check's ping URL.
  - `DISCORD_WEBHOOK_URL`: the `#kamaji` channel's webhook. The Worker keeps its own copy in Cloudflare's secrets.
  - `KAMAJI_WORKER_URL` and `KAMAJI_WORKER_TOKEN`: the Worker's `workers.dev` address and the bearer token it expects (`worker/README.md`). Outside checks are off until both are set.
  - `WORDFENCE_API_KEY`: the Wordfence Intelligence v3 feed key (wordfence.com, Integrations). Without it, vulnerabilities show as unknown, never as none.
  - `KAMAJI_CARE_REPORT_KEY`: the base64 seed of craftish-care's report key (`docs/protocol.md`), with `KAMAJI_CARE_UPDATE_PUBLIC_KEY`, the update key's public half (not secret, but kept beside it), and optionally `KAMAJI_CARE_REPORT_KEY_ID` and `KAMAJI_CARE_UPDATE_KEY_ID` (defaults `r1`, `u1`). Made once, on the laptop, by `node scripts/care-keys-doppler.mjs`, which sends each half straight into Doppler and refuses to replace one; until they're set, Add site offers monitoring only. The update key's private half is never in `checker`: it's `KAMAJI_CARE_UPDATE_KEY` in the `updater` config, which only the updater reads ("The updater" below). That config also holds copies of `KAMAJI_CARE_REPORT_KEY` (the updater asks for status and reports with it), `KAMAJI_WORKER_URL` and `KAMAJI_WORKER_TOKEN` (it pauses a site's outside check during its run), and optionally `KAMAJI_BACKUP_SSH_KEY` (default `~/.ssh/kamaji-backup`). `KAMAJI_CARE_RELEASE_PUBLIC_KEY` (and optionally `KAMAJI_CARE_RELEASE_KEY_ID`, default `p1`) is the release key's public half, built into each site's zip from Craftish Care 0.2.0; `node scripts/care-keys-doppler.mjs --release` makes it.
- **Release secrets:** Doppler project `kamaji`, config `release`, read only on the laptop, never the mini. Names only:
  - `KAMAJI_CARE_RELEASE_KEY`: the base64 seed of the release key, which signs Craftish Care's packages for its self-update channel (`docs/protocol.md`, "Self-update"). Used by `scripts/care-release.mjs`.
- **Deploy secrets:** Doppler project `kamaji`, config `deploy`, read only on the laptop, where `~/kamaji/worker` is linked to it. The mini never has it, and `checker` never holds Cloudflare credentials. Names only:
  - `CLOUDFLARE_API_TOKEN`: the account-owned token wrangler deploys the Worker with (`worker/README.md`).
  - `CLOUDFLARE_ACCOUNT_ID`: the Craftish account.
- **Settings** (in the plist, not secret): `KAMAJI_LOGIN`; optionally `KAMAJI_URL` (the link in messages, default `https://molcajete.tailb3044a.ts.net:10002`) and `KAMAJI_DIGEST_AT` (default `07:30`, Christchurch time).
- **Heartbeat:** after every cycle Kamaji pings `HEALTHCHECKS_PING_URL` (a cycle that fails pings `/fail`). When the pings stop, healthchecks.io emails and posts to Discord. The header and Overview show "Heartbeat off" while the URL isn't set.
- **Checks:** every 5 minutes, one GET to each site's home page (status, response time, expected text, PHP error text) and a TLS handshake for its certificate. Two failures in a row open a "down" issue; the next pass resolves it. A certificate with 14 days left opens an issue, urgent at 7. If every site fails at once, Kamaji blames the mini's connection instead.
- **Inventory** (`packages/server/src/inventory/`): each connected site's craftish-care `report`, signed with the report key, once an hour; once a day it also has WordPress rerun its own update checks first. Then each installed plugin's slug, and only the slug, goes to `api.wordpress.org`'s plugins API once a day (20 per cycle), to find plugins closed there. A closed plugin opens an issue per site: urgent when closed for a security issue, else for the digest; the Discord line names the site and the reason, never the plugin. A day without a good report opens a normal issue; the last good inventory stays on show, marked with its age.
- **Vulnerabilities** (`packages/server/src/wordfence/`): once a day the whole Wordfence Intelligence v3 production feed is downloaded with `WORDFENCE_API_KEY` to `data/wordfence-production.json` (it sends nothing about the sites; a failed download retries after 6 hours, since the feed is rate-limited), stored in the database, and matched every cycle against each site's inventory. A component with a known vulnerability opens one issue per site: urgent when a fix exists, else for the digest, worded without naming the component. Data older than two days, or none, opens a normal issue and shows as unknown or stale on each site.
- **End of life** (`packages/server/src/endOfLife/`): each connected site's PHP and database release line against a list kept by hand in `list.ts` (php.net, MariaDB's maintenance policy, Oracle's MySQL EOL notice), with the date it was last checked. A line within 90 days of the end of its security support, or past it, opens a digest issue naming the version and the date, never an urgent one. A line not on the list shows as unknown. The list itself opens a digest issue once it's 6 months since it was checked: recheck the sources, update the dates and `checked`, and deploy.
- **molcajete** (`packages/server/src/molcajete/`): read locally each cycle, read-only, with full paths: `launchctl list` and `launchctl print gui/501/<label>` for every `dev.craftish.*` job (plus the plist names in `~/Library/LaunchAgents`, and for calendar jobs only the `StartCalendarInterval` key, through `plutil -extract`, shown as written in the mini's local time), `mount` and `diskutil info -plist` for the internal drive, Respaldo and Palomitas, `/usr/local/bin/docker version` and `ps --all`, the Tailscale app's `status --json` (with `TAILSCALE_BE_CLI=1`, the one variable added to the plain environment, or it tries to start its GUI), `sysctl -n kern.boottime`, repo-pull's log, and Calcifer's crash log (`docs/crash-hook.md`). `softwareupdate --list` runs every 6 hours, since it asks Apple. A reader that fails says why on the Servers page: the exit code and stderr's first line. Log tails are opened only for the allowlisted jobs (`molcajete/jobs.ts`), and only when the Servers page asks; crash messages and tracebacks are never stored.
- **molcajete's issues:** urgent for an always-running job stopped, an external disk unmounted, a disk at 95%, SMART not verified, Tailscale not running (most held two cycles first) and a new crash group. Normal for a failed run, a job installed but not loaded, a disk at 85%, an external read-only, Docker not answering or a container not running well, Tailscale's own warnings, a restart in the last day, repo-pull failing for half an hour, macOS updates waiting a week, and a reader failing three cycles running. A crash group alerts once, with no reminders or resolved line, and closes after 7 days without a crash.
- **Alerts:** urgent issues go to `#kamaji` at once, grouped into one message per cycle, with a "Resolved" line when they clear and a reminder every 24 hours while open. Everything else waits for the morning digest, sent only when there's something in it. Labels and a link only. The header shows "Alerts off" while the webhook isn't set.

## First install (Tyler, on the mini)

Assumes M0: Node from Homebrew, the repo cloned to `~/kamaji`, and the `kamaji` Doppler project with a `checker` config holding `HEALTHCHECKS_PING_URL`. Set the healthchecks.io check's period to 5 minutes and its grace to 10.

1. Give `~/kamaji` the checker token, pasted at the silent prompt:

```
read -rs T && doppler configure set token "$T" --scope ~/kamaji && unset T
```

2. Build:

```
cd ~/kamaji && npm ci && npm run build
```

3. Install and start the LaunchAgent:

```
cp ~/kamaji/ops/dev.craftish.kamaji.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/501 ~/Library/LaunchAgents/dev.craftish.kamaji.plist
```

4. Check it's listening and refusing strangers (expect `403` twice, then `200`):

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10002/api/status
```

```
curl -s -o /dev/null -w '%{http_code}\n' -H 'Tailscale-User-Login: someone@example.com' http://127.0.0.1:10002/api/status
```

```
curl -s -o /dev/null -w '%{http_code}\n' -H 'Tailscale-User-Login: tylercraft@github' http://127.0.0.1:10002/api/status
```

5. Put it on the tailnet:

```
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=10002 http://127.0.0.1:10002
```

6. From the laptop, a forged header must still get in as you, proving serve replaced it (expect `200`; a `403` means serve passed the forgery through: take the serve down and don't use Kamaji until that's fixed):

```
curl -s -o /dev/null -w '%{http_code}\n' -H 'Tailscale-User-Login: someone@example.com' https://molcajete.tailb3044a.ts.net:10002/api/status
```

7. Open `https://molcajete.tailb3044a.ts.net:10002`. The header should say "Cycle on time" and "Heartbeat ok" within a minute, and healthchecks.io should show the check as up.

Also add `molcajete:10002` to the tailnet ACL's `tests` block beside the dashboard's `10000` (Tyler's login reaches it, Johan's doesn't).

## craftish's report

Kamaji reads craftish through `kamaji-report` (`server-report/README.md`) over SSH, as the `kamaji-report` user, at craftish's tailnet address. Until these steps are done, Servers says "No SSH key on the mini yet", and after three cycles the morning digest mentions it.

On the mini:

1. Make Kamaji's key (no passphrase: the LaunchAgent can't type one):

```
/usr/bin/ssh-keygen -t ed25519 -N '' -C kamaji-report@molcajete -f /Users/tylercraft/.ssh/kamaji-report
```

2. Show the public key, to paste in step 6:

```
/bin/cat /Users/tylercraft/.ssh/kamaji-report.pub
```

On the laptop:

3. Copy the script up:

```
/usr/bin/scp /Users/tyler/kamaji/server-report/kamaji-report craftish:/tmp/kamaji-report
```

On craftish (`ssh craftish`):

4. Install it, owned by root:

```
sudo install -m 755 -o root -g root /tmp/kamaji-report /usr/local/bin/kamaji-report && rm /tmp/kamaji-report
```

5. Make its user:

```
sudo adduser --system --group --home /var/lib/kamaji-report --shell /bin/sh kamaji-report
```

6. Give it the key, with the line from `server-report/README.md` (paste the whole line between the quotes, with step 2's key at the end):

```
sudo install -d -m 700 -o kamaji-report -g kamaji-report /var/lib/kamaji-report/.ssh && echo 'PASTE-THE-LINE-HERE' | sudo tee /var/lib/kamaji-report/.ssh/authorized_keys && sudo chown kamaji-report: /var/lib/kamaji-report/.ssh/authorized_keys && sudo chmod 600 /var/lib/kamaji-report/.ssh/authorized_keys
```

7. Check sshd will let that user in (if this prints an `allowusers` or `allowgroups` line, add `kamaji-report` to it and reload sshd):

```
sudo sshd -T | grep -i -E '^(allowusers|allowgroups|denyusers)'
```

8. Run the report as that user (expect JSON beginning `{"format":1`):

```
sudo -u kamaji-report /usr/local/bin/kamaji-report | head -c 300
```

9. Note craftish's host key fingerprint, for step 11:

```
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the mini:

10. Record craftish's host key for Kamaji:

```
/usr/bin/ssh-keyscan -t ed25519 100.77.122.31 > /Users/tylercraft/.ssh/kamaji_known_hosts
```

11. Check it matches step 9's fingerprint (if it doesn't, delete the file and stop):

```
/usr/bin/ssh-keygen -lf /Users/tylercraft/.ssh/kamaji_known_hosts
```

12. Read the report as Kamaji will (expect JSON):

```
/usr/bin/ssh -i /Users/tylercraft/.ssh/kamaji-report -o IdentitiesOnly=yes -o UserKnownHostsFile=/Users/tylercraft/.ssh/kamaji_known_hosts -T kamaji-report@100.77.122.31 | head -c 300
```

13. Check the key can't do anything else: asking for a shell command still prints the report, not `uid=…`:

```
/usr/bin/ssh -i /Users/tylercraft/.ssh/kamaji-report -o IdentitiesOnly=yes -o UserKnownHostsFile=/Users/tylercraft/.ssh/kamaji_known_hosts -T kamaji-report@100.77.122.31 id | head -c 100
```

Kamaji picks it up on its next cycle; no restart needed.

## The updater

A second LaunchAgent, `dev.craftish.kamaji-updater` (`ops/dev.craftish.kamaji-updater.plist`), runs approved batches (`packages/server/src/updater/`) and exits. The app starts it with `launchctl kickstart` when a batch is approved (`KAMAJI_UPDATER=launchd` in the app's plist), and again each cycle while a batch has work left, so a restart mid-run is reconciled. It runs under Doppler's `updater` config, scoped to `~/.kamaji-updater`, so the update key is in that process only; the app never has it. Same macOS user for now; a separate user is in M6's plan. It logs to `~/Library/Logs/kamaji-updater.log`.

While it updates a site, it pauses that site's uptime alerts on both paths: the mini's checks skip it (`sites.updating_until`, renewed as it goes, so it lapses by itself if the updater dies), and it sends the Worker the list without that site at once. After the site's run it sends the full list again, has the Worker check that site straight away (`POST /v1/check/<id>`), and re-checks it from the mini.

Not yet: these steps run with M4's release, after the Worker with the release channel is deployed.

In Doppler (the laptop):

1. Copy the three values the updater needs from `checker` into `updater`, straight from one to the other (nothing is shown; run each):

```
/opt/homebrew/bin/doppler secrets get KAMAJI_CARE_REPORT_KEY --plain --project kamaji --config checker | /opt/homebrew/bin/doppler secrets set KAMAJI_CARE_REPORT_KEY --project kamaji --config updater --silent > /dev/null
```

```
/opt/homebrew/bin/doppler secrets get KAMAJI_WORKER_URL --plain --project kamaji --config checker | /opt/homebrew/bin/doppler secrets set KAMAJI_WORKER_URL --project kamaji --config updater --silent > /dev/null
```

```
/opt/homebrew/bin/doppler secrets get KAMAJI_WORKER_TOKEN --plain --project kamaji --config checker | /opt/homebrew/bin/doppler secrets set KAMAJI_WORKER_TOKEN --project kamaji --config updater --silent > /dev/null
```

2. Check the names (expect the three above and `KAMAJI_CARE_UPDATE_KEY`, plus Doppler's own):

```
/opt/homebrew/bin/doppler secrets --only-names --project kamaji --config updater
```

3. In Doppler's dashboard, make a service token for `kamaji` → `updater` (read only), to paste in step 5.

On the mini:

4. Make the scope folder:

```
/bin/mkdir -p -m 700 /Users/tylercraft/.kamaji-updater
```

5. Give it the updater token, pasted at the silent prompt:

```
read -rs T && /opt/homebrew/bin/doppler configure set token "$T" --scope /Users/tylercraft/.kamaji-updater && unset T
```

6. Check the names it sees (expect the same as step 2):

```
/opt/homebrew/bin/doppler secrets --only-names --scope /Users/tylercraft/.kamaji-updater
```

7. Install the updater's LaunchAgent (loaded, not started):

```
/bin/cp /Users/tylercraft/kamaji/ops/dev.craftish.kamaji-updater.plist /Users/tylercraft/Library/LaunchAgents/ && /bin/launchctl bootstrap gui/501 /Users/tylercraft/Library/LaunchAgents/dev.craftish.kamaji-updater.plist
```

8. Install the app's plist again, with `KAMAJI_UPDATER=launchd`, and restart the app with it:

```
/bin/launchctl bootout gui/501/dev.craftish.kamaji && /bin/cp /Users/tylercraft/kamaji/ops/dev.craftish.kamaji.plist /Users/tylercraft/Library/LaunchAgents/ && /bin/launchctl bootstrap gui/501 /Users/tylercraft/Library/LaunchAgents/dev.craftish.kamaji.plist
```

9. Start the updater once by hand; with nothing approved it says so and exits (expect `nothing left to run`):

```
/bin/launchctl kickstart gui/501/dev.craftish.kamaji-updater && /bin/sleep 5 && /usr/bin/tail -n 3 /Users/tylercraft/Library/Logs/kamaji-updater.log
```

## craftish's database export

Before Kamaji updates a site on craftish, it has craftish export that site's database (`server-export/README.md`), as the `kamaji-backup` user, at craftish's tailnet address. The updater uses it before each run on a craftish site; Tyler runs these steps with the updater's. They follow "craftish's report" above.

On the mini:

1. Make the backup key (no passphrase: the updater can't type one):

```
/usr/bin/ssh-keygen -t ed25519 -N '' -C kamaji-backup@molcajete -f /Users/tylercraft/.ssh/kamaji-backup
```

2. Show the public key, to paste in step 10:

```
/bin/cat /Users/tylercraft/.ssh/kamaji-backup.pub
```

On the laptop:

3. Copy both scripts up:

```
/usr/bin/scp /Users/tyler/kamaji/server-export/kamaji-db-export /Users/tyler/kamaji/server-export/db-export craftish:/tmp/
```

On craftish (`ssh craftish`):

4. Install them, owned by root:

```
sudo install -m 755 -o root -g root /tmp/kamaji-db-export /usr/local/bin/kamaji-db-export && sudo install -D -m 755 -o root -g root /tmp/db-export /usr/local/lib/kamaji/db-export && rm /tmp/kamaji-db-export /tmp/db-export
```

5. The allowlist, with the one craftish site in the pilot:

```
sudo install -d -m 755 -o root -g root /etc/kamaji && echo aleyahoerlein.com | sudo tee /etc/kamaji/db-export.sites && sudo chmod 644 /etc/kamaji/db-export.sites
```

6. The folder the exports go in, readable by www-data only:

```
sudo install -d -m 700 -o www-data -g www-data /var/backups/kamaji
```

7. Make its user:

```
sudo adduser --system --group --home /var/lib/kamaji-backup --shell /bin/sh kamaji-backup
```

8. The one sudo rule, written to a file:

```
echo 'kamaji-backup ALL=(www-data) NOPASSWD: /usr/local/lib/kamaji/db-export' | sudo tee /etc/sudoers.d/kamaji-db-export && sudo chmod 440 /etc/sudoers.d/kamaji-db-export
```

9. Check sudo accepts it (expect `parsed OK`; if not, delete the file before anything else):

```
sudo visudo -cf /etc/sudoers.d/kamaji-db-export
```

10. Give the user the key, with the line from `server-export/README.md` (paste the whole line between the quotes, with step 2's key at the end):

```
sudo install -d -m 700 -o kamaji-backup -g kamaji-backup /var/lib/kamaji-backup/.ssh && echo 'PASTE-THE-LINE-HERE' | sudo tee /var/lib/kamaji-backup/.ssh/authorized_keys && sudo chown kamaji-backup: /var/lib/kamaji-backup/.ssh/authorized_keys && sudo chmod 600 /var/lib/kamaji-backup/.ssh/authorized_keys
```

11. Check sshd will let that user in (if this prints an `allowusers` or `allowgroups` line, add `kamaji-backup` to it and reload sshd):

```
sudo sshd -T | grep -i -E '^(allowusers|allowgroups|denyusers)'
```

12. Run an export as that user (expect `{"format":1,"ok":true,"site":"aleyahoerlein.com",…}`):

```
sudo -u kamaji-backup env SSH_ORIGINAL_COMMAND=aleyahoerlein.com /usr/local/bin/kamaji-db-export
```

13. Check it refuses a site off the list (expect `"problem":"not on the allowlist"`):

```
sudo -u kamaji-backup env SSH_ORIGINAL_COMMAND=example.com /usr/local/bin/kamaji-db-export
```

14. Check the export is there, and only www-data can read it:

```
sudo ls -l /var/backups/kamaji/aleyahoerlein.com
```

On the mini (craftish's host key is already in `kamaji_known_hosts`, from "craftish's report"):

15. Ask for an export as Kamaji will (expect the same JSON as step 12):

```
/usr/bin/ssh -i /Users/tylercraft/.ssh/kamaji-backup -o IdentitiesOnly=yes -o UserKnownHostsFile=/Users/tylercraft/.ssh/kamaji_known_hosts -T kamaji-backup@100.77.122.31 aleyahoerlein.com
```

16. Check the key can't do anything else: asking for a shell command is refused (expect `"problem":"not a site name"`, not `uid=…`):

```
/usr/bin/ssh -i /Users/tylercraft/.ssh/kamaji-backup -o IdentitiesOnly=yes -o UserKnownHostsFile=/Users/tylercraft/.ssh/kamaji_known_hosts -T kamaji-backup@100.77.122.31 id
```

## Deploying a change

On the mini, after the change is on `main`:

```
~/kamaji/ops/deploy.sh
```

It pulls, installs, builds and restarts. A cycle running at the restart is marked interrupted in Activity and isn't retried; the next one starts straight away.

## Stopping it

```
launchctl bootout gui/501/dev.craftish.kamaji
```

With it stopped, healthchecks.io alerts after the grace period. That's the M1 test: stop it, wait for the email, start it again (step 3's `bootstrap`). Take it off the tailnet with `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=10002 off`.
