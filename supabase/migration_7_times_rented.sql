-- Run this in the Supabase SQL editor.
-- Powers the small count badge on a game's cover (and the POPULAR/HIGH
-- DEMAND labels in catalog.js badgeFor) with a real persisted count instead
-- of the placeholder 0 it's been showing since the catalog switched to
-- reading live from Supabase.
alter table games add column if not exists times_rented int not null default 0;
