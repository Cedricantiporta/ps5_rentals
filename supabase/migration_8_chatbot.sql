-- Run this in the Supabase SQL editor.
-- Backs the public chatbot: per-browser daily rate limit (20/day) and a
-- log of what customers ask (handy for spotting FAQ gaps). Both tables are
-- only ever touched by the "chat" Edge Function using the service-role
-- key, so RLS is enabled with no policies -- nobody else (anon or
-- authenticated) can read or write them directly.

create table if not exists chat_usage (
  client_id text not null,
  day date not null default current_date,
  count int not null default 0,
  primary key (client_id, day)
);
alter table chat_usage enable row level security;

create table if not exists chat_log (
  id bigint generated always as identity primary key,
  client_id text not null,
  message text not null,
  reply text not null,
  created_at timestamptz not null default now()
);
alter table chat_log enable row level security;
