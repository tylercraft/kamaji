# Inventory fixtures

- `care-report.json`: a real craftish-care `report` from the local DDEV WordPress (2026-11-09), with Akismet 5.3 installed so an update is on offer.
- `wporg-*.json`: real answers from the wordpress.org plugins API (2026-11-09): a listed plugin (`akismet`, HTTP 200), a closed one (`display-widgets`, HTTP 404) and a slug that isn't there (HTTP 404).
- `mainwp-*.json`: MainWP REST API v2's shapes as exported for the pilot on 2026-11-09 (`/sites/{domain}`, `/plugins`, `/themes`, `/plugins/abandoned`), with invented sites and plugins: the real exports list clients' plugins and stay in `scratch/mainwp`. `mainwp-site.json` keeps only the fields compared, out of about forty.
