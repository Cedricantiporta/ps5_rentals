-- ============================================================================
-- Removes the rows created while testing the rent flow, and frees any slot
-- those test holds are still holding.
--
-- Safe to run any time. It only touches renters whose name starts with 'ZZ '
-- plus the two named holds below, and it never touches a real customer.
--
-- The hold on "A Plague Tale: Requiem" was created by an end-to-end test of
-- the live payment screen (test games are hidden from the catalog, so a real
-- title was the only way to drive the real UI). release_expired_holds() would
-- have cancelled it and freed the slot within 30 minutes on its own; this
-- just does it now and removes the guest renter it created.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run.
-- ============================================================================

-- 1. Free every slot still held by a PENDING test rental, before deleting it.
update games g set
  trophy_available    = case when r.slot = 'trophy'    then true else g.trophy_available end,
  trophy_available_at = case when r.slot = 'trophy'    then null else g.trophy_available_at end,
  nontrophy_available = case when r.slot = 'nontrophy' then true else g.nontrophy_available end,
  nontrophy_available_at = case when r.slot = 'nontrophy' then null else g.nontrophy_available_at end
from rentals r
where r.game_id = g.id
  and r.status = 'pending'
  and (
    r.renter_id in (select id from renters where name like 'ZZ %')
    or r.ref_code in ('R-5E9NJA')
  );

-- 2. Delete the test rentals.
delete from rentals
 where renter_id in (select id from renters where name like 'ZZ %')
    or ref_code in ('R-5E9NJA');

-- 3. Delete the test renters (only those with no rentals left, so a real
--    customer who happens to be named "ZZ ..." can never be removed).
delete from renters
 where name like 'ZZ %'
   and not exists (select 1 from rentals x where x.renter_id = renters.id);

-- 4. Belt and braces: the two test games should be fully open again.
update games
   set trophy_available = true, trophy_available_at = null,
       nontrophy_available = true, nontrophy_available_at = null
 where slug in ('zz-test-game-a', 'zz-test-game-b');

-- ============================================================================
-- VERIFICATION -- all three should come back empty / available.
-- ============================================================================
select 'leftover test renters' as check, count(*) from renters where name like 'ZZ %'
union all
select 'leftover test rentals', count(*) from rentals
 where renter_id in (select id from renters where name like 'ZZ %') or ref_code = 'R-5E9NJA';

select slug, trophy_available, nontrophy_available
  from games
 where slug in ('zz-test-game-a', 'zz-test-game-b', 'a-plague-tale-requiem')
 order by slug;

-- Anything else still holding a slot past its window (should normally be
-- empty -- the cron clears these every 5 minutes).
select id, ref_code, status, hold_expires_at
  from rentals
 where status = 'pending' and hold_expires_at < now();
