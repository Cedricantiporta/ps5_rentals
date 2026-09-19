-- ============================================================================
-- migration_20 -- real multi-person queueing for pre-release reservations
--
-- WHAT WAS WRONG
-- create_rental_hold() (migrations 15/17/18) treats every game identically:
-- the first successful call flips games.<slot>_available to false via a
-- compare-and-swap UPDATE, and every call after that gets 'slot_unavailable'.
-- That is correct for an ALREADY-RELEASED game (only one person can rent a
-- slot at a time) but wrong for an UPCOMING game -- the owner's actual rule
-- is that up to N customers (default 50) can queue for the same slot before
-- release day, tracked by rentals.queue_position (see
-- migration_6_reservation_queue.sql). Today only the very first customer to
-- self-serve a reservation on a pre-release title succeeds; everyone after
-- them is incorrectly rejected as if the slot were already taken.
--
-- The admin Reservations tab (this session, separately) already renders
-- queue_position correctly -- it has simply never been populated by more
-- than one row per game+slot, because nothing upstream of it has been
-- assigning queue positions past the first customer.
--
-- WHAT THIS DOES
-- create_rental_hold() now branches on the game's status:
--   * status = 'available' (or anything not 'upcoming'): UNCHANGED --
--     exactly today's one-at-a-time compare-and-swap on the boolean
--     <slot>_available column.
--   * status = 'upcoming': never touches the boolean available columns at
--     all (there is no "current occupant" pre-release -- availability for
--     upcoming titles is the separate OPEN/LIMITED/PRIORITY_LIST/CLOSED
--     reservation_status the admin sets manually on the Games tab, which
--     this migration does not touch). Instead it takes a row lock on the
--     game (select ... for update) to serialize concurrent reservers, counts
--     existing non-cancelled reservations for that exact game+slot, checks
--     it against a cap (settings.reservation_queue_limit, default 50), and
--     assigns the next sequential queue_position.
--
-- The function's return type gains `queue_position int` (null for an
-- ordinary rental, a number for a queued reservation) and a new error code
-- `reservation_full`. get_public_settings() gains `reservation_queue_limit`
-- so the client can show "you're #23 of 50" rather than just "#23".
--
-- WITHOUT THIS: only the first person to ever reserve a given upcoming
-- game's slot succeeds; every other customer is wrongly turned away.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run. Safe to re-run.
-- Supersedes migration_18's create_rental_hold and migration_15's
-- get_public_settings (both replaced in full below, not diffed).
-- ============================================================================

insert into settings (key, value)
select 'reservation_queue_limit', '50'
where not exists (select 1 from settings where key = 'reservation_queue_limit');

-- ----------------------------------------------------------------------------
-- create_rental_hold -- return type changes (adds queue_position), so the
-- prior 7-arg version must be dropped first.
-- ----------------------------------------------------------------------------
drop function if exists create_rental_hold(text, text, text, bigint, text, text, text);

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
  queue_position int,
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
  v_is_upcoming boolean;
  v_queue_limit int;
  v_queue_count int;
  v_queue_position int;
begin
  -- ---- validate slot/plan first, before touching any table -------------
  if p_slot not in ('trophy', 'nontrophy') then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, null::int, false, 'bad_slot';
    return;
  end if;

  if p_plan not in ('weekly', 'monthly') then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, null::int, false, 'bad_plan';
    return;
  end if;

  -- ---- fetch the game (plain read -- no lock needed yet) ---------------
  select * into v_game from games where slug = p_game_slug;
  if not found then
    return query select null::bigint, null::text, null::text, null::int,
      null::text, null::text, null::text, null::date, null::timestamptz,
      null::text, null::text, null::int, false, 'game_not_found';
    return;
  end if;

  v_is_upcoming := v_game.status = 'upcoming';

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
      null::text, null::text, null::int, false, 'no_price';
    return;
  end if;

  if v_is_upcoming then
    -- ---- PRE-RELEASE RESERVATION: many customers can queue for one slot.
    -- No boolean-availability compare-and-swap -- there is no "current
    -- occupant" before release day. Instead, lock the game row so
    -- concurrent reservers for this title serialize through one lock (the
    -- same role a compare-and-swap UPDATE plays for an available game),
    -- then count existing non-cancelled reservations for this exact
    -- game+slot and assign the next position.
    perform 1 from games where id = v_game.id for update;

    select value::int into v_queue_limit from settings where key = 'reservation_queue_limit';
    if v_queue_limit is null then
      v_queue_limit := 50;
    end if;

    select count(*) into v_queue_count
      from rentals
     where game_id = v_game.id
       and slot = p_slot
       and queue_position is not null
       and status in ('pending', 'active');

    if v_queue_count >= v_queue_limit then
      return query select null::bigint, null::text, null::text, null::int,
        null::text, null::text, null::text, null::date, null::timestamptz,
        null::text, null::text, null::int, false, 'reservation_full';
      return;
    end if;

    v_queue_position := v_queue_count + 1;
  else
    -- ---- ORDINARY RENTAL: unchanged one-at-a-time compare-and-swap -----
    if not v_avail then
      return query select null::bigint, null::text, null::text, null::int,
        null::text, null::text, null::text, null::date, null::timestamptz,
        null::text, null::text, null::int, false, 'slot_unavailable';
      return;
    end if;

    -- THE RACE: atomic check-and-flip. An UPDATE's WHERE clause is
    -- re-checked against the row's current committed value after the row
    -- lock is acquired, even under plain READ COMMITTED -- so if two of
    -- these run concurrently, Postgres serializes them on the row lock: the
    -- first to get the lock sees available = true, flips it to false, and
    -- commits; the second then gets the lock, re-evaluates the WHERE
    -- clause against the now-false value, matches zero rows, and RETURNING
    -- gives it nothing. Two static branches (not one dynamic-SQL UPDATE)
    -- because the column name depends on p_slot.
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
      return query select null::bigint, null::text, null::text, null::int,
        null::text, null::text, null::text, null::date, null::timestamptz,
        null::text, null::text, null::int, false, 'slot_unavailable';
      return;
    end if;

    v_queue_position := null;
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

  -- ---- dates + hold window ------------------------------------------------
  -- A queued reservation's "end date" is meaningless until it actually
  -- activates on release day (the admin flow already treats queued rows
  -- this way -- see the Reservations tab's queue-aware Activate button),
  -- but the column is not-null, so it still gets a placeholder based on the
  -- plan length; it is overwritten for real once the reservation activates.
  v_end_date := current_date + (case when p_plan = 'weekly' then 7 else 30 end);

  select value::int into v_hold_minutes from settings where key = 'hold_minutes';
  if v_hold_minutes is null then
    v_hold_minutes := 30;
  end if;
  -- A queued reservation is not holding a real slot the way an ordinary
  -- pending rental holds an available one -- there is nothing to expire it
  -- back out of, since v_avail was never flipped. hold_expires_at is still
  -- set (release_expired_holds() no-ops harmlessly on it since there's no
  -- boolean availability to restore), kept for column consistency and in
  -- case a future admin view wants to show "reserved N minutes ago".
  v_hold_expires := now() + (v_hold_minutes || ' minutes')::interval;

  insert into rentals (
    game_id, renter_id, slot, plan, amount, status, payment_status,
    start_date, end_date, hold_expires_at, queue_position
  ) values (
    v_game.id, v_renter_id, p_slot, p_plan, v_price, 'pending', 'pending',
    current_date, v_end_date, v_hold_expires, v_queue_position
  )
  returning rentals.id, rentals.ref_code into v_rental_id, v_ref_code;

  select value into v_gcash_number from settings where key = 'gcash_number';
  select value into v_gcash_name from settings where key = 'gcash_name';

  return query select
    v_rental_id, v_ref_code, v_public_code, v_price, p_plan, p_slot,
    v_game.title, v_end_date, v_hold_expires, v_gcash_number, v_gcash_name,
    v_queue_position, true, null::text;
  return;
exception when others then
  raise warning 'create_rental_hold failed [%] % (slug=%, slot=%, plan=%)',
    sqlstate, sqlerrm, p_game_slug, p_slot, p_plan;
  return query select null::bigint, null::text, null::text, null::int,
    null::text, null::text, null::text, null::date, null::timestamptz,
    null::text, null::text, null::int, false, 'unexpected_error';
end;
$$;

grant execute on function create_rental_hold(text, text, text, bigint, text, text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- get_public_settings -- adds reservation_queue_limit so the client can show
-- "you're #23 of 50" rather than a bare number. Return type changes, so the
-- existing function must be dropped first.
-- ----------------------------------------------------------------------------
drop function if exists get_public_settings();

create or replace function get_public_settings()
returns table (
  gcash_number text,
  gcash_name text,
  messenger_url text,
  hold_minutes int,
  swap_limit int,
  swap_limit_weekly int,
  swap_limit_monthly int,
  reservation_queue_limit int
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
    coalesce((max(value) filter (where key = 'swap_limit_weekly'))::int,
             (max(value) filter (where key = 'swap_limit'))::int, 1),
    coalesce((max(value) filter (where key = 'swap_limit_monthly'))::int,
             (max(value) filter (where key = 'swap_limit'))::int, 3),
    coalesce((max(value) filter (where key = 'reservation_queue_limit'))::int, 50)
  from settings;
exception when others then
  return query select null::text, null::text, null::text, 30, 2, 1, 3, 50;
end;
$$;

grant execute on function get_public_settings() to anon, authenticated;

-- ============================================================================
-- VERIFICATION -- read the actual rows.
-- ============================================================================

-- Expect ok=true, queue_position=1, then ok=true, queue_position=2, on the
-- SAME zz-test-game-a / trophy slot (an upcoming test row is created below
-- if needed) -- proving two reservers on the same not-yet-released slot both
-- succeed instead of the second one being rejected.
do $$
begin
  if not exists (select 1 from games where slug = 'zz-test-reservation-game') then
    insert into games (slug, title, status, trophy_weekly, trophy_monthly, nontrophy_weekly, nontrophy_monthly, is_test)
    values ('zz-test-reservation-game', 'ZZ Test Reservation Game', 'upcoming', 249, 699, 249, 699, true);
  end if;
end $$;

select 'first reserver' as which, ok, error, queue_position, ref_code
  from create_rental_hold('zz-test-reservation-game', 'trophy', 'weekly', null, 'ZZ Reserver One');

select 'second reserver' as which, ok, error, queue_position, ref_code
  from create_rental_hold('zz-test-reservation-game', 'trophy', 'weekly', null, 'ZZ Reserver Two');

-- Clean up the two rows and the test game this block created.
delete from rentals where renter_id in (select id from renters where name like 'ZZ Reserver%');
delete from renters where name like 'ZZ Reserver%';
delete from games where slug = 'zz-test-reservation-game';

-- Should print one row, args showing 7 parameters and a 14-column return.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'create_rental_hold';

select key, value from settings where key = 'reservation_queue_limit';
