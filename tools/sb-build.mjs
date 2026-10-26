#!/usr/bin/env node
// Build the Supabase edition from the decrypted calculator page.
//   node tools/sb-build.mjs [decrypted-app.html]          (default build/app.html)
// Writes (all git-ignored):
//   build/app.sb.html    the calculator with the Supabase shim in place of the static shim, no SEED data
//   build/index.sb.html  the public sign-in shell (same look as the current gate), to become index.html
//   build/seed.json      the SEED documents extracted from the page, for tools/sb-seed.mjs
// Reads SUPABASE_URL and SUPABASE_ANON_KEY from .env.build.
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const env = Object.fromEntries(fs.existsSync(path.join(root, '.env.build'))
  ? fs.readFileSync(path.join(root, '.env.build'), 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  : []);
const URL_ = process.env.SUPABASE_URL || env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';
if (!URL_ || !ANON) { console.error('SUPABASE_URL and SUPABASE_ANON_KEY are needed (in .env.build or the environment).'); process.exit(2); }
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js';

const appPath = process.argv[2] || path.join(root, 'build', 'app.html');
let app = fs.readFileSync(appPath, 'utf8');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });

// 1. the static shim is the first <script> block; it carries VERSION, BUILT_AT and the SEED
let mark = app.indexOf('static runtime shim'), kind = 'static';
if (mark < 0) { mark = app.indexOf('Supabase runtime shim'); kind = 'supabase'; }   // a page pulled back from the bucket
const open = mark < 0 ? -1 : app.lastIndexOf('<script', mark), close = mark < 0 ? -1 : app.indexOf('</script>', mark);
if (mark < 0 || open < 0 || close < 0) { console.error('no runtime shim block found in ' + appPath); process.exit(1); }
let shimOld = app.slice(open, close + '</script>'.length);
if (kind === 'supabase') {   // drop the supabase-js tag that precedes it too; it is re-added below
  const tagAt = app.lastIndexOf('<script src=', open);
  if (tagAt >= 0 && /^<script src="[^"]*supabase-js[^"]*"[^>]*><\/script>\s*$/.test(app.slice(tagAt, open))) shimOld = app.slice(tagAt, close + '</script>'.length);
}
const version = (/var VERSION = '([^']*)'/.exec(shimOld) || [])[1] || 'Beta';
const seedSrc = /var SEED = (\{[\s\S]*?\});\n/.exec(shimOld);
let seed = null;
if (seedSrc) { seed = JSON.parse(seedSrc[1]); fs.writeFileSync(path.join(root, 'build', 'seed.json'), JSON.stringify(seed)); }
else if (kind === 'static') { console.error('SEED not found inside the static shim'); process.exit(1); }
const builtAt = new Date().toISOString();
const shimNew = fs.readFileSync(path.join(root, 'tools', 'sb-shim.js'), 'utf8')
  .replace('__VERSION__', version).replace('__BUILT_AT__', builtAt).replace('__SUPABASE_URL__', URL_).replace('__SUPABASE_ANON_KEY__', ANON);
app = app.replace(shimOld, `<script src="${SUPABASE_JS}" crossorigin="anonymous"></script>\n<script>\n${shimNew}\n</script>`);
if (app.includes('var SEED = {')) { console.error('SEED still present after the swap'); process.exit(1); }
fs.writeFileSync(path.join(root, 'build', 'app.sb.html'), app);

// 2. the sign-in shell: the current gate page up to its script, with the Supabase sign-in instead
const gate = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cut = gate.indexOf('<script>');
if (cut < 0) { console.error('index.html has no <script>'); process.exit(1); }
let shell = gate.slice(0, cut);
shell = shell.replace(/<p class="foot">[\s\S]*?<\/p>/, `<p class="foot"><b>PT Tata Metal Lestari — internal pricing tool.</b><br>
  Sign in with your own account. Data is shared live between users and every change is logged.<br><span id="gbuild">Build ${builtAt.slice(0, 16).replace('T', ' ')} UTC</span></p>`);
if (!shell.includes('id="np-wrap"')) shell = shell.replace('<button id="signin" type="submit">Sign in</button>',   // idempotent: index.html may already be a shell
  `<div id="np-wrap" hidden><label for="newpw">New password</label><input id="newpw" name="newpw" type="password" autocomplete="new-password" minlength="8"></div>
      <button id="signin" type="submit">Sign in</button>
      <p class="links"><a href="#" id="forgot">Forgot password?</a></p>`);
if (!shell.includes('.links {')) shell = shell.replace('</style>', `  .links { margin: 12px 0 0; font-size: 13px; text-align: center; } .links a { color: var(--accent); }\n</style>`);
const shellJs = fs.readFileSync(path.join(root, 'tools', 'sb-shell.js'), 'utf8').replace('__SUPABASE_URL__', URL_).replace('__SUPABASE_ANON_KEY__', ANON);
shell += `<script src="${SUPABASE_JS}" crossorigin="anonymous"></script>\n<script>\n${shellJs}\n</script>\n</body>\n</html>\n`;
fs.writeFileSync(path.join(root, 'build', 'index.sb.html'), shell);

console.log(`app bundle  build/app.sb.html   ${(app.length / 1024).toFixed(0)} KB  (${version}, built ${builtAt})`);
console.log(`sign-in     build/index.sb.html ${(shell.length / 1024).toFixed(0)} KB`);
console.log(seed ? `seed        build/seed.json     ${Object.keys(seed).length} documents` : 'seed        (input had no SEED; data stays in the database)');
