# M4's release

Once, in order: the release channel goes live, Craftish Care 0.2.0 reaches the three pilot sites by hand, 0.2.1 proves the self-update, then the first real updates run. Each step says where it runs: **Cloudflare**, **Doppler**, **laptop**, **mini**, **craftish**, **Kamaji** (the app, in a browser) or the site's **wp-admin**. Every release goes DDEV, then aleyahoerlein.com alone, then the other two. Stop at any step that doesn't show what it says to expect, and tell me what it showed.

## The channel

1. **Cloudflare.** Edit the existing deploy token, never roll it: dash.cloudflare.com → Manage account → Account API tokens → the token in `kamaji/deploy` → Edit. Add two permissions, Zone → Workers Routes → Edit and Zone → DNS → Edit, with Zone Resources set to Include → Specific zone → `craftish.dev`. Continue to summary, then Update token. The value doesn't change, so Doppler doesn't either.

2. **Cloudflare.** craftish.dev → DNS → Records, search for `care`. Expect no record for `care.craftish.dev` (A, AAAA or CNAME): the custom domain makes its own, and fails on an existing one.

3. **laptop.** Get the branch:

```
cd /Users/tyler/kamaji && /usr/bin/git checkout care-0.2 && /usr/bin/git pull --rebase
```

4. **laptop, Doppler.** Make the release key, straight into Doppler (skip if step 5 already shows both names; it refuses to replace one):

```
node /Users/tyler/kamaji/scripts/care-keys-doppler.mjs --release
```

5. **Doppler.** Check the names (expect `KAMAJI_CARE_RELEASE_KEY` in `release`, then `KAMAJI_CARE_RELEASE_PUBLIC_KEY` among checker's):

```
/opt/homebrew/bin/doppler secrets --only-names --project kamaji --config release && /opt/homebrew/bin/doppler secrets --only-names --project kamaji --config checker
```

6. **laptop.** DDEV first: the plugin tests on the tree being released (expect `39 passed`):

```
cd /Users/tyler/kamaji && npm run build && npm run test:plugin
```

7. **laptop.** Build 0.2.0, signed with the release key, into the Worker's channel folder:

```
cd /Users/tyler/kamaji && /opt/homebrew/bin/doppler run --project kamaji --config release -- node scripts/care-release.mjs --out worker/channel/craftish-care
```

8. **laptop.** The published zip on DDEV, with the real release key (expect `craftish-care active 0.2.0 none`: nothing newer to offer):

```
node /Users/tyler/kamaji/scripts/ddev-real-channel.mjs 0.2.0
```

9. **laptop.** Commit the release:

```
cd /Users/tyler/kamaji && /usr/bin/git add worker/channel/craftish-care && /usr/bin/git commit -m "Craftish Care 0.2.0 on the release channel" && /usr/bin/git push
```

10. **laptop, Cloudflare.** Deploy the Worker (expect `care.craftish.dev (custom domain)` in the output with the `workers.dev` address and the cron; an authentication error `10000` means step 1's zone permission didn't take):

```
cd /Users/tyler/kamaji/worker && /opt/homebrew/bin/doppler run -- npx wrangler deploy
```

11. **laptop.** The channel answers (expect `"version": "0.2.0"`; a new custom domain's certificate can take a few minutes):

```
/usr/bin/curl -s https://care.craftish.dev/craftish-care/info.json
```

12. **laptop.** The zip it serves is the one signed (expect the `sha256` from step 11):

```
/usr/bin/curl -s https://care.craftish.dev/craftish-care/craftish-care-0.2.0.zip | /usr/bin/shasum -a 256
```

13. **laptop.** The API isn't on that host (expect `404`):

```
/usr/bin/curl -s -o /dev/null -w '%{http_code}\n' https://care.craftish.dev/v1/results
```

## Kamaji, the updater and the export

14. **laptop.** Merge the branch into `main`:

```
cd /Users/tyler/kamaji && /usr/bin/git checkout main && /usr/bin/git pull --rebase && /usr/bin/git merge --no-ff care-0.2 -m "Merge care-0.2: M4's updater and Craftish Care 0.2.0" && /usr/bin/git push
```

15. **mini.** Deploy (migration 12 runs; the app now builds 0.2.0 zips with the release key's public half):

```
/Users/tylercraft/kamaji/ops/deploy.sh
```

16. **Doppler, mini.** The updater: every step of "The updater" in `ops/README.md`. Its step 2 says whether Doppler resolves the references on your plan.

17. **mini, laptop, craftish.** The export: every step of "craftish's database export" in `ops/README.md`.

## 0.2.0 by hand

18. **Kamaji.** aleyahoerlein.com's page → Connection → "Download this site's copy of Craftish Care".

19. **wp-admin** (aleyahoerlein.com). Plugins → Add New Plugin → Upload Plugin, choose the zip, Install Now, then "Replace current with uploaded".

20. **wp-admin.** Tools → Craftish Care. Expect connected with keys r1 and u1, and under "What it did" a `release key` line, `stored p1`, from this page load.

21. **Kamaji.** The site's page → Recheck. Expect a good report, Craftish Care 0.2.0 in the inventory, and its must-use plugins listed. Then wait for the next hourly report and check it too.

22. **Kamaji.** Do steps 18 to 21 for photogravure.com, then mintonhomesllc.com.

## 0.2.1, the self-update

0.2.1 is TY-162's admin page, on the branch `care-0.2.1`. Kamaji updates it like any plugin, once WordPress offers it. WordPress's automatic updates stay off for it, but the offer shows on all three sites' Plugins pages from step 25, so a client could click it; the approvals keep the order.

23. **laptop.** Get the branch, and DDEV first (expect `42 passed`, with the admin page's three; the tests self-update from a local channel):

```
cd /Users/tyler/kamaji && /usr/bin/git checkout care-0.2.1 && /usr/bin/git pull --rebase && npm run build && npm run test:plugin
```

24. **laptop.** Build 0.2.1 into the channel and commit it:

```
cd /Users/tyler/kamaji && /opt/homebrew/bin/doppler run --project kamaji --config release -- node scripts/care-release.mjs --out worker/channel/craftish-care && /usr/bin/git add worker/channel/craftish-care && /usr/bin/git commit -m "Craftish Care 0.2.1 on the release channel" && /usr/bin/git push
```

24a. **laptop.** Merge it into `main`, so the channel deploys from `main` from here on (a Worker deployed without 0.2.1's files would serve 0.2.0 again):

```
cd /Users/tyler/kamaji && /usr/bin/git checkout main && /usr/bin/git pull --rebase && /usr/bin/git merge --no-ff care-0.2.1 -m "Merge care-0.2.1: Craftish Care 0.2.1" && /usr/bin/git push
```

25. **laptop, Cloudflare.** Deploy the Worker, and check the channel offers 0.2.1 (expect `"version": "0.2.1"`):

```
cd /Users/tyler/kamaji/worker && /opt/homebrew/bin/doppler run -- npx wrangler deploy && /usr/bin/curl -s https://care.craftish.dev/craftish-care/info.json
```

26. **laptop.** DDEV on the real channel: 0.2.0 installed, 0.2.1 offered (expect `craftish-care active 0.2.0 available 0.2.1`):

```
node /Users/tyler/kamaji/scripts/ddev-real-channel.mjs 0.2.0
```

27. **laptop.** Let DDEV update itself from the channel, through the plugin's hash check (expect `Success: Updated 1 of 1 plugins`):

```
cd /Users/tyler/kamaji/dev/wordpress && ddev wp plugin update craftish-care
```

28. **laptop.** Look at Tools → Craftish Care on https://kamaji-wp.ddev.site/wp-admin/tools.php?page=craftish-care: the new page, connected, keys r1 and u1.

29. **Kamaji.** aleyahoerlein.com's page → Recheck, then Updates: approve only Craftish Care 0.2.1 for aleyahoerlein.com. Expect the outcome `passed`, then the new page in its wp-admin.

30. **Kamaji.** The same for photogravure.com, then mintonhomesllc.com.

## The first real updates

31. **Kamaji.** Under each site's Configure, check its backup: aleyahoerlein.com's is Kamaji's craftish export; the others are whatever their hosts or clients do, or your word at approval.

32. **Kamaji.** Updates: approve aleyahoerlein.com's waiting updates as one batch. Expect `passed` for each component, the backup evidence on the run, and no uptime alert during it.

33. **Kamaji.** Then photogravure.com, then mintonhomesllc.com last, one batch each, each after the one before has passed.

When all three have passed, M4 is done: TY-150 closes, and TY-162 with 0.2.1.
