-- Run this in the Supabase SQL editor.
-- Manual link to each renter's actual Messenger conversation, so the admin
-- can jump straight to it instead of searching Messenger by name. Paste the
-- URL from the address bar when viewing their thread in Messenger/Business
-- Suite (e.g. https://www.facebook.com/messages/t/<id>).
alter table renters add column if not exists messenger_url text;
