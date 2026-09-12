-- Run this in the Supabase SQL editor.
-- Tracks queue order for pre-reservations on upcoming (not-yet-released)
-- games: when multiple people reserve the same Trophy/Non-Trophy slot on a
-- game that isn't out yet, only one can actually get it on release day --
-- this is their place in line. Null for ordinary (non-reservation) rentals.
alter table rentals add column if not exists queue_position int;
