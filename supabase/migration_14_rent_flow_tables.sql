-- Run this in the Supabase SQL editor, AFTER migration_9_admin_role.sql and
-- migration_10_customer_accounts.sql have both been run (this depends on
-- is_admin() from migration_9 for the settings RLS policy).
--
-- WHAT THIS DOES: lays the DATA foundation for the self-serve rent flow
-- described in RENT-FLOW-CONTRACT.md (frozen -- do not rename anything the
-- contract names). The RPCs that actually implement create/lookup/swap live
-- in migration_15 and migration_16; this file only adds:
--   1. `settings` -- admin-editable key/value store (GCash details, hold
--      window, swap limit) that the public RPCs read from instead of having
--      those values hardcoded in SQL or in client JS.
--   2. `renters.public_code` / `rentals.ref_code` -- the two customer-facing
--      tracking codes the whole flow is built around (contract section
--      "Codes"), plus `rentals.swap_count` and `rentals.hold_expires_at`
--      which the hold/swap RPCs need.
--   3. `gen_code()` -- shared code generator with collision retry, and
--      triggers so every new renter/rental always gets a code with zero
--      extra client-side logic.
--   4. A backfill so every EXISTING renter/rental also gets a code (the
--      columns are UNIQUE, so nothing downstream can treat "no code yet" as
--      a valid state).
--
-- WHAT BREAKS IF THIS IS SKIPPED: migration_15/16 will fail outright --
-- create_rental_hold(), lookup_rentals_by_code() etc. all reference
-- public_code/ref_code/swap_count/hold_expires_at/settings, none of which
-- exist until this file runs.
--
-- Safe to re-run: table/column adds use "if not exists", the seed insert
-- uses "on conflict do nothing" (so it will NOT overwrite GCash details the
-- owner has already edited on a re-run), functions use "or replace", the
-- backfill only touches rows that still have a null code, and indexes use
-- "if not exists".

-- ============================================================================
-- 1. settings -- admin-editable key/value store. Anon reads it ONLY through
--    get_public_settings() (migration_15), which is `security definer` and
--    therefore bypasses this RLS by design -- the table itself stays
--    admin-only, matching the contract's own comment
--    ("admin-editable, anon can read via RPC only").
-- ============================================================================
create table if not exists settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table settings enable row level security;

drop policy if exists "admin can manage settings" on settings;
create policy "admin can manage settings" on settings
  for all using (is_admin()) with check (is_admin());

create or replace function settings_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists settings_set_updated_at on settings;
create trigger settings_set_updated_at before update on settings
  for each row execute function settings_set_updated_at();

-- ============================================================================
-- ==== LOUD NOTE FOR THE OWNER =============================================
-- The two rows below are seeded with the placeholder 'SET YOUR GCASH NUMBER'.
-- The self-serve rent flow will show THAT PLACEHOLDER TEXT to real customers
-- as your payment details until you edit them. After running this file, go
-- to Supabase -> Table Editor -> settings and fix the `value` column for the
-- `gcash_number` and `gcash_name` rows (or run, right now, with your real
-- details swapped in):
--
--   update settings set value = '09171234567' where key = 'gcash_number';
--   update settings set value = 'Juan Dela Cruz' where key = 'gcash_name';
--
-- ============================================================================
-- NOTE: `swap_hold_hours` was added by CONTRACT-AMENDMENT-1.md (swaps now
-- land in an admin queue -- see migration_16 -- instead of auto-approving;
-- submitting a swap request holds the target slot for this many hours
-- while it waits for an admin decision).
insert into settings (key, value) values
  ('gcash_number', 'SET YOUR GCASH NUMBER'),
  ('gcash_name', 'SET YOUR GCASH NUMBER'),
  ('messenger_url', 'https://m.me/junedigitalaccess'),
  ('hold_minutes', '30'),
  ('swap_limit', '2'),
  ('swap_hold_hours', '24')
on conflict (key) do nothing;

-- ============================================================================
-- 2. New columns on renters / rentals (contract "Table additions" section).
-- ============================================================================
alter table renters add column if not exists public_code text unique;

alter table rentals add column if not exists ref_code text unique;
alter table rentals add column if not exists swap_count int not null default 0;
alter table rentals add column if not exists hold_expires_at timestamptz;

-- ============================================================================
-- 3. gen_code(prefix) -- shared code generator, alphabet excludes 0/O/1/I/L
--    so a customer reading a code aloud or off a screenshot can't confuse
--    characters. Retries on collision. `prefix` is 'JD' (renters.public_code,
--    rendered as "JD-XXXXXX") or 'R' (rentals.ref_code, rendered as
--    "R-XXXXXX") -- matching the two tables this migration adds a code to.
--    Not `security definer`: it's only ever called (a) from triggers that
--    fire during an insert already running under an elevated context
--    (e.g. anon calling the `security definer` create_rental_hold() in
--    migration_15, which switches the effective role for the whole
--    statement, triggers included) or (b) from this file's own backfill,
--    run by whatever role pastes this script into the SQL editor -- so it
--    never needs its own privilege escalation.
-- ============================================================================
create or replace function gen_code(prefix text)
returns text
language plpgsql
as $$
declare
  alphabet text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  code text;
  candidate text;
  attempt int := 0;
  i int;
begin
  loop
    attempt := attempt + 1;
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    candidate := prefix || '-' || code;

    if prefix = 'JD' then
      exit when not exists (select 1 from renters where public_code = candidate);
    elsif prefix = 'R' then
      exit when not exists (select 1 from rentals where ref_code = candidate);
    else
      -- Unknown prefix -- nothing to check collisions against, just hand it
      -- back. Not expected to happen; only 'JD' and 'R' are ever passed.
      exit;
    end if;

    if attempt > 50 then
      raise exception 'gen_code: could not find a unique code for prefix % after % attempts', prefix, attempt;
    end if;
  end loop;

  return candidate;
end;
$$;

-- ============================================================================
-- 4. Triggers -- every NEW renter/rental always gets a code, no client-side
--    or RPC-side logic required. Only fills in a code if one wasn't already
--    supplied (keeps this idempotent-friendly and lets the backfill below
--    coexist without fighting the trigger).
-- ============================================================================
create or replace function set_renter_public_code()
returns trigger as $$
begin
  if new.public_code is null then
    new.public_code := gen_code('JD');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists renters_set_public_code on renters;
create trigger renters_set_public_code before insert on renters
  for each row execute function set_renter_public_code();

create or replace function set_rental_ref_code()
returns trigger as $$
begin
  if new.ref_code is null then
    new.ref_code := gen_code('R');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists rentals_set_ref_code on rentals;
create trigger rentals_set_ref_code before insert on rentals
  for each row execute function set_rental_ref_code();

-- ============================================================================
-- 5. Backfill existing rows. Done as a row-by-row loop (not a single bulk
--    UPDATE) on purpose: gen_code()'s collision check queries the table
--    mid-backfill, and a single UPDATE evaluates its SET expression against
--    a snapshot that does not see other rows THAT SAME STATEMENT is in the
--    process of changing -- two existing rows could otherwise both roll the
--    same random code without ever seeing each other. Looping means each
--    row's UPDATE is its own statement, so by the time row N asks "does this
--    candidate already exist", every row before it in the loop has already
--    committed its code within this same transaction and is visible.
-- ============================================================================
do $$
declare
  r record;
begin
  for r in select id from renters where public_code is null loop
    update renters set public_code = gen_code('JD') where id = r.id;
  end loop;

  for r in select id from rentals where ref_code is null loop
    update rentals set ref_code = gen_code('R') where id = r.id;
  end loop;
end
$$;

-- ============================================================================
-- 6. Indexes.
--    renters.public_code and rentals.ref_code are already covered by the
--    UNIQUE constraints added in step 2 (Postgres auto-creates a unique
--    btree index for any UNIQUE column) -- no separate CREATE INDEX wanted,
--    that would just be a redundant duplicate index on the same column.
--    rentals.status already has an index from schema.sql
--    (rentals_status_idx) -- listed in the task as a reminder it needs one,
--    not because this file has to add a second one.
--    rentals.hold_expires_at is new here and genuinely needs its own index:
--    release_expired_holds() (migration_16) scans it every 5 minutes via
--    cron.
-- ============================================================================
create index if not exists rentals_hold_expires_at_idx on rentals(hold_expires_at);

-- ============================================================================
-- 7. VERIFICATION -- run these last and read the actual result rows.
-- ============================================================================

-- Expect 6 rows: gcash_number, gcash_name, messenger_url, hold_minutes,
-- swap_limit, swap_hold_hours. If gcash_number/gcash_name still show the
-- placeholder, go edit them now (see the loud note above step 2).
select key, value, updated_at from settings order by key;

-- Expect exactly one row per column, nullable = NO where noted.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'renters' and column_name = 'public_code')
    or (table_name = 'rentals' and column_name in ('ref_code', 'swap_count', 'hold_expires_at'))
  )
order by table_name, column_name;

-- Expect ZERO rows -- every renter/rental should have a code after the
-- backfill. A nonzero count here means the backfill didn't fully apply.
select
  (select count(*) from renters where public_code is null) as renters_missing_code,
  (select count(*) from rentals where ref_code is null) as rentals_missing_code;

-- Expect 3 rows: gen_code, set_renter_public_code, set_rental_ref_code.
select proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('gen_code', 'set_renter_public_code', 'set_rental_ref_code')
order by proname;

-- Expect 2 rows: renters_set_public_code, rentals_set_ref_code.
select tgname as trigger_name, tgrelid::regclass as on_table
from pg_trigger
where tgname in ('renters_set_public_code', 'rentals_set_ref_code')
order by tgname;

-- Expect one row: admin can manage settings, roles should resolve to
-- is_admin() checks (qual/with_check show the function call).
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'settings';

-- Expect a row named rentals_hold_expires_at_idx.
select indexname from pg_indexes
where schemaname = 'public' and tablename = 'rentals' and indexname = 'rentals_hold_expires_at_idx';
