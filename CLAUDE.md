# TML Cost Calculator — rules for every Claude session in this folder (Cowork and Claude Code)

Read `COWORK.md` first. The short version:

1. **Supabase is the only data store and Netlify only serves the sign-in page.** Keep both in sync with this
   folder at the end of every piece of work. Nothing is "done" until it is published:
   ```sh
   node tools/sb-publish.mjs "what changed"      # build -> upload bundle to Supabase -> commit + push (Netlify)
   ```
   Add `--data` when `build/seed.json` / `build/data/db/` changed, so the database gets it too.
2. **Before touching data, pull the live state:** `node tools/sb-seed.mjs --export`. Never work from an old
   snapshot or from the claude.ai artifact's database; the artifact cannot reach Supabase and is not the source.
3. **The editable page is `build/app.html`** (git-ignored). Never edit, re-encrypt or "refresh" `index.html`
   by hand; never run `build/freight-patch/reencrypt.mjs`, `build/refresh-data.mjs` or anything in
   `build/_obsolete/`. Never put data (a SEED) into a page.
4. Keys live in `.env.build` (git-ignored). Never copy them into a page, a commit, a chat or a document.
5. Schema changes go in `supabase/migrations/NNNN_name.sql` + `node tools/sb-migrate.mjs`, with RLS policies.
6. Accounts: `tools/sb-users.json` + `node tools/sb-seed.mjs --users`. Public sign-up stays disabled.
7. After publishing, say which commit was pushed and that the bundle was uploaded; users get the new build at
   their next sign-in (tell them to sign out and in if they need it now).
