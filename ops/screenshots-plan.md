# Screenshot checks plan

During an update run, screenshot each of the site's check pages just before its first update and just after its last, compare them, and show them side by side on the run's record, so a broken layout is caught even when the expected text is still there (calcifer `explore/kamaji.md`, "Later ideas", "Screenshot checks", 2026-11-18). Written 2026-11-19 from Tyler's brief, approved the same day with his answers ("Settled", at the end), and built on branch `screenshots` ("As built", where it differs from what's below). The numbers below were measured on the laptop the same day (Docker Desktop 29.9.3, arm64, like the mini), against the DDEV site and two heavy public pages that aren't clients' (a WordPress news blog and a WooCommerce marketing home page), never a client site.

## Where this differs from the brief

Your brief, with the places I'd change it. Each one comes up again below.

1. **The official image needs a thin layer of ours.** `mcr.microsoft.com/playwright` has Node, Chromium and its system libraries, but not Playwright itself: it expects your project to bring it. No mounts beyond the output folder means it can't come from the mini's `node_modules`, and `npx` at start would fetch from npm on every run. So Kamaji builds `kamaji-shots` from the official image pinned by digest, adding `playwright-core` at the same version and the shot script (`shots/Dockerfile`, about 20 MB on top). It's built on the mini, from the repo, never pulled from anywhere but Microsoft's registry.
2. **Chromium's own sandbox on, rather than dropping every capability.** Playwright turns Chromium's sandbox off by default. With Playwright's seccomp profile, `no-new-privileges`, its non-root user and a read-only root filesystem, the sandbox works; with `--cap-drop ALL` it doesn't start at all, even with `SYS_ADMIN` added back (tested). The non-root user has no effective capabilities anyway, so I'd keep the sandbox: a page that breaks out of its renderer still lands inside the container's sandbox, as an unprivileged user, on a read-only filesystem.
3. **One container per round of shots, not per site.** The "before" round and the "after" round are minutes apart, with the updates between, and nothing needs a browser in between. Each round is its own `docker run --rm`, killed at its cap. That's tighter than per site.
4. **A change in page height spoils the full-page comparison below it.** Everything under a taller banner moves down, so every pixel below differs. When the heights match (within 2 px), the whole page is compared; when they don't, the height change is reported as its own signal ("340 px taller on mobile") and only the first screen is compared, since that's where a broken header or hero shows.
5. **Analytics would count every shot as a visit.** A real browser runs the site's scripts, so up to 36 page loads a site a run would show in the client's Google Analytics, Meta pixel and so on. The browser blocks a fixed list of analytics, ad and session-recording hosts (`shots/blocked.ts`: Google Analytics and Tag Manager, Meta, Hotjar, Microsoft Clarity, HubSpot's tracking, LinkedIn, TikTok). The same list on both rounds, so it doesn't make a difference between them. It does make the shot slightly unlike a visitor's view where a tag manager adds visible things; that's accepted.
6. **This is more than "the plain HTTP checks".** Kamaji's `CLAUDE.md` says nothing goes to a client site beyond `checks/`. A headless browser loads every asset and runs the site's JavaScript. It still changes nothing on the site, signs in nowhere and submits nothing, but the rule needs your word and an edit: in `CLAUDE.md` here, and the decision in `explore/kamaji.md` (a Calcifer session's edit).
7. **No console error text kept, only counts.** A JavaScript error comes with a message and a stack: a traceback, which the database never holds. Each error is kept as a count and a fingerprint (a hash of its message and source file, with numbers and query strings taken out), so "new since before" works without the text. Failed requests are kept as method, host, path (no query string) and status.
8. **Its own process, with no secrets.** Not the updater: the updater holds the update key, and "Take screenshots now" must work while a batch runs. A small `dev.craftish.kamaji-shots` process holds nothing but Docker and the screenshots folder (below, "Who does it").

## Numbers

|                          |                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                    | 3.54 GB as Docker reports it (official image), 3.56 GB with our layer. Chromium is 680 MB of it (402 MB full, 278 MB headless shell); Firefox and WebKit (564 MB) come along unused. It lives in Docker Desktop's disk, beside the restore check's WordPress and MariaDB images. |
| Container start          | 0.4 s to a running browser (55 to 140 ms of that is Chromium's launch).                                                                                                                                                                                                          |
| One shot, light page     | 0.8 to 1.3 s (DDEV, Twenty Twenty-Four): load, quiet network, fonts, a scroll through for lazy images, full-page PNG.                                                                                                                                                            |
| One shot, heavy page     | 4 to 7 s (WooCommerce's home page, 7,100 px tall; a WordPress news page). Most of it is the page loading (2.4 to 3 s) and waiting for the network to go quiet.                                                                                                                   |
| PNG size                 | 40 to 190 KB light; 0.5 to 3 MB heavy (desktop 1440 wide; mobile at 2× is 780 px of pixels).                                                                                                                                                                                     |
| Comparison               | 16 to 105 ms a pair with pixelmatch (1440 × 7108 the slowest).                                                                                                                                                                                                                   |
| Two loads a minute apart | 0.00% different on the news page; 2.80% on WooCommerce's desktop home (a rotating section), 0.03% on its mobile. That's what the automatic masks are for.                                                                                                                        |

**A round** is every check page (the home page plus up to five) at two sizes: up to 12 shots, so 12 s for a light site and up to 80 s for a heavy one with six pages. **A run** adds three rounds per site (two "before" a few seconds apart, then "after"): about 30 s light, 1 to 4 minutes heavy.

**Shooting after every item** to name the culprit would add a round per item: a five-item run on a heavy site goes from 1 to 4 extra minutes to 6 to 10. Today's checks cost about 30 s an item, so this would triple the run. Not worth it in v1: before and after per site, and when they differ, the run's items are listed beside the shots, with Roll back… already on the run. Per-item shots could be a per-site switch later, for sites where a culprit matters more than time.

## The flow

1. **The updater reaches a site** and passes its baseline checks, as now. It asks for a "before" set (`screenshot_sets`, kind `before`, with the batch) and waits for it, polling every 2 s, up to 4 minutes, after starting the screenshots process. If the set still waits after 45 s and the process hasn't shown a heartbeat, it stops waiting.
2. **The screenshots process takes it:** two rounds 5 s apart, in one container (the second round is only for the masks). It writes the PNGs and thumbnails to the set's folder and a row per shot, then marks the set done or failed.
3. **The updater runs the items,** as now.
4. **After the last item,** whether it passed or the site was held (the "after" shots are most useful then), the updater asks for an "after" set and waits up to 3 minutes.
5. **The screenshots process takes it and compares:** each page and size, before against after, with the masks (below). A row per comparison, with a diff image. Then the second "before" round's images are deleted: they've done their job.
6. **The updater finishes the site** as now: resumes the alerts and the checks. In report-only mode the shots never change an outcome, a hold or anything else.

**Take screenshots now** on the site's page asks for a `manual` set: one round, no passkey (it changes nothing on the site), compared with the site's previous set if there is one, as information only.

### Taking one shot

What the measured runs did, in the container (`shots/shoot.mjs`), a fresh browser context for each page and size so nothing carries over:

1. Desktop 1440 × 900 and mobile 390 × 844, both at 1×; mobile with touch and a phone user agent. Reduced motion, service workers blocked, the blocked hosts aborted.
2. Go to the page and wait for `load` (30 s cap); then for the network to go quiet (10 s cap; a page that never goes quiet is noted, not failed).
3. Turn off animations and transitions, and hide the caret, with injected CSS; wait for `document.fonts.ready`.
4. Scroll through a screen at a time (100 ms each), so lazy images load, then back to the top; wait for quiet again (5 s cap).
5. Hide the "hide" selectors (below), measure the "mask" selectors' boxes, then take the full-page PNG with Playwright's own animation freezing, up to 15,000 px tall (a taller page is cut there and says so), and a JPEG of the first screen as the thumbnail.
6. Count JavaScript errors (`pageerror` and console errors), failed requests and responses of 400 and over, with their fingerprints.

The container gets one JSON job as its argument (the URLs, sizes, selectors, the blocked hosts) and prints one JSON line per shot, as the push script does. The container's cap is 225 s for a "before" set and 165 s otherwise, inside the updater's waits, then `docker kill`; the shots it finished are kept.

### Masks

- **Automatic, per run:** whatever differs between the two "before" rounds, widened by 10 px, is masked in that run's comparison. It catches carousels, rotating testimonials, "3 minutes ago", random featured products.
- **Always:** `video`, and `iframe`s from other hosts (YouTube, Vimeo, maps): they never render the same twice.
- **Configured:** per check page, CSS selectors to **mask** (compared as blank: a cart count, a date) and site-wide selectors to **hide** (`display: none` before the shot: cookie banners, chat bubbles, newsletter popups). Under Configure → Check pages, beside each page's expected text.

The score is the share of pixels that changed, outside the masks (pixelmatch, per-pixel threshold 0.1, its anti-aliasing detection on), with the masked share beside it, so a page that's 60% masked says so.

### Cookie banners and popups

Every shot starts in a fresh context, so a cookie banner appears the same way before and after. It hides what's under it, though, and a popup on a timer can land in one round and not the other. The site-wide **hide** selectors are the answer for both. Kamaji never clicks Accept or closes anything: that's interacting with the site, and clicking would set consent cookies and fire whatever the consent tool fires. The automatic mask catches a popup that shows up in one "before" round and not the other.

### Tailnet-only sites

The accounting sites work from the mini as the other checks do. A Docker Desktop container's traffic goes out through the Mac's own network, Tailscale included, and its DNS through the Mac's resolver, MagicDNS included. Tested on the laptop: a container resolved `molcajete.tailb3044a.ts.net` to its tailnet address and got a 200 from Kamaji. It still needs trying from the mini against an accounting site (Testing, below).

## The UI

**On the run's record** (Updates, and the site page's Updates panel), under each site's items:

> **Screenshots:** 6 pages at 2 sizes. Largest change 3.1% (Shop, mobile); Cart got 340 px taller on mobile; 2 new JavaScript errors on Cart.

followed by a strip of before | after thumbnail pairs, the changed ones first, each with its score. Selecting one opens the comparison: Before, After and Differences side by side (stacked on a phone), desktop and mobile as tabs, the masked areas shaded, and the height and error counts under it. Nothing changed reads as one line: "Screenshots: 6 pages at 2 sizes, no change over 0.5%." A set that failed says why in one line ("Screenshots weren't taken: Docker isn't answering"). Images have alt text naming the page, size and when ("Shop, mobile, after, 19 Nov 15:12").

**On the site's page,** a Screenshots section: the latest set's thumbnails (each check page, desktop and mobile), when it was taken and why (a run, or by hand), **Take screenshots now** with its state (waiting, taking, done), and a link to the hide and mask settings.

**Discord:** counts only, added to the run's existing line when there's something to say: ", screenshots changed on 1 page". No page names or paths.

## Who does it

`dev.craftish.kamaji-shots`, a fourth LaunchAgent beside the app, the updater and the backups process. It holds no keys and no secrets: Docker, the screenshots folder and the database. One set at a time:

- On start, it marks sets left `running` failed ("the screenshots process stopped while it shot"), and builds `kamaji-shots` if that image's tag (the Dockerfile and script's hash) isn't there. The build pulls the base by digest. Sets asked for meanwhile wait.
- It writes a heartbeat to `state` every 15 s while it runs, which the updater reads.
- Daily, it deletes sets past retention (below).

The updater only writes requests and reads results; the app only writes `manual` requests and serves images. Neither runs Docker.

## Storage

Images go in `data/screenshots/<site>/<set id>/`, beside the database and the icons, mode 700. They're served by the app at `/api/screenshots/<set id>/<file>`, behind the same Tailscale login check as everything else. The file name is checked against the set's rows, never used as a path as given. Rows in the database say what's there; the database holds no images.

**Kept 30 days,** longer than rollback's 14 so the shots outlive the rollback point, plus the latest set of each site whatever its age. Estimate: a light site run is about 3 MB, a heavy one 30 to 50 MB (after the second "before" round is deleted). With weekly runs on a dozen sites, that's 0.5 to 2 GB at any time.

## Data model (migration 28)

- **`screenshot_sets`:** `id`, `site_id`, `batch_id` (null for manual), `kind` (`before`, `after`, `manual`), `requested_at`, `requested_by` (null for the updater's), `started_at`, `finished_at`, `state` (`waiting`, `running`, `done`, `failed`), `problem` (words, never stderr).
- **`screenshots`:** `set_id`, `round` (1, or 2 for the mask round), `page_url`, `viewport` (`desktop`, `mobile`), `file`, `thumb`, `width`, `height`, `cut` (taller than 15,000 px), `quiet`, `js_errors`, `js_keys` (fingerprints), `failed_requests`, `failed_keys` (method, host, path, status), `problem`.
- **`screenshot_comparisons`:** `batch_id`, `site_id`, `page_url`, `viewport`, `before_id`, `after_id`, `changed_pct`, `masked_pct`, `height_before`, `height_after`, `compared` (`page` or `first screen`), `new_js_errors`, `new_failed_requests`, `new_failed_keys`, `diff_file`, `at`.
- **`sites.screenshot_hide`:** site-wide hide selectors (JSON); each check page in `sites.important_pages` gains `mask` (selectors). The home page's masks live with the site, since it isn't one of the five.

Routes: `POST /api/sites/:id/screenshots` (passkey-free, as rollback's count is), `GET /api/sites/:id/screenshots`, `GET /api/screenshots/:set/:file`; the batch views gain each site's comparisons.

## When something fails

In report-only mode a screenshot failure never fails, holds or delays an update beyond the waits' caps, and never raises an urgent issue.

| What fails                                                          | What happens                                  | What Tyler sees                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The screenshots process isn't running                               | The updater doesn't wait                      | "Screenshots weren't taken: the screenshots process isn't running". After three runs, a normal issue |
| Docker isn't answering                                              | The set fails                                 | "…Docker isn't answering". Kamaji already raises Docker being down on Servers                        |
| The image is still building                                         | The set waits; the updater's wait may run out | "…the browser image was still being built"                                                           |
| A page won't load, or answers 4xx/5xx                               | That shot fails; the rest go on               | The page's tile says why; a page that loads before and not after is reported as a change             |
| Bot protection answers instead (Cloudflare's "Just a moment…" page) | The shot is marked blocked, not compared      | "Cloudflare's bot check answered instead of the page". See open question 6                           |
| The round hits its cap                                              | `docker kill`; the shots done are kept        | "Took too long: 4 of 12 shots"                                                                       |
| No "before" set                                                     | No comparison; "after" is still shot          | The "after" shots alone, saying why there's nothing to compare                                       |

## Testing

1. **The comparison** (`shots/compare.test.ts`), with small fixture PNGs: a moved block, a carousel masked by the two "before" rounds, a mask selector, a height change falling back to the first screen, a page that's mostly masked.
2. **The process** with a fake Docker, as the restore checks are tested: request to done, the caps and `docker kill`, a process restart mid-set, retention, the heartbeat, and that the updater never waits on a dead process.
3. **The container end to end,** laptop only (`npm run test:shots`): the real image against fixture pages served on a Docker network of their own (an animation, a carousel, lazy images, a cookie banner, a page that throws, a page that grows), then the DDEV site, with the flags it runs with on the mini.
4. **On the mini, before the first run:** "Take screenshots now" on an accounting site (tailnet-only) and on aleyahoerlein.com, and a look at the shots with you.

## Not in v1

- Holding on a bad score. Report-only first; once we've seen a few weeks of real numbers, a global and a per-site threshold that holds the site (with Roll back… right there).
- Shots after every item (above, "Numbers").
- Pages behind a login, carts with items, checkout, forms: they need test accounts the client agrees to (`explore/kamaji.md`, "Verification").
- Clicking anything: cookie consent, popups, menus.
- Browsers other than Chromium, and sizes other than 1440 and 390.
- Comparing across runs (drift since last month) beyond the manual set's look at the previous one.
- Sending the shots anywhere: they stay on the mini.

## Settled (Tyler, 2026-11-19)

1. **The rule:** yes. The screenshots process may load a site's check pages in a headless browser, read only: no sign-in, clicks, form submits or consent. `CLAUDE.md` says so; Calcifer updates `explore/kamaji.md`.
2. **Block the list.** HubSpot's tracking only (`js.hs-analytics.net`, `js.hs-scripts.com`, `track.hubspot.com`, `js.hs-banner.com`, `js.usemessages.com`), never `js.hsforms.net` or `forms.hsforms.com`: Briardale's forms must still render.
3. **Mobile at 1×.**
4. **The official image** is fine at 3.5 GB.
5. **The screenshots process builds the image** at start; `deploy.sh` stays as it is.
6. **Cloudflare:** a challenged shot says so; no allowlist unless it actually happens.
7. **Waits:** 4 minutes before, 3 after.
8. **Kept** 30 days, plus each site's latest set.

## As built

Where the build differs from the plan above:

- **The process starts when asked and exits when done,** like the updater and the backups process, rather than staying up: `deploy.sh` restarts only the app, so a process that stayed up would go on running old code. The updater, the app (Take screenshots now) and the app's cycle (a set that waits) start it with `launchctl kickstart`. Its heartbeat is written every 15 s while it runs; the updater stops waiting if a set it asked for is still waiting after 45 s with no heartbeat.
- **Hide and mask are two site-wide lists,** not per page: a selector that matches nothing on a page does nothing there, so one list does the job, the home page included. They're edited in the site page's Screenshots panel (with the passkey), not under Configure.
- **The container's caps** are 225 s for "before" and 165 s for "after" and one taken by hand, inside the updater's waits, so it's the container that stops first. It runs with 2 CPUs, 2 GB and 512 processes at most.
- **Console errors that are failed loads aren't counted twice.** Chromium logs `Failed to load resource: …` as a console error for every request that failed, blocked ones included (captured in `shots/fixtures/chromium-console.txt`); those are counted as failed requests (or not at all, when Kamaji blocked them), never as JavaScript errors.
- **The end-to-end test uses a fixture page served from the laptop,** not the DDEV site: the container reaches the laptop through Docker Desktop's `host.docker.internal`, but not DDEV's `*.ddev.site` names without changing the run's own flags. The fixture has what matters: an animation, a carousel, a lazy image, a cookie banner, an analytics tag; then the same page unchanged, and broken.
- **Changed** means 1% or more of the pixels outside the masks, a different height, a new JavaScript error or failed request, or a page shot before and not after (unless a bot check answered). It's only words and a count: nothing holds.
