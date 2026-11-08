# Running Kamaji on molcajete

One Node process under the LaunchAgent `dev.craftish.kamaji`: the app, the check runner and the 5-minute cycle. It listens on `127.0.0.1:10002`; `tailscale serve` puts it on the tailnet at `https://molcajete.tailb3044a.ts.net:10002`. Every request must carry serve's `Tailscale-User-Login` header equal to `KAMAJI_LOGIN` (in the plist), as the Calcifer dashboard does. Built on the laptop, run on the mini.

- **Code:** `~/kamaji` on the mini, a clone of `tylercraft/kamaji`.
- **Records:** `~/kamaji/data/kamaji.db` (SQLite, WAL), mode 700 folder, gitignored. Not backed up yet: it joins the cold backup (`calcifer/explore/cold-backup.md`).
- **Log:** `~/Library/Logs/kamaji.log`: startup, one line per request (method, path, status; no headers), job failures. Never a secret.
- **Secrets:** Doppler project `kamaji`. The app runs under the `checker` config's service token, scoped to `~/kamaji`. In M1 that's only `HEALTHCHECKS_PING_URL`. The `updater` config (M4) is never in this process.
- **Heartbeat:** after every cycle Kamaji pings `HEALTHCHECKS_PING_URL` (a cycle that fails pings `/fail`). When the pings stop, healthchecks.io emails and posts to Discord. The header and Overview show "Heartbeat off" while the URL isn't set.

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
