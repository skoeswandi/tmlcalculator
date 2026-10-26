#!/usr/bin/env node
// Seed and publish to Supabase with the service role (never from the browser).
//   node tools/sb-seed.mjs --users     create the accounts in tools/sb-users.json and activate their profiles
//   node tools/sb-seed.mjs --docs      upsert build/seed.json into public.documents (skips rows the db already has newer)
//   node tools/sb-seed.mjs --hist      upsert build/order-docs-patch/hist/*.json into public.hist
//   node tools/sb-seed.mjs --app       upload build/app.sb.html as app.html in the private "app" bucket
//   node tools/sb-seed.mjs --all
// .env.build: SUPABASE_URL, SUPABASE_SERVICE_KEY, SB_INITIAL_PASSWORD (for --users)
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env.build'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be in .env.build'); process.exit(2); }
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const flags = new Set(process.argv.slice(2));
const want = (f) => flags.has('--all') || flags.has(f);
if (!flags.size) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n')); process.exit(0); }
const die = (m, e) => { console.error(m, e && (e.message || e)); process.exit(1); };

if (want('--users')) {
  const users = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'sb-users.json'), 'utf8'));
  const pw = env.SB_INITIAL_PASSWORD;
  if (!pw) die('SB_INITIAL_PASSWORD is not set in .env.build');
  const existing = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (existing.error) die('listUsers', existing.error);
  for (const u of users) {
    const em = u.email.toLowerCase();
    let au = existing.data.users.find(x => (x.email || '').toLowerCase() === em);
    if (!au) {
      const r = await sb.auth.admin.createUser({ email: em, password: pw, email_confirm: true, user_metadata: { name: u.name } });
      if (r.error) die('createUser ' + em, r.error);
      au = r.data.user; console.log('created   ', em);
    } else console.log('exists    ', em);
    const p = await sb.from('profiles').upsert({ id: au.id, email: em, name: u.name, role: u.role, active: u.active !== false, updated_at: new Date().toISOString() });
    if (p.error) die('profile ' + em, p.error);
    console.log('profile   ', em, u.role, u.active === false ? 'inactive' : 'active');
  }
}

if (want('--docs')) {
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'build', 'seed.json'), 'utf8'));
  const have = await sb.from('documents').select('path,updated_at');
  if (have.error) die('read documents', have.error);
  const cur = new Map((have.data || []).map(r => [r.path, r.updated_at]));
  const rows = [];
  for (const [p, d] of Object.entries(seed)) {
    const seedAt = d && d.updatedAt ? new Date(d.updatedAt).toISOString() : null;
    const dbAt = cur.get(p);
    if (dbAt && seedAt && new Date(dbAt) >= new Date(seedAt)) { console.log('kept      ', p, '(db is newer or same)'); continue; }
    rows.push({ path: p, data: d, updated_at: seedAt || new Date().toISOString() });
  }
  for (let i = 0; i < rows.length; i += 50) {
    const r = await sb.from('documents').upsert(rows.slice(i, i + 50));
    if (r.error) die('upsert documents', r.error);
  }
  console.log('documents ', rows.length, 'written,', cur.size, 'were in the db');
}

if (want('--hist')) {
  const dir = path.join(root, 'build', 'order-docs-patch', 'hist');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const rows = files.map(f => ({ key: f.slice(0, -5), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), updated_at: new Date().toISOString() }));
  for (let i = 0; i < rows.length; i += 20) {
    const r = await sb.from('hist').upsert(rows.slice(i, i + 20));
    if (r.error) die('upsert hist', r.error);
  }
  console.log('hist      ', rows.length, 'customer files');
}

if (want('--app')) {
  const file = path.join(root, 'build', 'app.sb.html');
  const body = fs.readFileSync(file);
  const r = await sb.storage.from('app').upload('app.html', body, { contentType: 'text/html; charset=utf-8', upsert: true, cacheControl: '0' });
  if (r.error) die('upload app.html', r.error);
  console.log('app bundle uploaded to bucket "app" as app.html,', (body.length / 1024).toFixed(0), 'KB');
}
