-- ============================================================================
-- Turbo Control Solutions - Supabase schema
--
-- Run this ONCE in the Supabase Dashboard: SQL Editor -> New query -> paste
-- this whole file -> Run.
--
-- Design notes:
--  - `repairs` and `customers` store the whole record as a single `data` jsonb
--    column, keyed by the app's existing camelCase field names exactly as-is.
--    This mirrors what the app already keeps in memory, so the frontend needs
--    almost no translation layer between JS objects and rows.
--  - `profiles` stays a normal relational table (not jsonb) because Row Level
--    Security policies need to read `role` cheaply and because it's tied 1:1
--    to Supabase's own `auth.users` table (real login accounts).
--  - Inventory, transactions, and Part Requests are NOT included here - they
--    already persist through the existing Google Sheets / Apps Script backend
--    and are left untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: one row per real login account, linked to Supabase Auth
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  role text not null default 'engineer',
  status text not null default 'Active',
  restrictions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Helper used by RLS policies below: the role of whoever is currently logged in.
-- security definer + a fixed search_path so it can read profiles regardless of
-- the caller's own row-level access, without being hijackable via search_path tricks.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Anyone logged in can read every profile (needed for "Assigned To" pickers,
-- audit trail names, the Ship-to/requested-by columns, etc.)
create policy "profiles_select_authenticated"
  on public.profiles for select
  using (auth.role() = 'authenticated');

-- Only a superadmin can create/edit/delete OTHER people's accounts.
-- (A user is still allowed to touch their own row, e.g. future self-service profile edits.)
create policy "profiles_insert_superadmin_or_self"
  on public.profiles for insert
  with check (id = auth.uid() or public.current_user_role() = 'superadmin');

create policy "profiles_update_superadmin_or_self"
  on public.profiles for update
  using (id = auth.uid() or public.current_user_role() = 'superadmin');

create policy "profiles_delete_superadmin"
  on public.profiles for delete
  using (public.current_user_role() = 'superadmin');

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table public.customers (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.customers enable row level security;

create policy "customers_all_authenticated"
  on public.customers for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- repairs (work orders / jobs)
-- ---------------------------------------------------------------------------
create table public.repairs (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.repairs enable row level security;

create policy "repairs_all_authenticated"
  on public.repairs for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- keep updated_at fresh on every write
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger customers_touch_updated_at
  before update on public.customers
  for each row execute function public.touch_updated_at();

create trigger repairs_touch_updated_at
  before update on public.repairs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Live sync: let every open browser tab/device receive changes to `repairs`
-- and `customers` immediately (Supabase Realtime), instead of only seeing
-- them after a manual page refresh. Safe to re-run — skips tables already
-- in the publication.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'repairs'
  ) then
    alter publication supabase_realtime add table public.repairs;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'customers'
  ) then
    alter publication supabase_realtime add table public.customers;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Done. Next steps (see AI_FEATURE_SETUP.md / chat instructions):
--  1. Create the first login accounts under Authentication -> Users -> Add user
--     (or let the app's User Management screen do it once the admin-users
--     serverless function is deployed).
--  2. For EVERY auth user you create, add a matching row in `profiles` with
--     the same id, giving them a role - otherwise they can log in but the
--     app won't know who they are. Example:
--
--     insert into public.profiles (id, email, name, role, status)
--     values ('<paste the auth user''s UUID here>', 'you@example.com', 'Your Name', 'superadmin', 'Active');
-- ---------------------------------------------------------------------------
