# kamaji-report

One fixed command on a Linux server that prints a JSON health report: pending packages (security, ESM and the rest), whether a restart is needed, failed and stopped services, disks, memory, load, uptime, OS release and PHP versions. Kamaji on molcajete runs it every 5 minutes over SSH with a key that can do nothing else (`packages/server/src/checks/serverReport.ts` parses it).

- **Reads only.** No sudo, no apt update, no input: the forced command ignores whatever the client asks to run.
- **Its own user,** `kamaji-report`, a system user with no password, holding only Kamaji's key.
- **The key** is `restrict`ed (no shell, terminal, forwarding or `~/.ssh/rc`) and accepted only from molcajete's tailnet address (`100.106.213.63`), so a copied key is useless elsewhere.
- **Not reported:** certificates on disk, which only the root user can read. The tailnet sites' Let's Encrypt certificates are the ones that expire, and Kamaji reads those from the mini as a browser would.

## The authorized_keys line

In `/var/lib/kamaji-report/.ssh/authorized_keys` on the server, with molcajete's public key (`~/.ssh/kamaji-report.pub` on the mini) in place of the last part:

```
restrict,command="/usr/local/bin/kamaji-report",from="100.106.213.63" ssh-ed25519 AAAA… kamaji-report@molcajete
```

## Installing on craftish

The numbered steps are in Kamaji's runbook, `ops/README.md`, "craftish's report". To change the script later, copy it up again (step 3 there); Kamaji reads the new output on its next cycle. Change `serverReport.ts` in the same commit if a field changes, and bump `format`.
