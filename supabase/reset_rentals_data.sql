-- DESTRUCTIVE -- run this yourself in the Supabase SQL editor, only when
-- you're sure. Wipes all renters, rentals, and incoming requests. Leaves
-- the games catalog itself untouched (titles, prices, covers, genres,
-- release dates, status) but resets the rental-derived fields on each game
-- back to a clean slate, since the rentals that set them no longer exist.
--
-- This does NOT touch: game titles/genres/covers/prices/release dates,
-- your admin login, or the pg_cron auto-expire job.

delete from rental_requests;
delete from rentals;
delete from renters;

update games set
  trophy_available = true, trophy_available_at = null,
  nontrophy_available = true, nontrophy_available_at = null,
  times_rented = 0;

-- Reservation status reflects "no one in queue" now that all reservations
-- are gone -- unless you'd manually closed it, which is left as-is.
update games set trophy_reservation_status = 'OPEN' where trophy_reservation_status <> 'CLOSED';
update games set nontrophy_reservation_status = 'OPEN' where nontrophy_reservation_status <> 'CLOSED';

-- Optional: restart id numbering from 1 for a truly clean slate.
alter table renters alter column id restart with 1;
alter table rentals alter column id restart with 1;
alter table rental_requests alter column id restart with 1;
