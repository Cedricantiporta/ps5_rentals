-- June Digitals admin backend schema.
-- Run this once in Supabase: Project -> SQL Editor -> New query -> paste -> Run.

create table if not exists games (
  id bigint generated always as identity primary key,
  slug text unique not null,
  title text not null,
  genre text[] not null default '{}',
  cover text,
  release_date date,
  platform text not null default 'PS5',
  status text not null default 'available' check (status in ('available', 'upcoming')),
  upcoming_order int not null default 99999,

  -- for status='available' games: *_available drives the AVAILABLE/FULL
  -- label (see catalog.js availInfo). *_reservation_status is unused there.
  -- for status='upcoming' games: *_reservation_status drives the
  -- OPEN/LIMITED/PRIORITY LIST/CLOSED pre-reserve label (reservationInfo);
  -- *_available is unused there. Both columns exist on every row so
  -- switching a game between available/upcoming never loses data.
  trophy_available boolean not null default true,
  trophy_weekly int,
  trophy_monthly int,
  trophy_reservation_status text not null default 'CLOSED' check (trophy_reservation_status in ('OPEN', 'LIMITED', 'PRIORITY_LIST', 'CLOSED')),

  nontrophy_available boolean not null default true,
  nontrophy_weekly int,
  nontrophy_monthly int,
  nontrophy_reservation_status text not null default 'CLOSED' check (nontrophy_reservation_status in ('OPEN', 'LIMITED', 'PRIORITY_LIST', 'CLOSED')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists renters (
  id bigint generated always as identity primary key,
  name text not null,
  messenger_name text,
  contact_note text,
  created_at timestamptz not null default now()
);

create table if not exists rentals (
  id bigint generated always as identity primary key,
  game_id bigint not null references games(id) on delete restrict,
  renter_id bigint not null references renters(id) on delete restrict,
  slot text not null check (slot in ('trophy', 'nontrophy')),
  plan text not null check (plan in ('weekly', 'monthly')),
  amount int not null,
  -- 'pending': created, awaiting GCash payment confirmation -- does not
  -- occupy the game slot yet. 'active': paid + confirmed, slot is closed.
  -- 'ended'/'cancelled': slot freed back up.
  status text not null default 'pending' check (status in ('pending', 'active', 'ended', 'cancelled')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid')),
  gcash_ref text,
  start_date date not null default current_date,
  end_date date not null,
  swapped_from_rental_id bigint references rentals(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rentals_game_id_idx on rentals(game_id);
create index if not exists rentals_status_idx on rentals(status);
create index if not exists rentals_end_date_idx on rentals(end_date);

-- Row level security: the public catalog page only ever needs to READ games.
-- Everything else (renters, rentals, and any write to games) requires an
-- authenticated admin session. New public sign-ups must be disabled in
-- Supabase (Authentication -> Providers -> Email -> "Allow new users to sign
-- up" OFF) and your one admin account created manually (Authentication ->
-- Users -> Add user) -- otherwise anyone who signs up becomes an admin.
alter table games enable row level security;
alter table renters enable row level security;
alter table rentals enable row level security;

create policy "public can read games" on games
  for select using (true);

create policy "admin can write games" on games
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "admin can manage renters" on renters
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "admin can manage rentals" on rentals
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Keep updated_at current on every row update.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger games_set_updated_at before update on games
  for each row execute function set_updated_at();
create trigger rentals_set_updated_at before update on rentals
  for each row execute function set_updated_at();
