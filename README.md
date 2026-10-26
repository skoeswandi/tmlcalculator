# TML Cost Calculator

Internal pricing tool of PT Tata Metal Lestari. Static sign-in page on Netlify, data and the
calculator itself on Supabase.

- Live: https://tmlcalculator.netlify.app (deploys automatically from `main`)
- Supabase project `tmlcalculator` (ref `iimhoziisbslllvkgmpj`, Singapore)

## How it is put together

| piece | where | protected by |
|---|---|---|
| `index.html` sign-in page | this repo, Netlify | nothing to protect: no data, no formulas |
| `app.html` the calculator | Supabase Storage, private bucket `app` | readable by active profiles only |
| data (`master/*`, `months/*`, `deals/*`, `quotes/*`, `docs/*`) | table `documents` | Row Level Security by role |
| activity log | table `activity_log`, append-only | RLS |
| customer shipment history | table `hist` | RLS |
| users | Supabase Auth + table `profiles` (name, role, active) | admin only; public sign-up disabled |

Roles: admin (everything), costing (master data, monthly inputs, quotes, order documents, deals), purchasing
(monthly inputs, quotes, order documents), vicegm and exim (quotes, order documents), viewer (read only).
Every active user reads everything and sees other users' changes live. See `supabase/README.md`.

## Accounts

Sign in with your own email and password; "Forgot password" sends a reset link. New accounts are created by an
admin with `node tools/sb-seed.mjs --users` from `tools/sb-users.json` (or in the Supabase dashboard, then set the
role and `active` in `profiles`).

## Releasing a change to the calculator

```sh
node tools/sb-build.mjs build/app.html     # build/app.html is the editable page (git-ignored, never committed)
node tools/sb-seed.mjs --app               # publish; users get the new build at their next sign-in
```
Data refreshes from Cowork go into the database (`node tools/sb-seed.mjs --docs` from `build/seed.json`), not into
the page. `build/` and `.env.build` (keys) are git-ignored.

The previous edition (one AES-encrypted page, data in each browser's localStorage) is in git history up to
commit `9a5d729` (Beta V1.8) and `tools/crypt.mjs` still decrypts it.
