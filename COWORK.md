# For Claude in Cowork: how this folder works now (since 26 Oct 2026)

The calculator moved to Supabase. Read this before changing anything here.

## What changed

- `index.html` is now only a **sign-in page**. It holds no calculator code and no data. **Never rewrite,
  re-encrypt or "refresh" index.html.** The old kits in `build/freight-patch/reencrypt.mjs`,
  `build/refresh-data.mjs` and `build/_obsolete/` assume the encrypted page and must not be run.
- The calculator itself is `build/app.html` (git-ignored, plain HTML, the same page you know, with the Supabase
  runtime shim swapped in at build time). It is served to signed-in users from a private Supabase Storage bucket.
- **All data lives in Supabase** (project `tmlcalculator`, ref `iimhoziisbslllvkgmpj`): table `documents` holds
  every document by path (`master/settings`, `months/2026-10`, `deals/<key>`, `quotes/<id>`, `docs/<id>`),
  `activity_log` is the shared append-only log, `hist` holds the customer shipment history, `profiles` the users
  and roles. Users see each other's changes live. The claude.ai artifact's own database is no longer the source
  of truth and cannot reach Supabase (the artifact sandbox blocks outbound connections; tested 26 Oct 2026).

## Code changes (the way that works)

1. Make your edits to `build/app.html` directly, or produce a `pairs.json` + `apply.py` kit against it (as with
   order-docs-patch). Do not touch the first `<script>` block (the runtime shim) unless the change is about the
   data layer; the build replaces it anyway.
2. Build and publish:
   ```sh
   node tools/sb-build.mjs build/app.html     # -> build/app.sb.html, build/index.sb.html
   node tools/sb-seed.mjs --app               # upload the bundle; users get it at their next sign-in
   ```
   If `build/index.sb.html` changed (sign-in page), copy it to `index.html` and commit; Netlify deploys it.
3. Keys are read from `.env.build` (git-ignored). Never copy them into a page or a commit.

## Data (the way that works)

- **Before working with data, pull the current state:** `node tools/sb-seed.mjs --export` writes
  `build/data/db/<collection>/<id>.json` and `build/seed.json` from the database, plus `build/last-export.json`
  (counts, newest `updatedAt`, profiles). This replaces the artifact snapshot you used to refresh from.
- **To push data** (a refreshed paint list, a new month, settings): write the JSON files under
  `build/data/db/`, rebuild `build/seed.json` from them (one key per `<collection>/<id>`), then
  `node tools/sb-seed.mjs --docs`. A document is only written when its `updatedAt` is newer than the
  database's `updated_at`, so always set `updatedAt` to now on documents you change.
- Shipment history: `node tools/sb-seed.mjs --hist` from `build/order-docs-patch/hist/*.json`.
- Never put data into a page. The page has no SEED any more.

## Schema changes

Add a numbered file to `supabase/migrations/` and run `node tools/sb-migrate.mjs`. RLS is on every table;
a new table needs policies (see `0001_init.sql`). The page's db API is unchanged
(`db.doc(path).get/set/update/delete/onSnapshot`, `db.collection(col).orderBy().limit().onSnapshot/add`),
so app code written for the artifact keeps working.

## Accounts

`tools/sb-users.json` + `node tools/sb-seed.mjs --users` (admin only). Roles: admin, costing, purchasing,
vicegm, exim, viewer. Public sign-up is disabled in the project.
