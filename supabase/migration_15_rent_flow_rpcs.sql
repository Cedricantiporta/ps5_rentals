-- Run this in the Supabase SQL editor, AFTER migration_14_rent_flow_tables.sql
-- has been run (this depends on settings/renters.public_code/rentals.ref_code/
-- rentals.hold_expires_at, and on is_own_rental() from migration_10).
--
-- WHAT THIS DOES: implements the two public entry points of the self-serve
-- rent flow from RENT-FLOW-CONTRACT.md -- `create_rental_hold()` (customer
-- clicks Rent) and `get_public_settings()` (customer-facing pages need the
-- GCash/Messenger details without ever being allowed to read the `settings`
-- table directly). Names, argument names, and return column names below are
-- taken verbatim from the frozen contract -- client agents are already
-- coding against these exact shapes.
--
-- WHAT BREAKS IF THIS IS SKIPPED: the public rent flow has nothing to call --
-- the catalog page's Rent button and the settings-driven GCash panel both
-- fail (res.error from a missing function -- per the contract's own note,
-- client code is written to fail SOFT back to the current Messenger-only
-- flow in that case, so the site keeps working, just without self-serve).
--
-- Safe to re-run: both functions use "create or replace".

-- ============================================================================
-- create_rental_hold(...) -- security definer, so it bypasses RLS on
-- renters/rentals/games/settings BY DESIGN (that's the whole point -- an
-- anonymous customer has no RLS grant to insert into any of those tables
-- directly). Because RLS is bypassed, THIS FUNCTION is the only thing
-- standing between an anonymous caller and those tables, so every input is
-- validated by hand below rather than trusted. In particular the amount is
-- ALWAYS computed here from games.<slot>_<plan> -- there is no p_amount
-- parameter at all, so a client literally cannot send a price.
-- ============================================================================
create or replace function create_rental_hold(
  p_game_slug text,
  p_slot text,
  p_plan text,
  p_renter_id bigint default null,
  p_name text default null,
  p_messenger text default null
)
returns table (
  rental_id bigint,
  ref_code text,
  public_code text,
  amount int,
  plan text,
  slot text,
  game_title text,
  end_date date,
  hold_expires_at timestamptz,
  gcash_number text,
  gcash_name text,
  ok boolean,
  error text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game games%rowtype;
  v_price int;
  v_avail boolean;
  v_renter_id bigint;
  v_public_code text;
  v_rental_id bigint;
  v_ref_code text;
  v_end_date date;
  v_hold_minutes int;
  v_hold_expires timestamptz;
  v_gcash_number text;
  v_gcash_name text;
begin
  -- ---- validate slot/plan first, before touching any table -------------
  if p_slot not in ('trophy', 'nontrophy') then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, false, 'bad_slot';
    return;
  end if;

  if p_plan not in ('weekly', 'monthly') then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, false, 'bad_plan';
    return;
  end if;

  -- ---- fetch the game (plain read -- no lock needed yet) ---------------
  select * into v_game from games where slug = p_game_slug;
  if not found then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, false, 'game_not_found';
    return;
  end if;

  if p_slot = 'trophy' then
    v_avail := v_game.trophy_available;
    v_price := case when p_plan = 'weekly' then v_game.trophy_weekly else v_game.trophy_monthly end;
  else
    v_avail := v_game.nontrophy_available;
    v_price := case when p_plan = 'weekly' then v_game.nontrophy_weekly else v_game.nontrophy_monthly end;
  end if;

  if v_price is null then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, false, 'no_price';
    return;
  end if;

  if not v_avail then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, false, 'slot_unavailable';
    return;
  end if;

  -- ---- THE RACE: atomic check-and-flip ----------------------------------
  -- Two customers can call create_rental_hold() for the same game+slot at
  -- the same moment. The plain read above is NOT the guard -- it's only
  -- there to produce the right error code (no_price vs slot_unavailable)
  -- fast. The actual guard is this UPDATE ... WHERE <slot>_available = true
  -- ... RETURNING: an UPDATE's WHERE clause is re-checked against the
  -- row's current committed value AFTER the row lock is acquired, even
  -- under plain READ COMMITTED. So if two of these run concurrently,
  -- Postgres serializes them on the row lock -- the first to get the lock
  -- sees available = true, flips it to false, and commits; the second then
  -- gets the lock, re-evaluates the WHERE clause against the now-false
  -- value, matches zero rows, and RETURNING gives it nothing. That second
  -- caller falls into "not found" below and correctly loses the race with
  -- slot_unavailable -- it is impossible for both to win. This is the same
  -- compare-and-swap pattern as an atomic UPDATE-based mutex, and it needs
  -- no explicit SELECT ... FOR UPDATE because the UPDATE itself takes the
  -- lock. Two static branches (not one dynamic-SQL UPDATE) because the
  -- column name depends on p_slot and dynamic SQL isn't worth the risk here
  -- for a two-way choice.
  if p_slot = 'trophy' then
    update games set trophy_available = false, trophy_available_at = null
    where slug = p_game_slug and trophy_available = true
    returning * into v_game;
  else
    update games set nontrophy_available = false, nontrophy_available_at = null
    where slug = p_game_slug and nontrophy_available = true
    returning * into v_game;
  end if;

  if not found then
    -- Lost the race (or the plain read above was already stale) --
    -- nothing was mutated, safe to just report it.
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, false, 'slot_unavailable';
    return;
  end if;

  -- ---- renter: reuse caller's own renter row, or create a guest one -----
  -- p_renter_id is only honored if it is genuinely the caller's own row
  -- (is_own_rental checks auth.uid() -- always false for anon, so an anon
  -- caller can never make this branch true no matter what id it sends).
  -- Otherwise contract says: ignore it and use a new/guest renter.
  if p_renter_id is not null and is_own_rental(p_renter_id) then
    v_renter_id := p_renter_id;
    select public_code into v_public_code from renters where id = v_renter_id;
  else
    insert into renters (name, messenger_name)
    values (
      coalesce(nullif(trim(p_name), ''), 'Guest'),
      nullif(trim(p_messenger), '')
    )
    returning id, public_code into v_renter_id, v_public_code;
  end if;

  -- ---- dates + hold window ----------------------------------------------
  v_end_date := current_date + (case when p_plan = 'weekly' then 7 else 30 end);

  select value::int into v_hold_minutes from settings where key = 'hold_minutes';
  if v_hold_minutes is null then
    v_hold_minutes := 30;
  end if;
  v_hold_expires := now() + (v_hold_minutes || ' minutes')::interval;

  -- ---- create the pending rental (this IS the request -- contract
  -- decision #1: no parallel rental_requests row for this flow) ----------
  insert into rentals (
    game_id, renter_id, slot, plan, amount, status, payment_status,
    start_date, end_date, hold_expires_at
  ) values (
    v_game.id, v_renter_id, p_slot, p_plan, v_price, 'pending', 'pending',
    current_date, v_end_date, v_hold_expires
  )
  returning id, ref_code into v_rental_id, v_ref_code;

  select value into v_gcash_number from settings where key = 'gcash_number';
  select value into v_gcash_name from settings where key = 'gcash_name';

  return query select
    v_rental_id, v_ref_code, v_public_code, v_price, p_plan, p_slot,
    v_game.title, v_end_date, v_hold_expires, v_gcash_number, v_gcash_name,
    true, null::text;
  return;
exception when others then
  -- NEVER raise -- always hand back a row. Anything unexpected (a settings
  -- cast error, an unforeseen constraint, gen_code() exhausting its retry
  -- budget, etc.) lands here rather than bubbling up as a hard error to an
  -- anonymous client.
  return query select null::bigint, null::text, null::text, null::int,
    null::text, null::text, null::text, null::date, null::timestamptz,
    null::text, null::text, false, 'unexpected_error';
end;
$$;

grant execute on function create_rental_hold(text, text, text, bigint, text, text) to anon, authenticated;

-- ============================================================================
-- get_public_settings() -- security definer so it can read `settings`
-- (admin-only RLS) on behalf of anon/authenticated callers, and hands back
-- only the 5 columns public pages need -- never the raw key/value rows.
-- Contract lists this as "Callable by anon"; granted to authenticated too
-- since a signed-in customer needs the same GCash/Messenger details and
-- there's no reason to make them log out to see them (interpretation noted
-- in the commit message / final report).
-- ============================================================================
drop function if exists get_public_settings();
create or replace function get_public_settings()
returns table (
  gcash_number text,
  gcash_name text,
  messenger_url text,
  hold_minutes int,
  swap_limit int,
  swap_limit_weekly int,
  swap_limit_monthly int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    max(value) filter (where key = 'gcash_number'),
    max(value) filter (where key = 'gcash_name'),
    max(value) filter (where key = 'messenger_url'),
    coalesce((max(value) filter (where key = 'hold_minutes'))::int, 30),
    coalesce((max(value) filter (where key = 'swap_limit'))::int, 2),
    -- Per-plan allowances; fall back to the plan-agnostic swap_limit so a
    -- half-configured settings table still reports something usable.
    coalesce((max(value) filter (where key = 'swap_limit_weekly'))::int,
             (max(value) filter (where key = 'swap_limit'))::int, 1),
    coalesce((max(value) filter (where key = 'swap_limit_monthly'))::int,
             (max(value) filter (where key = 'swap_limit'))::int, 3)
  from settings;
exception when others then
  -- Defensive fallback (e.g. a non-numeric value hand-edited into
  -- hold_minutes/swap_limit) -- still hand back a usable row of defaults
  -- rather than erroring the public page.
  return query select null::text, null::text, null::text, 30, 2, 1, 3;
end;
$$;

grant execute on function get_public_settings() to anon, authenticated;

-- ============================================================================
-- VERIFICATION -- run these last and read the actual result rows.
-- ============================================================================

-- Expect 2 rows: create_rental_hold, get_public_settings. is_security_definer
-- must be TRUE for both.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as return_shape
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_rental_hold', 'get_public_settings')
order by p.proname;

-- Expect BOTH anon and authenticated able to EXECUTE both functions (4 rows
-- total).
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('create_rental_hold', 'get_public_settings')
order by routine_name, grantee;

-- Smoke test -- should return exactly one row of your real (or still
-- placeholder) GCash details, never an error.
select * from get_public_settings();
