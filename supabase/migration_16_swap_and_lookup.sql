-- Run this in the Supabase SQL editor, AFTER migration_14_rent_flow_tables.sql
-- and migration_15_rent_flow_rpcs.sql have both been run (this depends on
-- gen_code()/settings/rentals.ref_code/renters.public_code from migration_14,
-- and on is_admin()/is_own_rental() from migrations 9/10).
--
-- WHAT THIS DOES: implements the customer-facing code lookup, and the swap
-- flow -- per CONTRACT-AMENDMENT-1.md (committed on this branch, supersedes
-- ONLY the `request_swap` section of the originally frozen
-- RENT-FLOW-CONTRACT.md -- everything else in that file is unchanged):
-- swaps no longer auto-approve. A customer's swap SUBMISSION creates a
-- `swap_requests` row and soft-holds the target slot; an admin then
-- approves or declines it from a new admin-app tab. Names/argument
-- names/return columns below are taken verbatim from the amendment --
-- client agents are already coding against these exact shapes.
--
-- WHAT BREAKS IF THIS IS SKIPPED: the code-lookup page (public_code or
-- ref_code -> "my rentals") and the entire swap flow have nothing to call.
-- Per the contract's own client-call-shape note, client code fails soft
-- back to Messenger-only when an RPC is missing, so the site keeps working,
-- just without self-serve lookup/swap.
--
-- Safe to re-run: the table/index adds use "if not exists", functions use
-- "or replace", the policy/trigger are dropped-then-recreated, and
-- cron.schedule() upserts by job name.

-- ============================================================================
-- 1. swap_requests (CONTRACT-AMENDMENT-1). RLS on, admin-only via
--    is_admin() -- no anon/authenticated policy at all. Anon/authenticated
--    only ever touch this table through the security-definer RPCs below,
--    which bypass RLS by design (same reasoning as every other RPC in this
--    flow: an anonymous customer has no direct grant on this table).
-- ============================================================================
create table if not exists swap_requests (
  id bigint generated always as identity primary key,
  rental_id bigint not null references rentals(id) on delete cascade,
  renter_id bigint not null references renters(id) on delete cascade,
  from_game_id bigint not null references games(id),
  from_slot text not null,
  to_game_id bigint not null references games(id),
  to_slot text not null check (to_slot in ('trophy', 'nontrophy')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'expired')),
  ref_code text unique, -- 'S-XXXXXX', filled in by the trigger below
  hold_expires_at timestamptz,
  admin_note text,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);

alter table swap_requests enable row level security;

drop policy if exists "admin can manage swap requests" on swap_requests;
create policy "admin can manage swap requests" on swap_requests
  for all using (is_admin()) with check (is_admin());

-- ref_code is already covered by its UNIQUE constraint's auto-index (see
-- migration_14's reasoning for the same pattern on renters/rentals) -- only
-- the three columns the amendment actually asks for get an explicit index.
create index if not exists swap_requests_status_idx on swap_requests(status);
create index if not exists swap_requests_rental_id_idx on swap_requests(rental_id);
create index if not exists swap_requests_hold_expires_at_idx on swap_requests(hold_expires_at);

-- Every new swap_requests row gets an 'S-XXXXXX' code. gen_code('S') (from
-- migration_14) hits its generic "unknown prefix" branch -- it doesn't know
-- about this table (created here, after migration_14 runs) so it can't
-- collision-check against it itself; this trigger does that check locally
-- instead, same retry-loop shape as gen_code() uses internally.
create or replace function set_swap_request_ref_code()
returns trigger as $$
declare
  candidate text;
  attempt int := 0;
begin
  if new.ref_code is not null then
    return new;
  end if;
  loop
    attempt := attempt + 1;
    candidate := gen_code('S');
    exit when not exists (select 1 from swap_requests where ref_code = candidate);
    if attempt > 50 then
      raise exception 'set_swap_request_ref_code: could not find a unique code after % attempts', attempt;
    end if;
  end loop;
  new.ref_code := candidate;
  return new;
end;
$$ language plpgsql;

drop trigger if exists swap_requests_set_ref_code on swap_requests;
create trigger swap_requests_set_ref_code before insert on swap_requests
  for each row execute function set_swap_request_ref_code();

-- ============================================================================
-- 2. code_matches -- shared, case-insensitive, prefix-tolerant code
--    comparison used by both lookup_rentals_by_code() and
--    submit_swap_request()'s p_code authentication, so the two RPCs can
--    never disagree on what counts as a match. Strips whitespace and
--    upper-cases the input; if the input already carries a recognized
--    prefix ("JD-"/"R-") it's compared ONLY against the matching field
--    (precise); a bare/no-prefix input is compared against both (contract:
--    "tolerate a missing JD-/R- prefix").
-- ============================================================================
create or replace function code_matches(p_input text, p_public_code text, p_ref_code text)
returns boolean
language plpgsql
as $$
declare
  v_input text := upper(regexp_replace(trim(coalesce(p_input, '')), '\s+', '', 'g'));
  v_bare text;
begin
  if v_input = '' then
    return false;
  end if;

  if v_input like 'JD-%' then
    v_bare := substring(v_input from 4);
    return p_public_code is not null and upper(p_public_code) = 'JD-' || v_bare;
  elsif v_input like 'R-%' then
    v_bare := substring(v_input from 3);
    return p_ref_code is not null and upper(p_ref_code) = 'R-' || v_bare;
  else
    v_bare := v_input;
    return (p_public_code is not null and upper(p_public_code) = 'JD-' || v_bare)
        or (p_ref_code is not null and upper(p_ref_code) = 'R-' || v_bare);
  end if;
end;
$$;

-- ============================================================================
-- 3. swap_generic_block_reason -- the ONE rule set both
--    submit_swap_request() and lookup_rentals_by_code()'s can_swap /
--    swap_blocked_reason read from, so the UI can never offer a swap the
--    RPC would then reject. Checks only the rules that don't depend on a
--    specific target game (status/end_date/swap_count/existing pending
--    request) -- target-specific rules (slot_unavailable, same_game) are
--    necessarily per-attempt and live only in submit_swap_request().
--    security definer: reads `settings` and `swap_requests`, both
--    admin-only RLS, on behalf of callers that may be anon.
-- ============================================================================
create or replace function swap_generic_block_reason(
  p_rental_id bigint, p_status text, p_end_date date, p_swap_count int
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int;
begin
  if p_status <> 'active' then
    return 'not_active';
  end if;
  if p_end_date < current_date + 1 then
    return 'too_close_to_end';
  end if;

  select value::int into v_limit from settings where key = 'swap_limit';
  if v_limit is null then
    v_limit := 2;
  end if;
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

-- ============================================================================
-- 4. lookup_rentals_by_code(p_code text) -- anon-callable. Accepts a
--    renter's public_code OR a specific rental's ref_code.
-- ============================================================================
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
    -- CONTRACT-AMENDMENT-1: the pending-swap case gets a human-readable
    -- message; the other generic reasons stay as short machine codes
    -- (unchanged from the original contract's intent for this column).
    case when block.reason = 'already_pending'
      then 'A swap request is already waiting for approval.'
      else block.reason
    end as swap_blocked_reason,
    sw.id as pending_swap_id,
    tg.title as pending_swap_to_title
  from rentals r
  join renters rr on rr.id = r.renter_id
  join games g on g.id = r.game_id
  left join lateral (
    select swap_generic_block_reason(r.id, r.status, r.end_date, r.swap_count) as reason
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

-- ============================================================================
-- 5. submit_swap_request(...) -- CONTRACT-AMENDMENT-1, replaces the
--    originally-frozen request_swap(). anon + authenticated. Soft-holds the
--    target slot immediately on submission (same atomic compare-and-swap
--    pattern as create_rental_hold() in migration_15 -- see the comment
--    there for the full race-condition reasoning; the exact same
--    UPDATE ... WHERE <slot>_available = true ... RETURNING trick is used
--    below for the same reason: two customers could otherwise both submit
--    a swap request onto the same target slot).
-- ============================================================================
create or replace function submit_swap_request(
  p_code text,
  p_rental_id bigint,
  p_new_game_slug text,
  p_new_slot text
)
returns table (
  ok boolean, error text, swap_request_id bigint, swap_ref_code text,
  from_game_title text, to_game_title text, to_slot text, swaps_left int
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
begin
  -- ---- fetch + lock the rental being swapped ----------------------------
  select * into v_old from rentals where id = p_rental_id for update;
  if not found then
    return query select false, 'not_found', null::bigint, null::text, null::text, null::text, null::text, null::int;
    return;
  end if;

  select public_code into v_renter_public_code from renters where id = v_old.renter_id;

  -- p_code authenticates against EITHER the renter's public_code or this
  -- specific rental's ref_code. Treat "code doesn't match" identically to
  -- "rental doesn't exist" -- never confirm a rental id exists to a caller
  -- who doesn't hold a matching code.
  if not code_matches(p_code, v_renter_public_code, v_old.ref_code) then
    return query select false, 'not_found', null::bigint, null::text, null::text, null::text, null::text, null::int;
    return;
  end if;

  -- ---- the same rule set can_swap / swap_blocked_reason already told
  -- the UI about (status/end_date/swap_count/already_pending) ------------
  v_block_reason := swap_generic_block_reason(v_old.id, v_old.status, v_old.end_date, v_old.swap_count);
  if v_block_reason is not null then
    return query select false, v_block_reason, null::bigint, null::text, null::text, null::text, null::text, null::int;
    return;
  end if;

  if p_new_slot not in ('trophy', 'nontrophy') then
    -- Not a distinct error in the amendment's vocabulary -- closest fit,
    -- same reasoning noted for create_rental_hold's slot validation.
    return query select false, 'slot_unavailable', null::bigint, null::text, null::text, null::text, null::text, null::int;
    return;
  end if;

  select * into v_new_game_check from games where slug = p_new_game_slug;
  if not found then
    return query select false, 'slot_unavailable', null::bigint, null::text, null::text, null::text, null::text, null::int;
    return;
  end if;

  if v_new_game_check.id = v_old.game_id and p_new_slot = v_old.slot then
    return query select false, 'same_game', null::bigint, null::text, null::text, null::text, null::text, null::int;
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
    return query select false, 'slot_unavailable', null::bigint, null::text, null::text, null::text, null::text, null::int;
    return;
  end if;

  select title into v_from_game_title from games where id = v_old.game_id;

  select value::int into v_hold_hours from settings where key = 'swap_hold_hours';
  if v_hold_hours is null then
    v_hold_hours := 24;
  end if;
  v_hold_expires := now() + (v_hold_hours || ' hours')::interval;

  insert into swap_requests (
    rental_id, renter_id, from_game_id, from_slot, to_game_id, to_slot,
    status, hold_expires_at
  ) values (
    v_old.id, v_old.renter_id, v_old.game_id, v_old.slot, v_new_game.id, p_new_slot,
    'pending', v_hold_expires
  )
  returning id, ref_code into v_swap_id, v_swap_ref_code;

  select value::int into v_limit from settings where key = 'swap_limit';
  if v_limit is null then
    v_limit := 2;
  end if;

  return query select
    true, null::text, v_swap_id, v_swap_ref_code,
    v_from_game_title, v_new_game.title, p_new_slot,
    greatest(0, v_limit - v_old.swap_count);
  return;
exception when others then
  return query select false, 'unexpected_error', null::bigint, null::text, null::text, null::text, null::text, null::int;
end;
$$;

grant execute on function submit_swap_request(text, bigint, text, text) to anon, authenticated;

-- ============================================================================
-- 6. approve_swap_request(p_id, p_note) -- admin only. Performs the actual
--    swap atomically: ends the old rental (freeing its slot), creates the
--    new active/paid rental, and marks the request approved. The target
--    slot was already flipped unavailable at submission time -- this does
--    NOT re-touch games availability for the target, only clears the new
--    rental's hold_expires_at since it's no longer a temporary hold, it's a
--    confirmed rental.
-- ============================================================================
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
  insert into rentals (
    game_id, renter_id, slot, plan, amount, status, payment_status,
    start_date, end_date, swapped_from_rental_id, swap_count
  ) values (
    v_req.to_game_id, v_req.renter_id, v_req.to_slot, v_old.plan, 0, 'active', 'paid',
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
-- 7. decline_swap_request(p_id, p_note) -- admin only. Frees the held
--    target slot and marks the request declined.
-- ============================================================================
create or replace function decline_swap_request(p_id bigint, p_note text default null)
returns table (ok boolean, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req swap_requests%rowtype;
begin
  if not is_admin() then
    return query select false, 'not_admin';
    return;
  end if;

  select * into v_req from swap_requests where id = p_id for update;
  if not found then
    return query select false, 'not_found';
    return;
  end if;
  if v_req.status <> 'pending' then
    return query select false, 'not_pending';
    return;
  end if;

  if v_req.to_slot = 'trophy' then
    update games set trophy_available = true, trophy_available_at = null where id = v_req.to_game_id;
  else
    update games set nontrophy_available = true, nontrophy_available_at = null where id = v_req.to_game_id;
  end if;

  update swap_requests set status = 'declined', handled_at = now(), admin_note = p_note
  where id = v_req.id;

  return query select true, null::text;
exception when others then
  return query select false, 'unexpected_error';
end;
$$;

grant execute on function decline_swap_request(bigint, text) to authenticated;

-- ============================================================================
-- 8. release_expired_holds() + cron -- extends the original contract's
--    pending-rental hold sweep (migration_4's expire_overdue_rentals()
--    pattern) to ALSO expire swap_requests whose admin-decision window
--    passed, per CONTRACT-AMENDMENT-1.
-- ============================================================================
create extension if not exists pg_cron;

create or replace function release_expired_holds()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Unpaid rental holds (original contract, migration_14/15).
  update games g set
    trophy_available = case when r.slot = 'trophy' then true else g.trophy_available end,
    trophy_available_at = case when r.slot = 'trophy' then null else g.trophy_available_at end,
    nontrophy_available = case when r.slot = 'nontrophy' then true else g.nontrophy_available end,
    nontrophy_available_at = case when r.slot = 'nontrophy' then null else g.nontrophy_available_at end
  from rentals r
  where r.game_id = g.id and r.status = 'pending' and r.hold_expires_at < now();

  update rentals set status = 'cancelled'
  where status = 'pending' and hold_expires_at < now();

  -- CONTRACT-AMENDMENT-1: swap requests the admin never acted on in time.
  update games g set
    trophy_available = case when sr.to_slot = 'trophy' then true else g.trophy_available end,
    trophy_available_at = case when sr.to_slot = 'trophy' then null else g.trophy_available_at end,
    nontrophy_available = case when sr.to_slot = 'nontrophy' then true else g.nontrophy_available end,
    nontrophy_available_at = case when sr.to_slot = 'nontrophy' then null else g.nontrophy_available_at end
  from swap_requests sr
  where sr.to_game_id = g.id and sr.status = 'pending' and sr.hold_expires_at < now();

  update swap_requests set status = 'expired', handled_at = now()
  where status = 'pending' and hold_expires_at < now();
end;
$$;

-- cron.schedule upserts by job name, so re-running this migration (or
-- migration_4, which schedules a differently-named job) is safe.
select cron.schedule('release-expired-holds', '*/5 * * * *', 'select release_expired_holds();');

-- ============================================================================
-- 9. VERIFICATION -- run these last and read the actual result rows.
-- ============================================================================

-- Expect one row: rental_id, renter_id, from_game_id, from_slot, to_game_id,
-- to_slot, status, ref_code, hold_expires_at, admin_note, created_at,
-- handled_at all present.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'swap_requests'
order by ordinal_position;

-- Expect 3 rows: swap_requests_status_idx, swap_requests_rental_id_idx,
-- swap_requests_hold_expires_at_idx.
select indexname from pg_indexes
where schemaname = 'public' and tablename = 'swap_requests'
order by indexname;

-- Expect one row: admin can manage swap requests.
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'swap_requests';

-- Expect 7 rows: approve_swap_request, code_matches, decline_swap_request,
-- lookup_rentals_by_code, release_expired_holds, submit_swap_request,
-- swap_generic_block_reason. is_security_definer TRUE for every one except
-- code_matches (pure string logic, touches no RLS-protected table).
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'approve_swap_request', 'code_matches', 'decline_swap_request',
    'lookup_rentals_by_code', 'release_expired_holds',
    'submit_swap_request', 'swap_generic_block_reason'
  )
order by p.proname;

-- Expect: lookup_rentals_by_code and submit_swap_request each grant to both
-- anon and authenticated; approve_swap_request and decline_swap_request
-- grant to authenticated only.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'lookup_rentals_by_code', 'submit_swap_request',
    'approve_swap_request', 'decline_swap_request'
  )
order by routine_name, grantee;

-- Expect one row: release-expired-holds, schedule '*/5 * * * *', active = t.
select jobname, schedule, active from cron.job where jobname = 'release-expired-holds';

-- Smoke test -- an unknown code must come back as zero rows, never an error.
select * from lookup_rentals_by_code('NO-SUCH-CODE-000000');
