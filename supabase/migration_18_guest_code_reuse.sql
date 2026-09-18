-- ============================================================================
-- migration_18 -- a returning guest keeps one renter row and one code
--
-- WHAT WAS WRONG
-- create_rental_hold() only reused an existing renter for a SIGNED-IN
-- customer (p_renter_id + is_own_rental). Every anonymous rental therefore
-- inserted a brand new renter with a brand new public_code. Consequences:
--   * the customer's device kept their FIRST code, so their second rental
--     was invisible on the tracking page;
--   * the owner accumulated a duplicate renter per rental to merge by hand
--     -- the same duplicate problem that prompted the merge tool.
--
-- WHAT THIS DOES
-- Adds p_public_code. When a guest's device already holds a tracking code,
-- the site sends it and the same renter is reused. Knowing the code is
-- exactly the proof of identity lookup_rentals_by_code() already accepts,
-- so this grants no access that wasn't already available. Matching is
-- case-insensitive and tolerates a missing JD- prefix, like every other
-- code entry point. An unknown code falls through to creating a new renter
-- rather than failing the rental.
--
-- A signed-in customer still takes priority: p_renter_id wins when
-- is_own_rental() confirms it.
--
-- WITHOUT THIS: repeat anonymous customers fragment into several renters
-- and lose sight of their older rentals.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run. Safe to re-run.
-- Requires migration_17 (this supersedes the function it defines).
-- ============================================================================

-- The argument list changes, so the 6-arg version must go or both overloads
-- would exist and calls would be ambiguous.
drop function if exists create_rental_hold(text, text, text, bigint, text, text);

create or replace function create_rental_hold(
  p_game_slug text,
  p_slot text,
  p_plan text,
  p_renter_id bigint default null,
  p_name text default null,
  p_messenger text default null,
  p_public_code text default null
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
  v_code_norm text;
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
    select r.public_code into v_public_code from renters r where r.id = v_renter_id;
  end if;

  -- A returning guest: their device still holds the tracking code from a
  -- previous rental, so reuse that renter instead of minting a second one.
  -- Without this, every anonymous rental created a fresh renter row with a
  -- fresh code -- the customer's earlier rental vanished from their tracking
  -- page, and the owner got a duplicate renter to merge by hand every time.
  -- Knowing the code is the same proof of identity the tracking page
  -- already accepts, so this grants nothing new.
  if v_renter_id is null and nullif(trim(p_public_code), '') is not null then
    v_code_norm := upper(trim(p_public_code));
    if v_code_norm not like 'JD-%' then
      v_code_norm := 'JD-' || v_code_norm;
    end if;
    select r.id, r.public_code into v_renter_id, v_public_code
      from renters r where upper(r.public_code) = v_code_norm;
  end if;

  if v_renter_id is null then
    insert into renters (name, messenger_name)
    values (
      coalesce(nullif(trim(p_name), ''), 'Guest'),
      nullif(trim(p_messenger), '')
    )
    returning renters.id, renters.public_code into v_renter_id, v_public_code;
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
  returning rentals.id, rentals.ref_code into v_rental_id, v_ref_code;

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
  --
  -- But log it. The original version swallowed the message entirely, which
  -- is why an ambiguous-column bug looked identical to every other failure
  -- from the client side and cost a debugging round trip. The customer
  -- still only ever sees 'unexpected_error'; the detail goes to the
  -- Postgres logs (Supabase: Logs -> Postgres).
  raise warning 'create_rental_hold failed [%] % (slug=%, slot=%, plan=%)',
    sqlstate, sqlerrm, p_game_slug, p_slot, p_plan;
  return query select null::bigint, null::text, null::text, null::int,
    null::text, null::text, null::text, null::date, null::timestamptz,
    null::text, null::text, false, 'unexpected_error';
end;
$$;

grant execute on function create_rental_hold(text, text, text, bigint, text, text, text) to anon, authenticated;

-- ============================================================================
-- VERIFICATION -- expect TWO rows, both with the SAME public_code, and the
-- second on a different slot. Cleans up after itself and frees both slots.
-- ============================================================================
with first_rent as (
  select * from create_rental_hold('zz-test-game-a', 'trophy', 'weekly', null, 'ZZ Repeat Guest')
)
select 'first' as which, ok, error, public_code, ref_code from first_rent;

select 'second' as which, ok, error, public_code, ref_code
  from create_rental_hold(
    'zz-test-game-a', 'nontrophy', 'weekly', null, 'ZZ Repeat Guest', null,
    (select public_code from renters where name = 'ZZ Repeat Guest' limit 1)
  );

-- Both rows above should show the same JD- code. Now clean up.
delete from rentals where renter_id in (select id from renters where name = 'ZZ Repeat Guest');
delete from renters where name = 'ZZ Repeat Guest';
update games set trophy_available = true, trophy_available_at = null,
                 nontrophy_available = true, nontrophy_available_at = null
 where slug = 'zz-test-game-a';

-- Should print exactly one row (the 7-arg version only).
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'create_rental_hold';
