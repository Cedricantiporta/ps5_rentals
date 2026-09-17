-- Test-customer fixtures for end-to-end portal QA by agents pretending to be
-- customers. Run this in the Supabase SQL editor AFTER migration_10_customer_
-- accounts.sql and test_games.sql have both been run.
--
-- WHY: AUTOMATION-PLAN.md Phase 2 needs a *populated* portal to verify against
-- (active rental, correct fields, swap-chain rendering later) -- but customers
-- are deliberately read-only (see migration_10's header), so nothing short of
-- this SQL can create that data. `renters` and `rentals` rows, and linking a
-- renter to an auth user, are all writes no customer or anon key can perform.
--
-- BLOCKED -- READ BEFORE RUNNING:
-- The two auth.users ids below are PLACEHOLDERS. Signing up either test
-- account (zz-agent-test-a@example.com / zz-agent-test-b@example.com) via
-- /account/login.html currently succeeds up to Supabase attempting to send
-- the confirmation email, then fails with `over_email_send_rate_limit` (429).
-- This means "Confirm email" is ON (Authentication -> Providers -> Email),
-- which requires a click in an inbox neither test account has, compounded by
-- the built-in email service's very low send rate limit blocking even that.
-- Until a human either (a) turns "Confirm email" OFF for this project, or
-- (b) manually confirms/creates the two test users from the Supabase
-- dashboard (Authentication -> Users -> Add user, or Invite), no agent can
-- obtain real auth_user_ids here. Once you have them:
--
--   select id, email from auth.users where email in
--     ('zz-agent-test-a@example.com', 'zz-agent-test-b@example.com');
--
-- ...replace the two placeholder uuids below with the real ids and run this
-- file. Safe to re-run: renters upsert on the auth_user_id unique constraint,
-- and the rental insert is guarded with "where not exists".

-- Customer A -- gets the active rental below.
insert into renters (name, messenger_name, contact_note, auth_user_id)
values (
  'ZZ Agent Test A', null, 'QA test account (see test_seed_customer.sql) -- safe to delete',
  '00000000-0000-0000-0000-0000000000aa'::uuid -- REPLACE with zz-agent-test-a@example.com's auth.users.id
)
on conflict (auth_user_id) do update set
  name = excluded.name, contact_note = excluded.contact_note;

-- Customer B -- linked but deliberately given NO rentals. Its purpose is the
-- RLS isolation check: signed in as B, querying `rentals`/`renters` must
-- return nothing belonging to A, and a direct-by-id lookup of A's renter/
-- rental row must come back empty, not just filtered from a list.
insert into renters (name, messenger_name, contact_note, auth_user_id)
values (
  'ZZ Agent Test B', null, 'QA test account (see test_seed_customer.sql) -- safe to delete',
  '00000000-0000-0000-0000-0000000000bb'::uuid -- REPLACE with zz-agent-test-b@example.com's auth.users.id
)
on conflict (auth_user_id) do update set
  name = excluded.name, contact_note = excluded.contact_note;

-- One active, paid rental for customer A on zz-test-game-a (trophy slot,
-- monthly plan) -- exercises the portal's "Active Rentals" card, days-left
-- countdown, and payment-status pill without touching real inventory.
insert into rentals (game_id, renter_id, slot, plan, amount, status, payment_status, start_date, end_date)
select
  g.id, r.id, 'trophy', 'monthly', 699, 'active', 'paid',
  current_date, current_date + 30
from games g, renters r
where g.slug = 'zz-test-game-a'
  and r.auth_user_id = '00000000-0000-0000-0000-0000000000aa'::uuid -- keep in sync with customer A's id above
  and not exists (
    select 1 from rentals
    where renter_id = r.id and game_id = g.id and status = 'active'
  );

-- ============================================================================
-- CLEANUP -- uncomment and run manually once this QA pass is done. Deletes
-- the rental first (rentals.renter_id has "on delete restrict"), then both
-- test renter rows. Does NOT delete the auth.users rows themselves -- do
-- that from Authentication -> Users in the dashboard (or leave them; they
-- carry no data once the renter link is gone).
-- ============================================================================
-- delete from rentals where renter_id in (
--   select id from renters where auth_user_id in (
--     '00000000-0000-0000-0000-0000000000aa'::uuid,
--     '00000000-0000-0000-0000-0000000000bb'::uuid
--   )
-- );
-- delete from renters where auth_user_id in (
--   '00000000-0000-0000-0000-0000000000aa'::uuid,
--   '00000000-0000-0000-0000-0000000000bb'::uuid
-- );
