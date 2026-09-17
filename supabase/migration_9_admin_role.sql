-- Run this in the Supabase SQL editor (after schema.sql + migrations 2-8
-- have already run).
--
-- WHY: every policy on games / renters / rentals / rental_requests (and the
-- game-covers storage bucket) currently reads "auth.role() = 'authenticated'"
-- -- i.e. ANY logged-in user is treated as the admin. That was safe only
-- because public signup is disabled and there is exactly one account.
-- AUTOMATION-PLAN.md Phase 1 adds customer signups, so this must land first:
-- without it, the first customer to sign up gets full read/write/delete on
-- the whole business and can open the admin dashboard.
--
-- WHAT THIS DOES:
--   1. Adds an `admins` table -- a real admin allowlist, one row per admin
--      user (by their auth.users id). Nobody can INSERT into it from the
--      client; granting admin only ever happens by hand below.
--   2. Adds an `is_admin()` helper function instead of repeating
--      "exists (select 1 from admins where user_id = auth.uid())" in every
--      policy. It's `security definer`, owned by the role running this
--      migration (which owns the tables and therefore bypasses RLS by
--      default) -- so it can check `admins` membership without depending on
--      admins' own RLS policy. This also sidesteps the classic recursive-RLS
--      trap: the ONE policy placed directly ON `admins` (self-read, below)
--      does a plain `user_id = auth.uid()` comparison and never calls
--      is_admin(), so it never queries the table it protects.
--   3. Swaps every `auth.role() = 'authenticated'` policy for `is_admin()`
--      on games / renters / rentals / rental_requests / storage.objects.
--   4. Leaves every public/anon policy untouched: anyone can still read
--      games, insert into rental_requests, and view game-covers. Do NOT
--      remove those -- the public catalog and rental wizard depend on them.
--
-- Safe to re-run: every "create policy" is preceded by "drop policy if
-- exists", and the table/function use "if not exists" / "or replace".

-- 1. Admin allowlist.
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table admins enable row level security;

-- A user may check whether THEY are an admin (the client needs this to
-- decide whether the admin dashboard is allowed to load). No insert/update/
-- delete policy exists on purpose, for any role -- granting admin only ever
-- happens by hand in the SQL editor (see the bottom of this file).
drop policy if exists "user can read own admin row" on admins;
create policy "user can read own admin row" on admins
  for select using (user_id = auth.uid());

-- 2. Helper used by every policy below.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

grant execute on function is_admin() to authenticated, anon;

-- 3. games -- public read stays as-is; admin write now checks is_admin().
drop policy if exists "admin can write games" on games;
create policy "admin can write games" on games
  for all using (is_admin()) with check (is_admin());

-- 4. renters -- fully admin-only (unchanged shape, new check).
drop policy if exists "admin can manage renters" on renters;
create policy "admin can manage renters" on renters
  for all using (is_admin()) with check (is_admin());

-- 5. rentals -- fully admin-only (unchanged shape, new check).
drop policy if exists "admin can manage rentals" on rentals;
create policy "admin can manage rentals" on rentals
  for all using (is_admin()) with check (is_admin());

-- 6. rental_requests -- anon insert stays open; admin read/update/delete
-- now checks is_admin().
drop policy if exists "admin can read rental requests" on rental_requests;
create policy "admin can read rental requests" on rental_requests
  for select using (is_admin());

drop policy if exists "admin can update rental requests" on rental_requests;
create policy "admin can update rental requests" on rental_requests
  for update using (is_admin()) with check (is_admin());

drop policy if exists "admin can delete rental requests" on rental_requests;
create policy "admin can delete rental requests" on rental_requests
  for delete using (is_admin());

-- 7. game-covers storage bucket -- public view stays open; admin
-- upload/update/delete now also checks is_admin() (still requires the
-- "authenticated" role too, matching the original policies).
drop policy if exists "admin can upload game covers" on storage.objects;
create policy "admin can upload game covers" on storage.objects
  for insert to authenticated with check (bucket_id = 'game-covers' and is_admin());

drop policy if exists "admin can update game covers" on storage.objects;
create policy "admin can update game covers" on storage.objects
  for update to authenticated using (bucket_id = 'game-covers' and is_admin());

drop policy if exists "admin can delete game covers" on storage.objects;
create policy "admin can delete game covers" on storage.objects
  for delete to authenticated using (bucket_id = 'game-covers' and is_admin());

-- ============================================================================
-- STOP -- DO NOT SKIP THIS STEP.
--
-- The `admins` table starts EMPTY. The moment this migration finishes, every
-- policy above requires is_admin() = true, and nobody satisfies it yet --
-- including you. Run the rest of this file in the SAME session or you will
-- be locked out of /admin on your next page load.
--
-- 1. Find your user id:
--        select id, email from auth.users;
--
-- 2. Paste that id below (replacing the placeholder) and run this insert:
--
--    insert into admins (user_id) values ('PASTE-YOUR-USER-ID-HERE');
--
-- ============================================================================
