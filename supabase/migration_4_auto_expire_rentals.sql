-- Run this in the Supabase SQL editor after migration_3.
--
-- Without this, a rental's countdown hits zero but the slot stays FULL
-- until an admin remembers to click "End Rental". This frees the slot and
-- marks the rental ended automatically once its end_date has passed.

create extension if not exists pg_cron;

create or replace function expire_overdue_rentals() returns void as $$
begin
  update games g set
    trophy_available = case when r.slot = 'trophy' then true else g.trophy_available end,
    trophy_available_at = case when r.slot = 'trophy' then null else g.trophy_available_at end,
    nontrophy_available = case when r.slot = 'nontrophy' then true else g.nontrophy_available end,
    nontrophy_available_at = case when r.slot = 'nontrophy' then null else g.nontrophy_available_at end
  from rentals r
  where r.game_id = g.id and r.status = 'active' and r.end_date < current_date;

  update rentals set status = 'ended'
  where status = 'active' and end_date < current_date;
end;
$$ language plpgsql security definer;

-- Runs every hour on the hour. cron.schedule upserts by job name, so
-- re-running this migration is safe.
select cron.schedule('expire-overdue-rentals', '0 * * * *', 'select expire_overdue_rentals();');

-- If "create extension pg_cron" errors with a permissions message, enable
-- it instead via the dashboard: Database -> Extensions -> search "pg_cron"
-- -> enable, then re-run just the function + cron.schedule statements above.
