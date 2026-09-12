-- Run this in the Supabase SQL editor (schema.sql and migration_2 must
-- already be applied).

-- Lets the public site show "available in X days" instead of just "FULL"
-- when a slot is currently rented out.
alter table games add column if not exists trophy_available_at date;
alter table games add column if not exists nontrophy_available_at date;

-- Storage bucket for game cover uploads from the admin "Add Game" form.
insert into storage.buckets (id, name, public)
values ('game-covers', 'game-covers', true)
on conflict (id) do nothing;

create policy "public can view game covers" on storage.objects
  for select using (bucket_id = 'game-covers');

create policy "admin can upload game covers" on storage.objects
  for insert to authenticated with check (bucket_id = 'game-covers');

create policy "admin can update game covers" on storage.objects
  for update to authenticated using (bucket_id = 'game-covers');

create policy "admin can delete game covers" on storage.objects
  for delete to authenticated using (bucket_id = 'game-covers');
