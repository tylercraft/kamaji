#!/bin/zsh
# On molcajete: bring Kamaji up to date with main and restart it. Runbook: ops/README.md.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin

label=dev.craftish.kamaji
login=$(plutil -extract EnvironmentVariables.KAMAJI_LOGIN raw ~/Library/LaunchAgents/$label.plist)

# The running process's startedAt from /api/status, or nothing while it isn't answering.
started() {
  curl -fsS -m 2 -H "Tailscale-User-Login: $login" http://127.0.0.1:10002/api/status 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(JSON.parse(s).startedAt)}catch{}})' ||
    true
}

cd ~/kamaji
git pull --ff-only
npm ci --no-audit --no-fund
KAMAJI_DEPLOY=1 npm run build

before=$(started)
t0=$(date +%s)
launchctl kickstart -k gui/$(id -u)/$label
# Up means a new process answering: its startedAt differs from the one before the restart.
while true; do
  now=$(started)
  if [[ -n $now && $now != "$before" ]]; then
    print -r -- "restarted in $(( $(date +%s) - t0 )) s; Kamaji started at $now"
    exit 0
  fi
  if (( $(date +%s) - t0 >= 60 )); then
    print -u2 -r -- "DEPLOY FAILED: Kamaji isn't answering /api/status 60 s after the restart."
    print -u2 -r -- "Look at: tail -n 50 ~/Library/Logs/kamaji.log"
    exit 1
  fi
  sleep 1
done
