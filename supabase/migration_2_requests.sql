-- Run this in the Supabase SQL editor (after schema.sql already ran).
-- Adds a lightweight inbox for requests that come straight from the
-- public site's rental wizard, so the admin app doesn't require re-typing
-- the game/slot/plan the customer already picked.
create table if not exists rental_requests (
  id bigint generated always as identity primary key,
  game_slug text not null,
  game_title text not null,
  slot text not null check (slot in ('trophy', 'nontrophy')),
  plan text check (plan in ('weekly', 'monthly')),
  amount int,
  handled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table rental_requests enable row level security;

-- Anyone (including anonymous site visitors) can drop a request in the
-- inbox -- this is intentionally open (no login) since it's just "someone
-- clicked rent on the site", not a financial action. Low-stakes if spammed:
-- junk rows are easy to spot and delete, and nothing here touches the live
-- catalog or money until an admin manually converts one into a real rental.
create policy "anyone can submit a rental request" on rental_requests
  for insert to anon with check (true);

create policy "admin can read rental requests" on rental_requests
  for select using (auth.role() = 'authenticated');
create policy "admin can update rental requests" on rental_requests
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "admin can delete rental requests" on rental_requests
  for delete using (auth.role() = 'authenticated');
