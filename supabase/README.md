# Supabase edition — setup

The calculator moves from "one encrypted page + each browser's localStorage" to a shared database:

| piece | where | protected by |
|---|---|---|
| sign-in page `index.html` | Netlify (public, holds no data or formulas) | nothing to protect |
| calculator `app.html` | Supabase Storage, private bucket `app` | storage policy: active profiles only |
| data (`master/*`, `months/*`, `deals/*`, `quotes/*`, `docs/*`) | table `public.documents` | RLS by role |
| activity log | table `public.activity_log`, append-only | RLS (insert as yourself, read all, no delete) |
| shipment history (was `hist/*.json`) | table `public.hist` | RLS (read: active profiles) |
| users | Supabase Auth + `public.profiles` (name, role, active) | admin only |

Roles and what they may write (`public.can_write`): admin everything; costing master, months, quotes, docs, deals;
purchasing months, quotes, docs; vicegm and exim quotes, docs; viewer nothing. Everyone active reads everything.
A new sign-up (if ever allowed) gets an inactive viewer profile and sees nothing until an admin activates it.

## One-time setup

1. Create a project at supabase.com (region Singapore is closest). Do not share the dashboard password; the tools
   need only the values below, in `.env.build` (git-ignored):
   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_ANON_KEY=<Project settings → API → anon public>
   SUPABASE_SERVICE_KEY=<Project settings → API → service_role>   # server-side only, never in a page
   DATABASE_URL=<Project settings → Database → Connection string → URI, with the database password>
   SB_INITIAL_PASSWORD=<first password for the five accounts; users change it with "Forgot password">
   ```
2. Dashboard → Authentication → Providers → Email: turn **off** "Allow new users to sign up"; keep "Confirm email".
   Authentication → URL configuration: Site URL `https://tmlcalculator.netlify.app`, add it to Redirect URLs.
3. `cd tools && npm install` (installs supabase-js and pg for the scripts).
4. `node tools/sb-migrate.mjs` — tables, RLS, realtime, the `app` bucket.
5. Decrypt the current page: `node tools/crypt.mjs decrypt index.html '<gate password>' build/app.html`.
6. `node tools/sb-build.mjs build/app.html` — writes `build/app.sb.html`, `build/index.sb.html`, `build/seed.json`.
7. `node tools/sb-seed.mjs --all` — accounts and profiles, documents, shipment history, app bundle.
8. Test: serve the folder locally with `build/index.sb.html` as the page, sign in as each role, check the activity
   log shows the sign-in and a saved quote, open a second browser and see the change arrive live.
9. Cut over: `cp build/index.sb.html index.html`, commit, push (Netlify deploys). Keep `tools/crypt.mjs` and the
   last encrypted page in git history as the fallback.

## Every later release

```
node tools/sb-build.mjs build/app.html     # after editing the decrypted app
node tools/sb-seed.mjs --app               # publish the bundle; users get it on their next sign-in
```
Data refreshes from Cowork go to the database (`node tools/sb-seed.mjs --docs` after refreshing `build/seed.json`),
never into the page. The `--docs` step keeps any document the database already has with a newer `updatedAt`.
