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

-- Replaces the original single "for all" policy with per-action ones so delete can be
-- locked down separately. Safe to re-run on a database that already has the old policy,
-- the new ones, or (on a fresh install) neither.
drop policy if exists "repairs_all_authenticated" on public.repairs;
drop policy if exists "repairs_select_authenticated" on public.repairs;
drop policy if exists "repairs_insert_authenticated" on public.repairs;
drop policy if exists "repairs_update_authenticated" on public.repairs;
drop policy if exists "repairs_delete_admin" on public.repairs;

create policy "repairs_select_authenticated"
  on public.repairs for select
  using (auth.role() = 'authenticated');

create policy "repairs_insert_authenticated"
  on public.repairs for insert
  with check (auth.role() = 'authenticated');

create policy "repairs_update_authenticated"
  on public.repairs for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Deleting a job record is permanent (unlike every other mutation here, which is an
-- upsert), so it's restricted to admin/superadmin at the database level -- the app's
-- own canDeleteRecords check only hides the button, it can't stop a direct API call.
create policy "repairs_delete_admin"
  on public.repairs for delete
  using (public.current_user_role() in ('admin', 'superadmin'));

-- ---------------------------------------------------------------------------
-- purchase_requests (anything the team asks Purchasing to buy)
--
-- One row per request, with all its line items inside `data.items` -- mirroring
-- the "one sheet per purchase list" way this was tracked in Excel before. Items
-- can be stock parts or one-off buys (tools, test equipment, consumables) that
-- are deliberately never added to the inventory.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_requests (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.purchase_requests enable row level security;

drop policy if exists "purchase_requests_select_authenticated" on public.purchase_requests;
drop policy if exists "purchase_requests_insert_authenticated" on public.purchase_requests;
drop policy if exists "purchase_requests_update_authenticated" on public.purchase_requests;
drop policy if exists "purchase_requests_delete_admin" on public.purchase_requests;

create policy "purchase_requests_select_authenticated"
  on public.purchase_requests for select
  using (auth.role() = 'authenticated');

create policy "purchase_requests_insert_authenticated"
  on public.purchase_requests for insert
  with check (auth.role() = 'authenticated');

create policy "purchase_requests_update_authenticated"
  on public.purchase_requests for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "purchase_requests_delete_admin"
  on public.purchase_requests for delete
  using (public.current_user_role() in ('admin', 'superadmin'));

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

drop trigger if exists purchase_requests_touch_updated_at on public.purchase_requests;
create trigger purchase_requests_touch_updated_at
  before update on public.purchase_requests
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
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'purchase_requests'
  ) then
    alter publication supabase_realtime add table public.purchase_requests;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- email_accounts (each user's own connected @tcssb.com mailbox)
--
-- One row per user (id = their auth.users id), holding their cPanel IMAP/SMTP
-- host settings and their mailbox password, encrypted with a server-only key
-- before it ever reaches this table (see api/_lib/crypto.js) - Supabase itself
-- never sees the plaintext password. Only ever read/written by the email-*
-- serverless functions using the service_role key; RLS below only guards what an
-- ordinary logged-in client can see, which is deliberately nothing but presence,
-- since encrypted_password should never be selectable from the browser at all.
-- ---------------------------------------------------------------------------
create table if not exists public.email_accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  imap_host text not null,
  imap_port integer not null default 993,
  smtp_host text not null,
  smtp_port integer not null default 465,
  encrypted_password text not null,
  last_uid bigint not null default 0,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.email_accounts enable row level security;

drop policy if exists "email_accounts_select_self" on public.email_accounts;
create policy "email_accounts_select_self"
  on public.email_accounts for select
  using (id = auth.uid());

-- No insert/update/delete policies: only the service_role key (server-side
-- functions, which bypass RLS) writes this table, so a stolen anon-key session
-- can at most read that a mailbox is connected - never its password.

-- ---------------------------------------------------------------------------
-- emails (synced inbox + sent copies for each user's connected mailbox)
-- ---------------------------------------------------------------------------
create table if not exists public.emails (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.emails enable row level security;

drop policy if exists "emails_select_owner" on public.emails;
drop policy if exists "emails_update_owner" on public.emails;
create policy "emails_select_owner"
  on public.emails for select
  using (owner_id = auth.uid());

create policy "emails_update_owner"
  on public.emails for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- No insert/delete policies for ordinary clients: rows are only ever created by
-- email-sync.js / email-send.js (service_role). The update policy above exists
-- so the app can mark a message read/unread directly from the browser.

drop trigger if exists emails_touch_updated_at on public.emails;
create trigger emails_touch_updated_at
  before update on public.emails
  for each row execute function public.touch_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'emails'
  ) then
    alter publication supabase_realtime add table public.emails;
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
