# kamaji-report

One fixed command on a Linux server that prints a JSON health report: pending packages (each with its from and to versions and origin, security first, at most 300, with the full count), whether a restart is needed and since when, failed and stopped services, disks, memory, load, uptime, OS release and PHP versions. Kamaji on molcajete runs it every 5 minutes over SSH with a key that can do nothing else (`packages/server/src/checks/serverReport.ts` parses it).

- **Reads only.** No sudo, no apt update, no input: the forced command ignores whatever the client asks to run.
- **Its own user,** `kamaji-report`, a system user with no password, holding only Kamaji's key.
- **The key** is `restrict`ed (no shell, terminal, forwarding or `~/.ssh/rc`) and accepted only from molcajete's tailnet address (`100.106.213.63`), so a copied key is useless elsewhere.
- **Format 2** (TY-167). Security means a `-security` suite that isn't Ubuntu Pro's ESM; ESM packages are listed for information only. Kamaji rates the updates (`packages/server/src/checks/serverUpdates.ts`) and still reads format 1. The apt parsing sits between `BEGIN upgradable` and `END upgradable` so `kamajiReport.test.ts` can run it against craftish's real `apt list --upgradable` (`packages/server/src/checks/fixtures/apt-upgradable.craftish.txt`, 2026-11-13).
- **Apache** is watched only so Kamaji knows whether Apache's security updates face the internet; installed and stopped isn't a problem.
- **Not reported:** certificates on disk, which only the root user can read. The tailnet sites' Let's Encrypt certificates are the ones that expire, and Kamaji reads those from the mini as a browser would.

## The authorized_keys line

In `/var/lib/kamaji-report/.ssh/authorized_keys` on the server, with molcajete's public key (`~/.ssh/kamaji-report.pub` on the mini) in place of the last part:

```
restrict,command="/usr/local/bin/kamaji-report",from="100.106.213.63" ssh-ed25519 AAAA… kamaji-report@molcajete
```

## Installing on craftish

The numbered steps are in Kamaji's runbook, `ops/README.md`, "craftish's report". To change the script later, see "Updating the script" there; Kamaji reads the new output on its next cycle. Change `serverReport.ts` in the same commit if a field changes, and bump `format`.
