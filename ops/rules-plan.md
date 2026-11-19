# Rules plan

Rules approve routine updates on their own: Tyler writes a rule in Kamaji, and at the weekly update time Kamaji approves whatever matches it, the same way every time, and runs it through the updater with the usual backup, checks, screenshots and one site first (TY-171, decided 2026-11-14). For example: minor plugin updates on Tyler's own sites; security fixes on sites with a maintenance plan; never a major version, never core. Written 2026-11-19 for review. Nothing is built.

## Where this differs from what's written down

1. **Two directions are on record, and they don't agree.** `explore/kamaji.md` (2026-11-08) says the Rules tab starts as a view over WordPress's own per-plugin auto-updates, with Kamaji flipping WordPress's switch. TY-171 (2026-11-14) says Kamaji itself approves what a rule matches. I'd go with TY-171 and drop the WordPress switch, at least for now. WordPress's auto-updates run whenever WP-Cron gets to them, with no backup check, none of Kamaji's checks, no screenshots, no one site first, and a rollback only for a fatal error. Everything Kamaji has built since 2026-11-08 would be bypassed. The Rules tab can still show each site's auto-update flags (the report already has them) and warn when one is on for something a rule covers. Question 1.
2. **A rule needs its own kind of approval.** Today the updater runs nothing without a passkey proof over that exact batch's items (`passkeys/guard.ts`, `approvalProblem`). A rule batch has no such proof. So the passkey signs the rule instead, and the updater checks each item against the signed rule itself, from the database, before it runs anything. The app proposes; the updater decides. The details are under "The approval".
3. **"A client site with a maintenance plan" isn't something Kamaji knows.** Sites have `own` (Tyler's own) and `client_slug`, but no maintenance plan. Rules need a per-site flag for it. Question 4.
4. **The 2026-11-17 workflow has Tyler testing each site by hand after updates.** Rules don't change that by themselves. A rule run means updates he didn't look at first, so the message after it says what ran where and what to test, the same as a run he approved.

## What a rule is

A rule is a short, fixed set of fields, not a language. Each field narrows it; nothing widens what a batch could already do.

| Field          | Choices                                                                                                      | Default                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Name           | Tyler's words: "Minor plugin updates on my sites"                                                            |                              |
| Sites          | Tyler's own sites; sites with a maintenance plan; or a list of sites                                         |                              |
| Components     | Any plugin; any theme; or a list of plugins and themes by slug                                               |                              |
| Kind of change | Patch only (`1.2.3 → 1.2.4`); patch or minor (not major); or security fixes only, of any size short of major | Patch or minor               |
| Leave out      | Plugins and themes by slug ("never WooCommerce")                                                             | None                         |
| Wait           | Days since WordPress first offered the version, before the rule takes it                                     | 3 days; 0 for a security fix |
| Most at once   | Updates a site, sites a run                                                                                  | 10 a site, 10 sites          |

**Always true, whatever the rule says:**

- Never a major version (`isMajor`, `updates/queue.ts`), never core, never Craftish Care itself.
- Only what WordPress offers with a package, as now.
- Never a version Kamaji rolled back from (`rolledBackAt` on the queue item).
- Never a site that's paused, blocked, held in another batch, or busy.
- Never a site whose backup is "Tyler's word" (`backup_expectation = 'tyler'`): that needs his tick each time. A site whose backup is Kamaji's needs this week's snapshot to have passed its restore check, as "Ready to update" shows it; a host's backup is taken as the host's word, as now. Question 7.
- Never a site whose checks aren't green just before the run (the updater's baseline does this already).
- One site first, always, and a held first site holds the rest.

**Matching** is one pure function in `@kamaji/shared`: a rule, a queue item and the facts about its site go in, and out comes "matches" or the first reason it doesn't ("major", "waiting 2 more days", "rolled back from this version"). The app uses it for the Rules tab's preview and to make the batch; the updater uses the same function to check the batch before it runs. Writing it once is what keeps those two from drifting apart.

## Where it runs

**At the weekly update time, and only then.** Not continuously: a rule that ran whenever an offer appeared would mean updates at any hour, with no "Ready to update" message first and no backup taken for them.

1. **The night before**, as now: each site's whole-site backup at its quiet hour, and its restore check.
2. **At the update time**, as now: Recheck all, then "Ready to update". New: the app's cycle works out each enabled rule against the fresh queue, and makes a rule batch per rule. Each batch is approved by its rule, not by Tyler, and its sites are ordered with one site first. The message says what they'll run and when: "Rule 'Minor plugin updates on my sites' runs 6 updates on 4 sites at 11:00. Pause it in Kamaji to stop it." Discord gets the label and counts, never plugin names.
3. **A veto window** (1 hour, question 2): the batch waits, shown at the top of Updates with **Pause this run**. Pausing needs no passkey: it only stops something.
4. **The updater runs it** like any batch, after the window: backup evidence, baseline checks, "before" screenshots, one item at a time with the checks after each, "after" screenshots.
5. **After**: the usual message, with "approved by rule 'Minor plugin updates on my sites'". Activity, the run and the site's page all name the rule.

An update a rule could take, but which Tyler ticks himself first, runs in his batch; the rule leaves it alone. Items in a rule batch are taken out of the queue while it waits, as any approved item is.

If Kamaji is down at the update time, the rule batch is made late within the same 3 hours as "Ready to update" (`READY_WINDOW`), and not at all after that. The updater refuses to start a rule batch more than 6 hours after its update time, whoever made it.

## The approval

Saving, editing or resuming a rule is a passkey request (`POST /api/rules`), like approving a batch. The stored rule is the signed body and its proof. An edit is a new version, signed again; the old one is kept and stops matching.

Before running a rule batch, the updater checks, in place of today's `approvalProblem`:

1. The rule version's proof verifies, for `POST /api/rules`, with its stored body.
2. That version is the rule's latest, and the rule isn't paused or deleted.
3. The batch was made within its update time's window (above), and starts after the veto window.
4. Every item, and each site's facts, still match the signed rule by the shared function, read fresh from the database by the updater itself, with each site's latest report. One that doesn't is dropped from the run with its reason. If every item fails, the batch is refused.
5. The batch is within the rule's "most at once".

A rule's proof is used by many batches, so today's "a nonce signs one thing only" check (`signedBody`) counts rule versions as a third table. A nonce used for a rule can't also approve a batch or a rollback, and the other way around.

**What this changes in the threat model.** Today a compromised app, or anyone with a session on it, can't make the updater run anything: every batch needs Tyler's passkey over its exact items. With a rule, someone with control of the app could make a batch the updater would run without Tyler, but only within a rule he signed: those sites, those components, that kind of change, at the update time, only versions WordPress offers (the plugin checks `to` against WordPress's own offer). They couldn't widen a rule, write a new one, or resume a paused one without the passkey. That's the trade TY-171 makes, and I think it's an acceptable one, but it's the one to look hard at.

## What happens when something goes wrong

- **A held site**, whatever the reason (a failed update, a failed check, a backup missing): the rule pauses, not just the run. The rest of the run stops if it was the first site; otherwise that component is left out on the sites still to run, since one bad release shouldn't hit eight sites one after the other. Resuming the rule needs the passkey. Question 5.
- **Screenshots changed** on a rule run: they're report-only, and a rule run doesn't change that. They do pause the rule, as a held site does, and the message says to look. Question 6.
- **A rollback** of anything a rule ran pauses the rule.
- **The updater refuses a rule batch** (a bad proof, a changed rule, too late): it's held with the reason, as a refused batch is now, and the rule is paused.
- **A pause is on the rule's row** with who or what paused it and why, and in Activity.

## The UI

**Rules** becomes a tab, as in the brief:

- Each rule as a sentence: "Patch and minor updates to any plugin, except WooCommerce, on Tyler's own sites, 3 days after WordPress offers them." Its state (on, paused and why), when it last ran and what that did.
- **What it would take now:** the shared function run against today's queue, with each item it matches and each near miss with its reason ("Yoast 23.1 → 24.0: major"). This is the preview while writing a rule, too.
- New, edit, pause, resume, delete. Pause needs nothing; the rest need the passkey.
- Each site's WordPress auto-update flags, read only, with a warning where one is on for something a rule covers.

**Updates**: an item a rule will take says so ("Rule: Minor plugin updates on my sites, Tuesday"), and Tyler can still tick it himself. A waiting rule batch sits at the top with Pause this run.

**The run, the site page, Activity, Discord**: "approved by rule '<name>'" where a person's name would be.

## Data model (migration 29)

- `rules`: id, name, created_at, created_by, paused_at, paused_by, paused_reason, deleted_at.
- `rule_versions`: rule_id, version, body (the signed JSON), approval (the proof), signed_at, signed_by.
- `batches`: `rule_id` and `rule_version`, null for Tyler's batches; `approved_by` becomes `rule:<id>` for a rule's.
- `sites`: a `maintenance_plan` flag (question 4), set with the passkey.
- Events: `rule.saved`, `rule.paused`, `rule.resumed`, `rule.deleted`, `batch.ruled` (made by a rule).

## Testing

- The matching function, as a table: each field, each "always true", the wait, majors with odd version numbers (four parts, date-based like `2024.11.1`), a rolled-back version.
- The approval: a tampered body, a proof for another path, a rule edited after its batch was made, a paused rule, a batch made outside its window or started too late, an item that stopped matching, a nonce reused across rules, batches and rollbacks.
- Failure pauses: a held first site, a held later site leaving the component out of the rest, changed screenshots, a rollback.
- End to end on the DDEV site: a rule takes Akismet's minor update at a fake update time, after the veto window, with the checks and screenshots; then a rule whose update breaks a check pauses itself.
- Then for real, on one of Tyler's own sites with one rule, for a few weeks, before any client site.

## Risks

- **A bad release on many sites at once.** One site first, the wait, leaving a failed component out of the rest, and pausing the rule all limit it. What's left is a release that breaks something Kamaji's checks and screenshots don't see: a form, a checkout, an email. That's the case for keeping Tyler's hand tests after a rule run.
- **Database changes on update.** Plugins like WooCommerce and Yoast migrate their tables on update. A files-only rollback doesn't undo that, and a database rollback loses orders. Shops should probably leave WooCommerce and its extensions out of every rule.
- **Version numbers that mean nothing.** Many plugins don't follow semver: a "patch" can be a rewrite. The wait and "leave out" are the only answers to that.
- **The rule outlives its reason.** A rule written for four sites quietly covers a fifth once it gets the maintenance plan flag. The Rules tab says what each rule covers now, and the "Ready to update" message names the counts each week.
- **Clients.** An update a client didn't hear about first. That's what the maintenance plan is for; its terms should say updates are applied weekly, and it's worth checking Briardale's says so.
- **The trade in the threat model**, under "The approval".

## Not in v1

- Flipping WordPress's own auto-update switches (the plugin can't yet; `docs/protocol.md`, "Never").
- Core, even minor. WordPress's own minor core updates are left as each site has them.
- Risk scores and confidence thresholds from the brief.
- Calcifer proposing a rule. It could later, as it proposes a batch now: a proposal Tyler signs.
- Rules that run more often than weekly, or for security fixes the moment they appear.
- Expiry, or a reminder to review a rule.

## Open questions

1. **Kamaji approves, rather than WordPress's switch?** I'd go with TY-171 and leave WordPress's auto-updates as a read-only view, with a warning where they overlap a rule. `explore/kamaji.md` would need the 2026-11-08 line updated.
2. **The veto window:** rule batches start 1 hour after "Ready to update"? Long enough to see the message and pause, short enough to finish the same morning.
3. **The wait:** 3 days after WordPress first offers a version, 0 for a security fix?
4. **Maintenance plan:** a per-site flag in Kamaji, set with the passkey? Which sites have one today besides Briardale?
5. **What a held site pauses:** the whole rule until resumed (my pick), or only that component?
6. **Changed screenshots on a rule run:** pause the rule as a held site does (my pick), or only report?
7. **Backups:** only sites whose backup is Kamaji's (restore-checked this week) or the host's? Should a client's own backup count?
8. **The first rule:** patch and minor plugin updates on Tyler's own four sites, WooCommerce left out, 3 days' wait? That's the one I'd build against and try first.
9. **Ordering with TY-171:** it says after the passkey work and M6. Passkeys are done; is M6 (`kamaji/m6-checklist.md`) far enough along, or do rules wait?
