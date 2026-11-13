# restic fixtures

- **`snapshots.json` and `stats.json` are real output,** captured on molcajete on 2026-11-13 from restic 0.19.1 after firstandlastrecords.com's first whole-site backup: `restic snapshots --json` and `restic stats --json --mode raw-data` (`ops/README.md`, "Whole-site backups", step 32). Ids, sizes and times only, no secrets.
- **`backup.jsonl` is still written from restic's docs,** not captured: "Scripting" (`restic.readthedocs.io/en/stable/075_scripting.html`, read 2026-11-13) says `backup --json` prints `status` lines and one `summary` line. Its values are made up. The live backup on 2026-11-13 parsed its real summary, so the shape holds; replace it with a captured one when there's a reason to run `restic backup --json` by hand.

Kamaji's rule is to parse captured output, never guessed output: when restic is upgraded and its answers change, capture them again and keep the tests passing by fixing the parser, not the fixtures.
