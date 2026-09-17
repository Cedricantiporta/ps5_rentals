-- Run this in the Supabase SQL editor, AFTER migration_9_admin_role.sql and
-- migration_10_customer_accounts.sql have both been run. This REPLACES
-- migration_11_renter_claiming.sql -- do not re-run migration_11.sql, and if
-- you haven't run it yet, skip it entirely and run this file instead.
--
-- WHY THIS FILE EXISTS (read before running):
--
-- migration_11 shipped two things: PART A, a trigger on auth.users that
-- auto-creates a renters row on signup, and PART B, the merge_renters()
-- admin function. The owner ran it and reported no error, but empirically
-- NEITHER object exists: a fresh signup gets no renters row, and calling
-- merge_renters() returns PGRST202 "could not find the function". Leading
-- theory: "create trigger ... on auth.users" requires privileges this
-- Supabase project's SQL-editor role doesn't have, that statement failed,
-- and because the SQL editor runs a whole pasted script as one transaction,
-- the failure rolled back merge_renters() too even though that half was
-- fine on its own. The "no error" report was very likely a missed/scrolled
-- error, not evidence the migration applied -- there is no world where the
-- trigger exists but a synchronous post-signup query sees no renters row.
--
-- MIGRATION_11's PART A (the trigger) IS SUPERSEDED BY THIS FILE. Do not
-- re-run migration_11.sql, even to "try again" -- it depends on auth.users
-- trigger privileges that may simply not be grantable on this project, and
-- retrying it risks the same silent-rollback failure mode. This file
-- replaces the trigger with a `security definer` RPC the client calls after
-- login instead -- no auth.users trigger, no elevated privilege required
-- beyond what a normal security definer function already gets (same pattern
-- as is_admin() / is_own_rental()).
--
-- WHAT THIS FILE DOES:
--   1. Defensively drops migration_11's trigger + trigger function, in case
--      they somehow *did* partially survive on some other project (wrapped
--      so a permissions error here can't abort this file).
--   2. Creates `ensure_my_renter()` -- a security definer RPC, callable by
--      any authenticated user, that creates a renters row for auth.uid() if
--      one doesn't exist yet, and is idempotent/safe under concurrent calls.
--      The portal calls this once per session, right after login, before
--      loading rentals (see site/account/shared.js). Because it keys off
--      auth_user_id (unique) and checks-then-inserts with an
--      "on conflict do nothing" safety net, calling it for an account that
--      already has a renters row is a cheap no-op -- which is exactly what
--      SELF-HEALS every orphaned account created while migration_11 was
--      silently broken (test signups, and the owner's own real-email
--      signup): the next time any of them logs in and the portal calls this
--      RPC, they get their renters row created right then, retroactively.
--   3. Re-creates `merge_renters()`, ported byte-for-byte from migration_11
--      PART B (it was reviewed and correct there -- the bug was only ever in
--      PART A). Needed again because it was rolled back along with
--      everything else in that transaction.
--   4. Ends with verification queries. Given the owner's "no error" report
--      on a migration that provably didn't apply, this file is written so
--      you check the RESULTS, not the absence of red text: the final
--      queries list the function(s) that now exist by name. If a row is
--      missing from that output, the migration did not fully apply -- full
--      stop, regardless of whether the editor showed an error.
--
-- Safe to re-run: the trigger cleanup uses "if exists", and both functions
-- use "or replace".

-- ============================================================================
-- 0. Defensive cleanup of migration_11 PART A, in case it partially exists.
-- ============================================================================
do $$
begin
  drop trigger if exists on_auth_user_created on auth.users;
exception when others then
  raise notice 'ensure_my_renter migration: could not drop on_auth_user_created (%) -- likely never existed, safe to ignore', sqlerrm;
end
$$;

do $$
begin
  drop function if exists handle_new_auth_user();
exception when others then
  raise notice 'ensure_my_renter migration: could not drop handle_new_auth_user() (%) -- likely never existed, safe to ignore', sqlerrm;
end
$$;

-- ============================================================================
-- 1. ensure_my_renter() -- call this from the client right after login.
-- ============================================================================
--
-- security definer + locked search_path, same hardening as is_admin()
-- (migration_9) and is_own_rental() (migration_10): runs as the owning role
-- so it isn't gated by RLS on renters, and can't be tricked via a hijacked
-- search_path.
--
-- Name derivation reads auth.users.email / raw_user_meta_data directly.
-- auth.users is never exposed through PostgREST (that's a schema-exposure
-- rule, not a grant), but a security definer function owned by the
-- migration-running role executes as that role, and that role DOES have
-- ordinary SELECT on auth.users in a standard Supabase project -- the same
-- assumption migration_11's trigger function relied on, and it's an
-- assumption worth verifying rather than repeating on faith. The select
-- below is wrapped in its own exception handler for exactly that reason: if
-- this project's migration role turns out NOT to have that privilege, this
-- function falls back to a generic "Customer <uid prefix>" name instead of
-- failing the whole login. The final verification block re-confirms which
-- path actually ran.
create or replace function ensure_my_renter()
returns table(renter_id bigint, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  existing_id bigint;
  new_id bigint;
  derived_name text;
  user_email text;
  user_meta jsonb;
begin
  if uid is null then
    raise exception 'ensure_my_renter: no authenticated user';
  end if;

  -- Fast path: already linked. This is what makes every call after the
  -- first one on any given account a cheap no-op, and it's also what makes
  -- calling this on EVERY page load safe -- no duplicate rows, no churn.
  select id into existing_id from renters where auth_user_id = uid;
  if existing_id is not null then
    return query select existing_id, false;
    return;
  end if;

  -- Best-effort name derivation from auth.users -- see header comment.
  -- Falls back to null/null on any error (insufficient privilege or
  -- otherwise) rather than failing the caller's login.
  begin
    select au.email, au.raw_user_meta_data into user_email, user_meta
    from auth.users au where au.id = uid;
  exception when others then
    user_email := null;
    user_meta := null;
  end;

  derived_name := coalesce(
    nullif(trim(user_meta ->> 'full_name'), ''),
    nullif(trim(user_meta ->> 'name'), ''),
    nullif(trim(split_part(coalesce(user_email, ''), '@', 1)), ''),
    'Customer ' || substr(uid::text, 1, 8)
  );

  -- Concurrency guard: auth_user_id is unique, so if two calls race (e.g.
  -- two tabs both loading right after signup), the second insert here is a
  -- no-op and falls through to the re-select below instead of erroring.
  insert into renters (name, auth_user_id, contact_note)
  values (
    derived_name,
    uid,
    'Auto-created via ensure_my_renter() on login (' || coalesce(user_email, uid::text) ||
      ') -- check Renters for a matching walk-in to merge into.'
  )
  on conflict (auth_user_id) do nothing
  returning id into new_id;

  if new_id is null then
    select id into existing_id from renters where auth_user_id = uid;
    return query select existing_id, false;
    return;
  end if;

  return query select new_id, true;
end;
$$;

grant execute on function ensure_my_renter() to authenticated;

-- ============================================================================
-- 2. merge_renters() -- ported unchanged from migration_11 PART B.
-- ============================================================================
-- Same admin merge tool: link an account to an existing walk-in renter,
-- and/or collapse a true duplicate (e.g. the two "Cedrok" rows). Not
-- redesigned -- it was reviewed and correct, it was only ever lost because
-- PART A's failure rolled back the whole migration_11 transaction.
create or replace function merge_renters(keep_id bigint, remove_id bigint)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  keep_auth uuid;
  remove_auth uuid;
  moved_count integer;
begin
  if not is_admin() then
    raise exception 'merge_renters: admin only';
  end if;
  if keep_id = remove_id then
    raise exception 'merge_renters: cannot merge a renter into itself';
  end if;
  if not exists (select 1 from renters where id = keep_id) then
    raise exception 'merge_renters: renter % (keep) not found', keep_id;
  end if;
  if not exists (select 1 from renters where id = remove_id) then
    raise exception 'merge_renters: renter % (remove) not found', remove_id;
  end if;

  select auth_user_id into keep_auth from renters where id = keep_id;
  select auth_user_id into remove_auth from renters where id = remove_id;

  if keep_auth is not null and remove_auth is not null and keep_auth <> remove_auth then
    raise exception 'merge_renters: both renters have a different linked account -- resolve manually';
  end if;

  -- Move every rental from the row being removed onto the row being kept.
  -- Usually a no-op for the account-link case (the new row is empty) but is
  -- exactly what a true duplicate merge needs.
  update rentals set renter_id = keep_id where renter_id = remove_id;
  get diagnostics moved_count = row_count;

  -- Carry the auth link over if the kept row doesn't already have one.
  -- auth_user_id is UNIQUE, so clear it off the row being removed first.
  if keep_auth is null and remove_auth is not null then
    update renters set auth_user_id = null where id = remove_id;
    update renters set auth_user_id = remove_auth where id = keep_id;
  end if;

  -- Don't silently lose a Messenger link or note that only exists on the
  -- row being removed.
  update renters k
  set messenger_name = coalesce(k.messenger_name, r.messenger_name),
      messenger_url = coalesce(k.messenger_url, r.messenger_url),
      contact_note = coalesce(k.contact_note, r.contact_note)
  from renters r
  where k.id = keep_id and r.id = remove_id;

  delete from renters where id = remove_id;

  return moved_count;
end;
$$;

grant execute on function merge_renters(bigint, bigint) to authenticated;

-- ============================================================================
-- 3. VERIFICATION -- run these last and read the actual output rows. Do
--    not rely on "no red error text" as proof -- that's exactly what went
--    wrong last time.
-- ============================================================================

-- Expect exactly 2 rows: ensure_my_renter, merge_renters. If either is
-- missing, this migration did not fully apply -- scroll up and find the
-- actual error, the SQL editor's transaction likely rolled back again.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ensure_my_renter', 'merge_renters')
order by p.proname;

-- Expect both functions listed with "authenticated" able to EXECUTE.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('ensure_my_renter', 'merge_renters')
order by routine_name, grantee;

-- Confirms migration_11's trigger is gone (or never existed) -- should
-- return ZERO rows. A row here means Part 0's cleanup above didn't run
-- cleanly and needs a look.
select tgname from pg_trigger where tgname = 'on_auth_user_created';

-- Sanity count of existing orphan accounts (auth.users with no renters row)
-- that ensure_my_renter() will self-heal the next time each one logs in.
-- Informational only -- do not expect this to be zero right after running
-- this migration; it only changes as each account logs in again.
select count(*) as orphan_auth_users_pending_self_heal
from auth.users u
where not exists (select 1 from renters r where r.auth_user_id = u.id);
