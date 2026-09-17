-- Run this in the Supabase SQL editor, AFTER migration_9_admin_role.sql and
-- migration_10_customer_accounts.sql have both been run.
--
-- WHY: migration_10 added `renters.auth_user_id` and the RLS to read it, but
-- nothing ever SETS it. A real customer signup today creates an auth.users
-- row and stops there -- no renters row, so the portal shows "No rental
-- history linked yet" forever. Meanwhile the business's real renters are
-- walk-ins the admin creates by hand over Messenger, with no account. This
-- migration closes that gap in two parts:
--
--   PART A -- new signups get a renter row automatically, via a trigger.
--   PART B -- admin tooling to merge that new empty row into the renter's
--             real (walk-in) history once they turn out to already be a
--             customer -- see site/admin/dashboard.js for the UI.
--
-- Safe to re-run: the trigger function/trigger use "or replace" / "drop ...
-- if exists", and merge_renters() is "or replace".

-- ============================================================================
-- PART A -- auto-create a renter row when someone signs up.
-- ============================================================================
--
-- This is a Postgres trigger on auth.users, not client-side JS, deliberately:
--   - A client can't skip or race it -- it fires inside the same transaction
--     that creates the auth.users row, before signUp() even returns.
--   - It works unmodified for any future auth provider (Google OAuth is
--     planned) -- auth.users gets a row the same way regardless of provider,
--     so there's nothing provider-specific to add later.
--   - Customers have no INSERT policy on `renters` (migration_10 is
--     deliberately read-only for them) -- a browser literally cannot create
--     this row itself, so *something* server-side has to.
-- This is also the officially documented Supabase pattern for "create a
-- profile row on signup" (a SECURITY DEFINER trigger function on
-- auth.users), which is why a normal migration script is allowed to create a
-- trigger on a table it doesn't own -- Supabase grants the SQL-editor role
-- what it needs for exactly this.
--
-- Name: email local-part is the fallback, but a signed-in Google user (once
-- that provider is added) carries a real display name in
-- raw_user_meta_data ('full_name' or 'name', depending on the flow) --
-- prefer that when present, since "juan.delacruz847" in the admin's Renters
-- table is a worse experience than "Juan Dela Cruz" for zero extra cost.
-- Today's email+password signup never sets this metadata, so in practice
-- every new row still falls back to the email local-part -- that's expected
-- and fine, the admin already resolves these by hand (see Part B).
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  derived_name text;
begin
  -- Idempotency / race guard: auth_user_id is unique on renters, so a second
  -- fire for the same user (shouldn't happen for a fresh INSERT, but costs
  -- nothing to guard) must not error out or create a duplicate.
  if exists (select 1 from renters where auth_user_id = new.id) then
    return new;
  end if;

  derived_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(trim(split_part(new.email, '@', 1)), ''),
    'Customer ' || substr(new.id::text, 1, 8)
  );

  insert into renters (name, auth_user_id, contact_note)
  values (
    derived_name,
    new.id,
    'Auto-created on signup (' || coalesce(new.email, new.id::text) ||
      ') -- check Renters for a matching walk-in to merge into.'
  )
  on conflict (auth_user_id) do nothing;

  return new;
end;
$$;

-- Walk-in renters (auth_user_id is null) are completely untouched by this --
-- this trigger only ever fires on a NEW auth.users row, which has nothing to
-- do with rows the admin already created by hand.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ============================================================================
-- PART B -- admin merge tool (link an account to an existing walk-in renter,
-- and/or collapse a true duplicate like the two "Cedrok" rows).
-- ============================================================================
--
-- The real case Part A creates: someone who's rented for months over
-- Messenger finally signs up. They now have a NEW EMPTY renter row (from the
-- trigger above) plus their real history on their OLD walk-in row. The admin
-- needs one action that fixes this.
--
-- Merge semantics -- KEEP the row with the real history, DELETE the empty
-- one, rather than the reverse:
--   - rentals.renter_id is "on delete restrict", so whichever row still has
--     rentals pointing at it CANNOT be deleted until those rentals are moved
--     off it. The walk-in row is exactly the one with rentals, so deleting
--     it is the expensive path no matter which direction you go.
--   - Moving auth_user_id (one column, one row) is cheap and lossless: the
--     kept row's id, created_at, messenger_url, contact_note, and every
--     existing rentals.renter_id reference are untouched. The row being
--     removed is -- by construction of Part A -- brand new and empty, so
--     deleting it loses nothing (rentals.renter_id "restrict" would refuse
--     the delete anyway if it somehow wasn't empty, catching the mistake
--     rather than silently discarding history).
--   - The alternative (move every rentals row from old to new, then delete
--     the old row) throws away the old row's id and forces rewriting an
--     unbounded number of rentals rows for a case that's supposed to be
--     "one column, one click." Worse for no benefit here.
-- Given that, this function is written as a general "merge renter B into
-- renter A" primitive (move any rentals B has, reconcile auth_user_id,
-- delete B) rather than a narrow "attach this account" special case --
-- because the exact same primitive also collapses a true duplicate (the two
-- "Cedrok" rows), where the row being removed does have rentals to carry
-- over. It deliberately stops there: it does NOT try to fuzzy-match or
-- suggest which renters are duplicates -- the admin picks both sides. That's
-- the account-linking feature and the "Cedrok" cleanup falling out of the
-- same tool, not a general dedupe feature.
--
-- security definer + locked search_path, same reasoning as is_admin() /
-- is_own_rental(): runs as the owning role so it isn't gated by whatever
-- policies exist on renters/rentals, and can't be tricked via a hijacked
-- search_path. Unlike those two, this one WRITES, so it re-checks is_admin()
-- itself as the actual authorization gate -- granting EXECUTE to
-- "authenticated" only controls who can attempt the call, not who is allowed
-- to succeed.
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
