-- Test-game fixtures for end-to-end rent/swap testing by agents pretending
-- to be customers.
--
-- WHY: agents will exercise the self-service rent/swap flow (Phase 4) against
-- a real Supabase project. They must never consume slots on real games (that
-- would block a real customer) and these rows must never show up in the
-- public catalog real customers browse. Run migration_10_customer_accounts.sql
-- FIRST -- it adds the `games.is_test` column this file relies on.
--
-- Slugs are prefixed "zz-test-" so they sort to the bottom of any admin list
-- and are unmistakable in the dashboard. `is_test = true` is what catalog.js
-- filters out of the public catalog (see the loadGames() change there).
-- Cover reuses an existing real asset (code-vein-ii.webp, see seed_games.sql)
-- rather than pointing at a file that doesn't exist -- these rows only ever
-- need to render correctly in the admin dashboard, not have a unique cover.
--
-- Safe to re-run: "on conflict (slug) do update" keeps this idempotent.

insert into games (
  slug, title, genre, cover, release_date, platform, status, upcoming_order,
  is_test,
  trophy_available, trophy_weekly, trophy_monthly, trophy_reservation_status,
  nontrophy_available, nontrophy_weekly, nontrophy_monthly, nontrophy_reservation_status
) values (
  'zz-test-game-a', 'ZZ Test Game A', '{"Test"}', '/assets/games/code-vein-ii.webp',
  null, 'PS5', 'available', 99999,
  true,
  true, 249, 699, 'CLOSED',
  true, 249, 699, 'CLOSED'
)
on conflict (slug) do update set
  title = excluded.title, genre = excluded.genre, cover = excluded.cover,
  release_date = excluded.release_date, platform = excluded.platform,
  status = excluded.status, upcoming_order = excluded.upcoming_order,
  is_test = excluded.is_test,
  trophy_available = excluded.trophy_available, trophy_weekly = excluded.trophy_weekly,
  trophy_monthly = excluded.trophy_monthly, trophy_reservation_status = excluded.trophy_reservation_status,
  nontrophy_available = excluded.nontrophy_available, nontrophy_weekly = excluded.nontrophy_weekly,
  nontrophy_monthly = excluded.nontrophy_monthly, nontrophy_reservation_status = excluded.nontrophy_reservation_status;

insert into games (
  slug, title, genre, cover, release_date, platform, status, upcoming_order,
  is_test,
  trophy_available, trophy_weekly, trophy_monthly, trophy_reservation_status,
  nontrophy_available, nontrophy_weekly, nontrophy_monthly, nontrophy_reservation_status
) values (
  'zz-test-game-b', 'ZZ Test Game B', '{"Test"}', '/assets/games/code-vein-ii.webp',
  null, 'PS5', 'available', 99999,
  true,
  true, 249, 699, 'CLOSED',
  true, 249, 699, 'CLOSED'
)
on conflict (slug) do update set
  title = excluded.title, genre = excluded.genre, cover = excluded.cover,
  release_date = excluded.release_date, platform = excluded.platform,
  status = excluded.status, upcoming_order = excluded.upcoming_order,
  is_test = excluded.is_test,
  trophy_available = excluded.trophy_available, trophy_weekly = excluded.trophy_weekly,
  trophy_monthly = excluded.trophy_monthly, trophy_reservation_status = excluded.trophy_reservation_status,
  nontrophy_available = excluded.nontrophy_available, nontrophy_weekly = excluded.nontrophy_weekly,
  nontrophy_monthly = excluded.nontrophy_monthly, nontrophy_reservation_status = excluded.nontrophy_reservation_status;

-- ============================================================================
-- CLEANUP -- uncomment and run manually once test-game infrastructure is no
-- longer needed. Deletes rentals against these games first (rentals.game_id
-- has "on delete restrict", so the games rows can't go first).
-- ============================================================================
-- delete from rentals where game_id in (
--   select id from games where slug in ('zz-test-game-a', 'zz-test-game-b')
-- );
-- delete from games where slug in ('zz-test-game-a', 'zz-test-game-b');
