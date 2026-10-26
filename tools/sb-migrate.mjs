#!/usr/bin/env node
// Apply supabase/migrations/*.sql to the project database, each once, in order.
//   node tools/sb-migrate.mjs            apply pending migrations
//   node tools/sb-migrate.mjs --status   list applied / pending
// .env.build: DATABASE_URL (the project's Postgres connection string, Settings → Database → Connection string, URI).
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env.build'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
if (!env.DATABASE_URL) { console.error('DATABASE_URL must be in .env.build'); process.exit(2); }
const dir = path.join(root, 'supabase', 'migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())');
const done = new Set((await client.query('select name from public._migrations')).rows.map(r => r.name));
for (const f of files) {
  if (done.has(f)) { console.log('applied   ', f); continue; }
  if (process.argv.includes('--status')) { console.log('pending   ', f); continue; }
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into public._migrations (name) values ($1)', [f]);
    await client.query('commit');
    console.log('ran       ', f);
  } catch (e) {
    await client.query('rollback');
    console.error('FAILED    ', f, '\n', e.message);
    await client.end(); process.exit(1);
  }
}
await client.end();
