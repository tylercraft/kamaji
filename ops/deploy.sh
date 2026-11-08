#!/bin/zsh
# On molcajete: bring Kamaji up to date with main and restart it. Runbook: ops/README.md.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin

cd ~/kamaji
git pull --ff-only
npm ci --no-audit --no-fund
KAMAJI_DEPLOY=1 npm run build
launchctl kickstart -k gui/$(id -u)/dev.craftish.kamaji
print -r -- "restarted; tail ~/Library/Logs/kamaji.log to watch it start"
