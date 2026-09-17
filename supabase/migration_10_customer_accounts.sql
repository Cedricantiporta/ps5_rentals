-- Run this in the Supabase SQL editor, AFTER migration_9_admin_role.sql has
-- been run (and its "insert into admins ..." step completed -- otherwise you
-- are still locked out and none of that matters here).
--
-- WHY: AUTOMATION-PLAN.md Phase 1 gives customers their own email+password
-- accounts (Supabase Auth), sharing the same auth.users table as the admin.
-- Signed-in customers need to read their OWN renter row and OWN rentals --
-- nothing else -- alongside the existing admin-only policies from
-- migration_9. This phase is deliberately READ-ONLY for customers: no
-- INSERT/UPDATE/DELETE on rentals from the client. Self-service rent/swap
-- comes in Phase 4 via server-side Edge Functions specifically so slot
-- availability, cooldowns and swap limits can be enforced somewhere a
-- customer can't tamper with -- letting customers write to `rentals` directly
-- now would just have to be locked back down later.
--
-- WHAT THIS DOES:
--   1. Adds `renters.auth_user_id` -- nullable, unique, FK to auth.users,
--      ON DELETE SET NULL. Nullable because most existing renters are
--      walk-ins with no account and must keep working exactly as before;
--      only renters who sign up (or get linked by the admin) get a value
--      here. ON DELETE SET NULL rather than CASCADE: if an auth user is ever
--      deleted, the renter's rental history is a business record and should
--      survive as an unlinked (walk-in-like) renter, not disappear.
--   2. Adds a `security definer` helper `is_own_rental(renter_id)`, mirroring
--      is_admin() from migration_9, and uses it for the rentals policy
--      instead of a plain correlated subquery on renters. Reasoning:
--        - It runs as the function owner (bypasses RLS by default), so it
--          resolves "does this renter row belong to me" without depending on
--          whatever SELECT policy happens to exist on `renters` at the time.
--          A plain subquery (`renter_id in (select id from renters where
--          auth_user_id = auth.uid())`) would happen to work today because
--          of the customer self-read policy added below, but that couples
--          the rentals policy's correctness to renters' policy set staying
--          exactly right -- fragile as more policies get added in later
--          phases. The helper decouples them, same as is_admin() decoupled
--          every other table from admins' own policy shape.
--        - No recursion risk: is_own_rental() only reads `renters`, never
--          `rentals`, so there's no cycle even though it's called FROM a
--          policy ON `rentals`.
--      The renters self-read policy itself stays a plain
--      `auth_user_id = auth.uid()` comparison (like admins' self-read policy
--      in migration_9) -- simplest possible check, nothing to decouple.
--   3. New customer SELECT policies are ADDITIVE alongside is_admin() --
--      migration_9's "for all using (is_admin())" policies keep working
--      unchanged for the admin. Postgres OR's multiple permissive policies
--      together, so a signed-in customer's new SELECT grant does not affect
--      what the admin can do, and vice versa.
--   4. `games` stays untouched here: "public can read games" (schema.sql)
--      already allows anyone, including a signed-in customer, to read every
--      game row -- confirmed by reading schema.sql, not assumed -- so a
--      customer's rentals query can join to games for the title with no
--      extra policy.
--   5. Adds `games.is_test boolean not null default false` for agent test
--      infrastructure (see test_games.sql): lets agents rent/swap against
--      fake games end-to-end without consuming slots on real inventory or
--      polluting the public catalog. Defaulting to false means every
--      existing game row is unaffected.
--
-- Safe to re-run: columns use "add column if not exists", the function uses
-- "or replace", and every "create policy" is preceded by "drop policy if
-- exists".

-- 1. Link a renter row to an auth.users account. Nullable -- walk-ins with
-- no account keep working untouched.
alter table renters
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

-- 2. Test-game flag (see test_games.sql for the actual test rows and
-- catalog.js for where this is used to hide them from the public catalog).
alter table games
  add column if not exists is_test boolean not null default false;

-- 3. Helper: does this rental's renter belong to the signed-in user?
-- security definer so it doesn't depend on renters' own SELECT policy set
-- (see header comment). Stable + narrow search_path, same as is_admin().
create or replace function is_own_rental(target_renter_id bigint)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from renters
    where id = target_renter_id and auth_user_id = auth.uid()
  );
$$;

grant execute on function is_own_rental(bigint) to authenticated, anon;

-- 4. renters -- a signed-in customer may read only their own row. Direct
-- comparison, no helper needed (nothing recursive here). Additive alongside
-- migration_9's "admin can manage renters" (for all, is_admin()).
drop policy if exists "customer can read own renter row" on renters;
create policy "customer can read own renter row" on renters
  for select using (auth_user_id = auth.uid());

-- 5. rentals -- a signed-in customer may read only rentals whose renter_id
-- resolves to their own renter row. Read-only on purpose (see header) --
-- no insert/update/delete policy for customers in this phase. Additive
-- alongside migration_9's "admin can manage rentals" (for all, is_admin()).
drop policy if exists "customer can read own rentals" on rentals;
create policy "customer can read own rentals" on rentals
  for select using (is_own_rental(renter_id));
