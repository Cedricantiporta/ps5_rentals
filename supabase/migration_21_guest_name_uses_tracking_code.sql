-- ============================================================================
-- migration_21 -- a nameless renter's name is their tracking code, not "Guest"
--
-- WHY: create_rental_hold() has always defaulted a brand-new anonymous
-- renter's name to the literal string 'Guest' when the customer didn't type
-- one. Every such renter then looks IDENTICAL in the admin tables (Pending
-- Payments, Rentals, Renters -- anywhere renters.name is shown) -- there is
-- no way to tell two different "Guest" rows apart at a glance without
-- opening each one to check its tracking code separately. Using the
-- renter's own public_code ("JD-XXXXXX") as their name instead makes every
-- nameless renter distinct and immediately identifiable in every table that
-- already shows renters.name, with zero client-side changes needed.
--
-- WHAT THIS DOES
-- 1. create_rental_hold() -- unchanged in every other respect (this is the
--    full function from migration_20, redefined with one addition, not
--    diffed) -- now follows up a nameless renter's INSERT with an UPDATE
--    setting name = the tracking code the table's own trigger just
--    generated. Can't be done in the INSERT itself: public_code is filled
--    in by the renters_set_public_code BEFORE INSERT trigger
--    (migration_14), whose result isn't visible to that same statement's
--    VALUES() clause -- hence the separate UPDATE right after, still inside
--    the same function call/transaction so nothing external ever observes
--    the intermediate 'Guest' value.
-- 2. One-time backfill: any renter already named exactly 'Guest' from
--    before this fix gets renamed to their own public_code too, so
--    existing data matches new data instead of only new rentals being
--    fixed going forward.
--
-- WITHOUT THIS: every walk-in/self-serve customer who doesn't type a name
-- keeps showing up as an indistinguishable "Guest" in every admin table.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run. Safe to re-run.
-- ============================================================================

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

    -- No real name given -- use the renter's own tracking code as their
    -- display name instead of the generic 'Guest' placeholder above, which
    -- is identical (and therefore useless for telling anyone apart) across
    -- every anonymous customer. public_code isn't known until after the
    -- INSERT (it's filled in by that table's own BEFORE INSERT trigger),
    -- so this has to be a follow-up UPDATE rather than something the
    -- INSERT can do in one shot.
    if nullif(trim(p_name), '') is null then
      update renters set name = v_public_code where id = v_renter_id;
    end if;
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
-- One-time backfill for renters created before this fix.
-- ----------------------------------------------------------------------------
update renters set name = public_code
where name = 'Guest' and public_code is not null;

-- ============================================================================
-- VERIFICATION -- exercises the exact insert-then-update mechanic in
-- isolation (a throwaway renter row, deleted by its own captured id right
-- after), not the full create_rental_hold() RPC -- that would mean either
-- touching a real game's availability or juggling matching real rows back
-- out again afterward. This proves the same thing with zero risk to real
-- inventory or rental data.
-- ============================================================================
do $$
declare
  v_renter_id bigint;
  v_code text;
  v_name text;
begin
  insert into renters (name) values ('Guest') returning id, public_code into v_renter_id, v_code;
  update renters set name = v_code where id = v_renter_id;
  select name into v_name from renters where id = v_renter_id;
  delete from renters where id = v_renter_id;
  if v_name is distinct from v_code then
    raise exception 'expected renter name to equal its own tracking code (%), got %', v_code, v_name;
  end if;
  raise notice 'OK: nameless renter''s name became its tracking code (%), test row cleaned up', v_code;
end $$;

-- Should print 0 (no renter still shows the old generic placeholder).
select count(*) as renters_still_named_guest from renters where name = 'Guest';
