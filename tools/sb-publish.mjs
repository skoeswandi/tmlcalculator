#!/usr/bin/env node
// One command that keeps Netlify and Supabase in sync with this folder.
//   node tools/sb-publish.mjs "what changed"
// 1. builds build/app.sb.html + build/index.sb.html from build/app.html
// 2. uploads the calculator bundle to the private Supabase bucket (users get it at next sign-in)
// 3. if the sign-in page changed, copies it to index.html
// 4. commits every tracked change in the repo and pushes main (Netlify deploys automatically)
// Also:  --data   pushes build/seed.json to the database first (documents with a newer updatedAt only)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const msg = args.filter(a => !a.startsWith('--')).join(' ').trim() || 'Publish ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(root, 'build', 'app.html'))) { console.error('build/app.html is missing: that is the editable calculator page. Restore it with  node tools/sb-seed.mjs --pull-app  (or from your last build).'); process.exit(1); }
if (args.includes('--data')) sh('node tools/sb-seed.mjs --docs');
sh('node tools/sb-build.mjs build/app.html');
sh('node tools/sb-seed.mjs --app');

const built = fs.readFileSync(path.join(root, 'build', 'index.sb.html'), 'utf8');
const live = fs.existsSync(path.join(root, 'index.html')) ? fs.readFileSync(path.join(root, 'index.html'), 'utf8') : '';
const strip = (s) => s.replace(/Build \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, '');
if (strip(built) !== strip(live)) { fs.writeFileSync(path.join(root, 'index.html'), built); console.log('index.html updated (sign-in page changed)'); }
else console.log('index.html unchanged');

const dirty = out('git status --porcelain').split('\n').filter(l => l && !l.startsWith('?? input/') && !l.startsWith('?? build/'));
if (!dirty.length) { console.log('nothing to commit; Netlify already has this sign-in page. Bundle published to Supabase.'); process.exit(0); }
sh("git add -A -- . ':(exclude)input'");   // build/ is git-ignored already
sh(`git commit -q -m ${JSON.stringify(msg)} -m ${JSON.stringify('Published with tools/sb-publish.mjs: bundle to Supabase, sign-in page to Netlify.')}`);
sh('git push -q origin main');
console.log('pushed', out('git log --oneline -1'), '-> Netlify deploys in about a minute');
