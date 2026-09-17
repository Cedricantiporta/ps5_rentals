-- Run this in the Supabase SQL editor, AFTER migration_9_admin_role.sql,
-- migration_10_customer_accounts.sql, and migration_12_renter_claiming_rpc.sql
-- have all been run (this depends on is_admin() from migration_9 and
-- is_own_rental() from migration_10; ensure_my_renter() from migration_12 is
-- what the client calls before submitting so a real renter_id exists to
-- attach).
--
-- WHY: rental_requests is the inbox catalog.js writes to when someone clicks
-- Rent -- today it carries game/slot/plan/amount and NO identity at all. A
-- signed-in customer's request looks identical to a stranger's, so the admin
-- has no way to know it's the same person as the account in Renters, and can
-- easily create a duplicate renter row instead of using the real one. This
-- migration adds the missing link so "register -> rent -> admin approves"
-- lands in the customer's own account with no manual matching.
--
-- DESIGN DECISIONS:
--
-- 1. Column: `rental_requests.renter_id bigint references renters(id)`,
--    matching the type/target `rentals.renter_id` already uses so the admin
--    can treat it the same way once wiring a request into a real rental.
--    NULLABLE, on purpose: logged-out visitors are the majority path today
--    and must keep submitting requests with zero identity, exactly as
--    before. `on delete set null` (not `restrict`, unlike rentals.renter_id)
--    because this table is a low-stakes inbox, not the business's rental
--    ledger -- if a renter row is ever deleted, losing the identity tag on
--    an old inbox entry is fine; blocking the delete over it is not.
--
-- 2. Security -- this is the part that actually matters. Before this
--    migration, `rental_requests` has exactly one INSERT policy:
--        create policy "anyone can submit a rental request" on rental_requests
--          for insert to anon with check (true);
--    (see migration_2_requests.sql / schema.sql). Two consequences of
--    adding a raw renter_id column under that policy, both unacceptable:
--      a) `with check (true)` would let ANY caller -- anon or, once signed
--         in, authenticated -- pass any renter_id integer at all, including
--         someone else's. A malicious signed-in customer could submit a
--         request claiming to be renter #1 and have it show up in that
--         other person's account once approved.
--      b) The policy is scoped `to anon` only. A signed-in customer's
--         Supabase session runs as Postgres role `authenticated`, not
--         `anon` -- so today a signed-in customer cannot INSERT into
--         rental_requests at all (no policy grants it), which would break
--         the rent flow for exactly the customers this migration is for.
--    Fix: replace the single anon-only policy with one policy covering both
--    `anon` and `authenticated`, whose WITH CHECK allows a null renter_id
--    unconditionally (the anonymous path, unchanged) OR a non-null
--    renter_id only when it resolves to the CALLER'S OWN renter row.
--    Ownership is checked via `is_own_rental(renter_id)` -- migration_10's
--    existing helper, reused as-is rather than duplicated. It already means
--    exactly "renter_id belongs to auth.uid()" (it was written for the
--    rentals policy, but the check has nothing rentals-specific in it -- it
--    only ever looks at renters), it's `security definer` so it doesn't
--    depend on renters' own SELECT policy shape, and it's already granted
--    EXECUTE to both `anon` and `authenticated`. For an anon caller,
--    auth.uid() is null, so `is_own_rental()` can never resolve true for any
--    renter_id -- meaning an anon request is only ever accepted with
--    renter_id null, identical to today's behavior. For an authenticated
--    caller, it can only ever be true for a renter_id that is genuinely
--    theirs. Forging someone else's renter_id is therefore rejected by
--    Postgres itself at insert time, not by client-side trust.
--
-- 3. Admin SELECT: no new policy needed. RLS is enforced per-ROW, not
--    per-column -- migration_9's existing "admin can read rental requests"
--    policy (`for select using (is_admin())`) already exposes every column
--    on every row an admin can see, renter_id included, the moment the
--    column exists. Confirmed by reading migration_9_admin_role.sql rather
--    than assumed.
--
-- Safe to re-run: the column add uses "if not exists", the index uses
-- "if not exists", and the policy is dropped/recreated.

-- ============================================================================
-- 1. Identity column.
-- ============================================================================
alter table rental_requests
  add column if not exists renter_id bigint references renters(id) on delete set null;

create index if not exists rental_requests_renter_id_idx on rental_requests(renter_id);

-- ============================================================================
-- 2. Replace the anon-only, wide-open insert policy with one that covers
--    both anon and authenticated callers and cannot be used to forge
--    another customer's renter_id. See header for the full reasoning.
-- ============================================================================
drop policy if exists "anyone can submit a rental request" on rental_requests;
create policy "anyone can submit a rental request" on rental_requests
  for insert to anon, authenticated
  with check (
    renter_id is null
    or is_own_rental(renter_id)
  );

-- ============================================================================
-- 3. VERIFICATION -- read the actual result rows, not just "no red error
--    text" (a previous migration in this project silently failed to apply
--    and reported no error -- do not repeat that mistake here).
-- ============================================================================

-- Expect one row: renter_id, bigint, nullable = YES.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'rental_requests'
  and column_name = 'renter_id';

-- Expect exactly one row here: the insert policy, applying to both anon and
-- authenticated. If "authenticated" is missing from roles, signed-in
-- customers still cannot submit requests.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'rental_requests'
  and cmd = 'insert';

-- Confirms the FK actually points at renters(id) with ON DELETE SET NULL.
select
  tc.constraint_name,
  rc.delete_rule,
  ccu.table_name as references_table
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
where tc.table_schema = 'public'
  and tc.table_name = 'rental_requests'
  and tc.constraint_type = 'FOREIGN KEY';

-- Dependency sanity check: is_own_rental() must exist (from migration_10)
-- for the policy above to work at all. Expect one row.
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'is_own_rental';
