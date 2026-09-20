-- ============================================================================
-- migration_22 -- swapping to a pricier game now actually collects the
-- price difference, via the same self-serve GCash flow as a new rental
--
-- WHY: the swap picker (this session) already shows "Add ₱150" next to a
-- pricier candidate, but until now that was purely a label -- submit_swap_
-- request never charged anything, every swap stayed free regardless of
-- what it said. Per the owner: a pricier swap should prompt for GCash
-- payment of the difference before the request can be approved. A
-- same-price or cheaper swap is unaffected -- still free, still submitted
-- and approved exactly as before.
--
-- WHAT THIS DOES
-- 1. swap_requests gains `price_diff int not null default 0` (the upcharge,
--    computed server-side from the catalog's own prices -- never trusted
--    from the client) and `payment_status text not null default
--    'not_required'` ('not_required' | 'pending' | 'paid').
-- 2. submit_swap_request(...) -- same signature/return shape as before,
--    plus one new output column `price_diff`. Computes it as
--    greatest(new game's price for this rental's plan - old game's price,
--    0) using games.trophy_weekly/monthly as the one representative price
--    per game+plan (Trophy/Non-Trophy are priced identically across the
--    whole catalog -- same assumption the swap picker's price-tier display
--    already relies on). payment_status is 'pending' when price_diff > 0,
--    else 'not_required' -- nothing else about the function changes; the
--    target slot is still soft-held immediately on submission either way.
-- 3. approve_swap_request(...) now REFUSES (new error 'payment_not_
--    confirmed') to approve a request whose payment_status is still
--    'pending' -- a DB-level backstop, not just an admin-UI gate, so a
--    stale/reordered click can't approve an unpaid upcharge. The new
--    rental's `amount` becomes the old rental's amount PLUS price_diff
--    (was hardcoded 0) so revenue reporting reflects what was actually
--    paid across the original rental + this upcharge.
-- 4. Nothing here marks a payment as received -- that's a plain
--    swap_requests.payment_status update the admin dashboard does directly
--    (same pattern as every other admin mutation in this project), added
--    in the client-side commit alongside this migration.
-- 5. swap_generic_block_reason(...) gains a new p_created_at param and a new
--    rule: a rental can't be swapped (including its FIRST swap) until 24h
--    have passed since it was created. Per the owner: "when first rented,
--    then users cannot swap yet until 24 hours". Configurable via a new
--    'swap_min_hours_after_rental' settings row (defaults to 24, same
--    fallback pattern as swap_limit_for). New machine code 'too_new';
--    lookup_rentals_by_code turns it into a human sentence for the
--    swap_blocked_reason column, same treatment 'already_pending' already
--    gets there.
--
-- WITHOUT THIS: the "Add ₱150" label keeps being decorative -- swapping to
-- a pricier game stays free with nothing to collect the difference, and a
-- rental could be swapped the instant it's created.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run. Safe to re-run.
-- ============================================================================

alter table swap_requests add column if not exists price_diff int not null default 0;
alter table swap_requests add column if not exists payment_status text not null default 'not_required';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'swap_requests_payment_status_check'
  ) then
    alter table swap_requests add constraint swap_requests_payment_status_check
      check (payment_status in ('not_required', 'pending', 'paid'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- swap_generic_block_reason -- same 5 args as migration_16 plus one new
-- trailing p_created_at (defaulted, so no drop needed -- existing callers
-- that don't pass it keep working, they just skip the new rule).
-- ----------------------------------------------------------------------------
create or replace function swap_generic_block_reason(
  p_rental_id bigint, p_status text, p_end_date date, p_swap_count int,
  p_plan text default null, p_created_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int;
  v_min_hours int;
begin
  if p_status <> 'active' then
    return 'not_active';
  end if;

  if p_created_at is not null then
    select value::int into v_min_hours from settings where key = 'swap_min_hours_after_rental';
    v_min_hours := coalesce(v_min_hours, 24);
    if now() < p_created_at + (v_min_hours || ' hours')::interval then
      return 'too_new';
    end if;
  end if;

  if p_end_date < current_date + 1 then
    return 'too_close_to_end';
  end if;

  v_limit := swap_limit_for(p_plan);
  if p_swap_count >= v_limit then
    return 'swap_limit_reached';
  end if;

  -- CONTRACT-AMENDMENT-1: a rental can only ever have one swap request
  -- outstanding at a time.
  if exists (select 1 from swap_requests where rental_id = p_rental_id and status = 'pending') then
    return 'already_pending';
  end if;

  return null;
end;
$$;

-- ----------------------------------------------------------------------------
-- lookup_rentals_by_code -- same shape as migration_16, just passes
-- r.created_at into the block-reason check and gives 'too_new' the same
-- human-sentence treatment 'already_pending' already gets.
-- ----------------------------------------------------------------------------
create or replace function lookup_rentals_by_code(p_code text)
returns table (
  rental_id bigint, ref_code text, public_code text, renter_name text,
  game_slug text, game_title text, game_cover text, slot text, plan text,
  amount int, status text, payment_status text,
  start_date date, end_date date, days_left int,
  swap_count int, can_swap boolean, swap_blocked_reason text,
  pending_swap_id bigint, pending_swap_to_title text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    r.id, r.ref_code, rr.public_code, rr.name,
    g.slug, g.title, g.cover, r.slot, r.plan,
    r.amount, r.status, r.payment_status,
    r.start_date, r.end_date, greatest(0, r.end_date - current_date) as days_left,
    r.swap_count,
    (block.reason is null) as can_swap,
    case
      when block.reason = 'already_pending'
        then 'A swap request is already waiting for approval.'
      when block.reason = 'too_new'
        then 'Swaps open up 24 hours after your rental starts.'
      else block.reason
    end as swap_blocked_reason,
    sw.id as pending_swap_id,
    tg.title as pending_swap_to_title
  from rentals r
  join renters rr on rr.id = r.renter_id
  join games g on g.id = r.game_id
  left join lateral (
    select swap_generic_block_reason(r.id, r.status, r.end_date, r.swap_count, r.plan, r.created_at) as reason
  ) block on true
  left join swap_requests sw on sw.rental_id = r.id and sw.status = 'pending'
  left join games tg on tg.id = sw.to_game_id
  where code_matches(p_code, rr.public_code, r.ref_code)
  order by r.created_at desc;
exception when others then
  -- Never raise, never leak partial results on an unexpected error -- an
  -- empty set behaves identically to "unknown code" from the caller's side.
  return;
end;
$$;

grant execute on function lookup_rentals_by_code(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- submit_swap_request -- same 4 args as migration_16, return type gains
-- price_diff so the drop is required (return type changes).
-- ----------------------------------------------------------------------------
drop function if exists submit_swap_request(text, bigint, text, text);

create or replace function submit_swap_request(
  p_code text,
  p_rental_id bigint,
  p_new_game_slug text,
  p_new_slot text
)
returns table (
  ok boolean, error text, swap_request_id bigint, swap_ref_code text,
  from_game_title text, to_game_title text, to_slot text, swaps_left int,
  price_diff int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old rentals%rowtype;
  v_renter_public_code text;
  v_block_reason text;
  v_new_game_check games%rowtype;
  v_new_game games%rowtype;
  v_hold_hours int;
  v_hold_expires timestamptz;
  v_swap_id bigint;
  v_swap_ref_code text;
  v_from_game_title text;
  v_limit int;
  v_old_price int;
  v_new_price int;
  v_price_diff int;
  v_payment_status text;
begin
  -- ---- fetch + lock the rental being swapped ----------------------------
  select * into v_old from rentals where id = p_rental_id for update;
  if not found then
    return query select false, 'not_found', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  select public_code into v_renter_public_code from renters where id = v_old.renter_id;

  -- p_code authenticates against EITHER the renter's public_code or this
  -- specific rental's ref_code. Treat "code doesn't match" identically to
  -- "rental doesn't exist" -- never confirm a rental id exists to a caller
  -- who doesn't hold a matching code.
  if not code_matches(p_code, v_renter_public_code, v_old.ref_code) then
    return query select false, 'not_found', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  -- ---- the same rule set can_swap / swap_blocked_reason already told
  -- the UI about (status/end_date/swap_count/already_pending) ------------
  v_block_reason := swap_generic_block_reason(v_old.id, v_old.status, v_old.end_date, v_old.swap_count, v_old.plan, v_old.created_at);
  if v_block_reason is not null then
    return query select false, v_block_reason, null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  if p_new_slot not in ('trophy', 'nontrophy') then
    -- Not a distinct error in the amendment's vocabulary -- closest fit,
    -- same reasoning noted for create_rental_hold's slot validation.
    return query select false, 'slot_unavailable', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  select * into v_new_game_check from games where slug = p_new_game_slug;
  if not found then
    return query select false, 'slot_unavailable', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  if v_new_game_check.id = v_old.game_id and p_new_slot = v_old.slot then
    return query select false, 'same_game', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  -- ---- THE RACE: atomic check-and-hold on the target slot ---------------
  -- Same compare-and-swap as create_rental_hold(): the UPDATE's WHERE
  -- clause is re-checked against the row's current committed value once
  -- the row lock is acquired, so two concurrent submit_swap_request (or a
  -- create_rental_hold, or another submit_swap_request) calls targeting
  -- the same game+slot can't both succeed -- the loser sees zero rows from
  -- RETURNING and falls into "not found" below.
  if p_new_slot = 'trophy' then
    update games set trophy_available = false, trophy_available_at = null
    where slug = p_new_game_slug and trophy_available = true
    returning * into v_new_game;
  else
    update games set nontrophy_available = false, nontrophy_available_at = null
    where slug = p_new_game_slug and nontrophy_available = true
    returning * into v_new_game;
  end if;

  if not found then
    return query select false, 'slot_unavailable', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
    return;
  end if;

  select title into v_from_game_title from games where id = v_old.game_id;

  -- ---- price difference (server-computed, never trusted from the client)
  -- Trophy price is used as the one representative price per game+plan --
  -- same assumption the swap picker's own price-tier display already
  -- relies on (Trophy/Non-Trophy are priced identically across the whole
  -- catalog). Only an INCREASE is ever charged; a lateral or cheaper swap
  -- is free, same as before this migration.
  select (case when v_old.plan = 'monthly' then trophy_monthly else trophy_weekly end)
    into v_old_price from games where id = v_old.game_id;
  v_new_price := case when v_old.plan = 'monthly' then v_new_game.trophy_monthly else v_new_game.trophy_weekly end;
  v_price_diff := greatest(coalesce(v_new_price, 0) - coalesce(v_old_price, 0), 0);
  v_payment_status := case when v_price_diff > 0 then 'pending' else 'not_required' end;

  select value::int into v_hold_hours from settings where key = 'swap_hold_hours';
  if v_hold_hours is null then
    v_hold_hours := 24;
  end if;
  v_hold_expires := now() + (v_hold_hours || ' hours')::interval;

  insert into swap_requests (
    rental_id, renter_id, from_game_id, from_slot, to_game_id, to_slot,
    status, hold_expires_at, price_diff, payment_status
  ) values (
    v_old.id, v_old.renter_id, v_old.game_id, v_old.slot, v_new_game.id, p_new_slot,
    'pending', v_hold_expires, v_price_diff, v_payment_status
  )
  returning id, ref_code into v_swap_id, v_swap_ref_code;

  v_limit := swap_limit_for(v_old.plan);

  return query select
    true, null::text, v_swap_id, v_swap_ref_code,
    v_from_game_title, v_new_game.title, p_new_slot,
    greatest(0, v_limit - v_old.swap_count), v_price_diff;
  return;
exception when others then
  return query select false, 'unexpected_error', null::bigint, null::text, null::text, null::text, null::text, null::int, null::int;
end;
$$;

grant execute on function submit_swap_request(text, bigint, text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- approve_swap_request -- same signature/return shape as migration_16, just
-- the body changes (refuse on unpaid upcharge; carry price_diff into the
-- new rental's amount) -- no drop needed.
-- ----------------------------------------------------------------------------
create or replace function approve_swap_request(p_id bigint, p_note text default null)
returns table (ok boolean, error text, new_rental_id bigint, new_ref_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req swap_requests%rowtype;
  v_old rentals%rowtype;
  v_new_rental_id bigint;
  v_new_ref_code text;
begin
  if not is_admin() then
    return query select false, 'not_admin', null::bigint, null::text;
    return;
  end if;

  select * into v_req from swap_requests where id = p_id for update;
  if not found then
    return query select false, 'not_found', null::bigint, null::text;
    return;
  end if;
  if v_req.status <> 'pending' then
    return query select false, 'not_pending', null::bigint, null::text;
    return;
  end if;
  -- DB-level backstop, not just an admin-UI gate: a request that still
  -- needs its upcharge collected can never be approved, however this got
  -- called (a stale tab, a double-click racing a "Confirm Payment" click).
  if v_req.payment_status = 'pending' then
    return query select false, 'payment_not_confirmed', null::bigint, null::text;
    return;
  end if;

  select * into v_old from rentals where id = v_req.rental_id for update;
  if not found then
    return query select false, 'not_found', null::bigint, null::text;
    return;
  end if;

  -- End the old rental and free the slot it was occupying.
  update rentals set status = 'ended' where id = v_old.id;

  if v_req.from_slot = 'trophy' then
    update games set trophy_available = true, trophy_available_at = null where id = v_req.from_game_id;
  else
    update games set nontrophy_available = true, nontrophy_available_at = null where id = v_req.from_game_id;
  end if;

  -- Create the new rental. Target slot stays unavailable -- it's been held
  -- since submission; this is now a confirmed occupancy, not a hold, so
  -- hold_expires_at is explicitly null (never populated on this insert).
  -- amount carries the old rental's amount forward plus whatever upcharge
  -- was collected (0 for a free/lateral/cheaper swap, unchanged from
  -- before this migration) -- not the new game's own list price, so this
  -- rental's amount stays an honest record of what was actually paid
  -- across the original rental + this swap.
  insert into rentals (
    game_id, renter_id, slot, plan, amount, status, payment_status,
    start_date, end_date, swapped_from_rental_id, swap_count
  ) values (
    v_req.to_game_id, v_req.renter_id, v_req.to_slot, v_old.plan,
    v_old.amount + v_req.price_diff, 'active', 'paid',
    current_date, v_old.end_date, v_old.id, v_old.swap_count + 1
  )
  returning id, ref_code into v_new_rental_id, v_new_ref_code;

  update swap_requests set status = 'approved', handled_at = now(), admin_note = p_note
  where id = v_req.id;

  return query select true, null::text, v_new_rental_id, v_new_ref_code;
exception when others then
  return query select false, 'unexpected_error', null::bigint, null::text;
end;
$$;

grant execute on function approve_swap_request(bigint, text) to authenticated;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

select column_name, data_type, column_default from information_schema.columns
 where table_name = 'swap_requests' and column_name in ('price_diff', 'payment_status');

-- Should print one row, args showing 4 parameters and a 9-column return.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'submit_swap_request';

-- Should print one row, args showing 6 parameters (p_created_at added).
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'swap_generic_block_reason';

-- Smoke test -- an unknown code must still come back as zero rows, never an error.
select * from lookup_rentals_by_code('NO-SUCH-CODE-000000');
