-- TML Cost Calculator — Supabase schema, migration 0001.
-- Everything the page stores lives in four tables; access is enforced by Row Level Security
-- (RLS) from the user's role in public.profiles, so the anon key in the page can read nothing.
--
--   profiles      one row per auth user: name, role, active flag (inactive = no access at all)
--   documents     the calculator's documents by path: master/*, months/*, deals/*, quotes/*, docs/*
--   activity_log  append-only log of every change (who, what, which values)
--   hist          customer shipment history for the Order documents tab (was hist/*.json)
--   storage: bucket "app" (private) holds app.html, the calculator itself, served only to active users

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique,
  name        text not null default '',
  role        text not null default 'viewer'
              check (role in ('admin', 'costing', 'purchasing', 'vicegm', 'exim', 'viewer')),
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- a new auth user gets an INACTIVE viewer profile; an admin (or the seed script) activates it
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- the caller's role, null when the account is missing or inactive (security definer: no RLS recursion)
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- which collections a role may write; reading is the same for every active role
create or replace function public.can_write(col text)
returns boolean language sql stable as $$
  select coalesce(case public.my_role()
    when 'admin'      then true
    when 'costing'    then col in ('master', 'months', 'quotes', 'docs', 'deals')
    when 'purchasing' then col in ('months', 'quotes', 'docs')
    when 'vicegm'     then col in ('quotes', 'docs')
    when 'exim'       then col in ('quotes', 'docs')
    else false end, false)
$$;

alter table public.profiles enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.my_role() is not null or id = auth.uid());
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- ---------------------------------------------------------------- documents
create table if not exists public.documents (
  path        text primary key check (path ~ '^[a-z]+/[^/]+$'),
  col         text generated always as (split_part(path, '/', 1)) stored,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);
create index if not exists documents_col_idx on public.documents (col);
alter table public.documents replica identity full;   -- realtime DELETE events carry the path

alter table public.documents enable row level security;
drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents for select to authenticated
  using (public.my_role() is not null);
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
  with check (public.can_write(col));
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
  using (public.can_write(col)) with check (public.can_write(col));
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
  using (public.can_write(col));

-- ---------------------------------------------------------------- activity_log
create table if not exists public.activity_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  uid     uuid not null default auth.uid(),
  name    text not null default '',
  role    text not null default '',
  op      text not null default '',
  path    text not null default '',
  area    text not null default '',
  what    text not null default '',
  action  text not null default '',
  detail  text not null default '',
  n       integer not null default 0,
  lines   jsonb not null default '[]'::jsonb
);
create index if not exists activity_log_at_idx on public.activity_log (at desc);

alter table public.activity_log enable row level security;
drop policy if exists log_read on public.activity_log;
create policy log_read on public.activity_log for select to authenticated
  using (public.my_role() is not null);
drop policy if exists log_insert on public.activity_log;
create policy log_insert on public.activity_log for insert to authenticated
  with check (uid = auth.uid() and public.my_role() is not null);
-- deliberately no update or delete policy: the log is append-only for every user

-- ---------------------------------------------------------------- hist
create table if not exists public.hist (
  key         text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.hist enable row level security;
drop policy if exists hist_read on public.hist;
create policy hist_read on public.hist for select to authenticated
  using (public.my_role() is not null);
drop policy if exists hist_admin on public.hist;
create policy hist_admin on public.hist for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- ---------------------------------------------------------------- realtime
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents') then
    alter publication supabase_realtime add table public.documents;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_log') then
    alter publication supabase_realtime add table public.activity_log;
  end if;
end $$;

-- ---------------------------------------------------------------- storage: the app bundle
insert into storage.buckets (id, name, public, file_size_limit)
values ('app', 'app', false, 20971520)
on conflict (id) do nothing;
drop policy if exists app_bundle_read on storage.objects;
create policy app_bundle_read on storage.objects for select to authenticated
  using (bucket_id = 'app' and public.my_role() is not null);
-- uploads go through the service role (tools/sb-seed.mjs), never from the browser
