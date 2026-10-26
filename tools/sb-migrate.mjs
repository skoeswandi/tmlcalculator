#!/usr/bin/env node
// Apply supabase/migrations/*.sql to the project database, each once, in order.
//   node tools/sb-migrate.mjs            apply pending migrations
//   node tools/sb-migrate.mjs --status   list applied / pending
// .env.build, one of:
//   SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF   runs the SQL through the Management API (what `supabase login` gives)
//   DATABASE_URL                                     connects directly with pg (Settings → Database → Connection string)
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env.build'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const dir = path.join(root, 'supabase', 'migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const statusOnly = process.argv.includes('--status');

let run;   // (sql, params?) -> rows
let end = async () => {};
if (env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_PROJECT_REF) {
  const url = `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`;
  run = async (sql) => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 600)}`);
    try { return JSON.parse(text); } catch (e) { return []; }
  };
  console.log('via Management API, project', env.SUPABASE_PROJECT_REF);
} else if (env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  run = async (sql, params) => (await client.query(sql, params)).rows;
  end = () => client.end();
  console.log('via direct Postgres connection');
} else { console.error('Need SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF, or DATABASE_URL, in .env.build'); process.exit(2); }

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
await run('create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now()); alter table public._migrations enable row level security;');   // no policies: only the service role reads it
const done = new Set((await run('select name from public._migrations')).map(r => r.name));
for (const f of files) {
  if (done.has(f)) { console.log('applied   ', f); continue; }
  if (statusOnly) { console.log('pending   ', f); continue; }
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    // one transaction: the migration and its bookkeeping row succeed or fail together
    await run(`begin;\n${sql}\ninsert into public._migrations (name) values (${q(f)});\ncommit;`);
    console.log('ran       ', f);
  } catch (e) {
    try { await run('rollback'); } catch (x) {}
    console.error('FAILED    ', f, '\n', e.message);
    await end(); process.exit(1);
  }
}
await end();
