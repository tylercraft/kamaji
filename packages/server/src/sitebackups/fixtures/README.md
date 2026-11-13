# restic fixtures

**Written from restic's documentation, not captured.** The shapes follow "Scripting" in restic's docs (`restic.readthedocs.io/en/stable/075_scripting.html`, read 2026-11-13): `backup --json` prints `status` lines and one `summary` line; `snapshots --json` prints one array; `stats --json` prints one object. The values are made up.

Replace them with real output from the mini once the repository has a snapshot (Tyler's step 22 in `ops/backups-plan.md`), and keep the tests passing: Kamaji's rule is to parse captured output, never guessed output.
