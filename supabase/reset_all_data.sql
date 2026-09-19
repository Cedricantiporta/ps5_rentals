-- ============================================================================
-- DESTRUCTIVE -- run this yourself in the Supabase SQL editor, only when
-- you're sure. This is irreversible: once run, the deleted rows are gone,
-- not recoverable from the app. Supersedes the older reset_rentals_data.sql,
-- which predates swap_requests and doesn't touch it.
--
-- WIPES: every renter, every rental, every legacy rental_requests row,
-- every swap_requests row. A truly clean slate for going live -- no test
-- customers, no test rentals, no test swaps.
--
-- DOES NOT TOUCH: your games catalog (titles, genres, covers, prices,
-- release dates, status), your admin login, the `settings` table (GCash
-- number, hold minutes, swap limits, etc.), or the pg_cron auto-expire job.
--
-- TEST GAMES: the two `is_test = true` rows (zz-test-game-a/b) are KEPT,
-- not deleted -- they're the safe sandbox used for verifying future
-- changes without touching a real game. Their rental history is wiped
-- along with everything else, so they end up fresh too. If you'd rather
-- remove them entirely, uncomment the DELETE near the bottom.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run.
-- ============================================================================

-- Child tables first (foreign keys point at renters/rentals/games).
delete from swap_requests;
delete from rentals;
delete from rental_requests;
delete from renters;

-- Every game's rental-derived state goes back to a clean slate, since the
-- rentals that set it no longer exist. This is correct for every game, not
-- just ones you know were touched by testing -- once all rentals are gone,
-- every slot on every game genuinely is available again.
update games set
  trophy_available = true, trophy_available_at = null,
  nontrophy_available = true, nontrophy_available_at = null,
  times_rented = 0;

-- Reservation status reflects "no one in queue" now that all reservations
-- are gone -- unless you'd manually closed it, which is left as-is.
update games set trophy_reservation_status = 'OPEN' where trophy_reservation_status <> 'CLOSED';
update games set nontrophy_reservation_status = 'OPEN' where nontrophy_reservation_status <> 'CLOSED';

-- Restart id numbering from 1 for a truly clean slate. Comment these out if
-- you'd rather keep counting up from wherever they were.
alter table renters alter column id restart with 1;
alter table rentals alter column id restart with 1;
alter table rental_requests alter column id restart with 1;
alter table swap_requests alter column id restart with 1;

-- Uncomment to also remove the test games themselves, not just their data.
-- Only do this if you don't want a safe sandbox left for verifying future
-- changes -- every migration/feature test this project has done so far
-- relied on these two rows existing.
-- delete from games where is_test = true;

-- ============================================================================
-- VERIFICATION -- everything below should read 0 (except games, which
-- should still show your real catalog count).
-- ============================================================================
select 'renters left' as check, count(*) from renters
union all select 'rentals left', count(*) from rentals
union all select 'rental_requests left', count(*) from rental_requests
union all select 'swap_requests left', count(*) from swap_requests
union all select 'games (should be your real catalog count)', count(*) from games;
