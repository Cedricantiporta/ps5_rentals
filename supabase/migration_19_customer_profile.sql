-- ============================================================================
-- migration_19 -- customer profile: display name + avatar picker
--
-- WHY: the owner wants the account portal to let a signed-in customer set a
-- display name and pick a profile picture from a fixed set the owner
-- supplies (not an open photo upload -- there's no storage/moderation
-- pipeline for that yet).
--
-- DESIGN
-- * `renters.display_name` is SEPARATE from `renters.name`. `name` is the
--   admin-facing field used for search, Messenger matching and the Renters
--   table -- it stays admin-only. `display_name` is what the portal shows
--   ("Welcome back, X") and is customer-editable. A customer typing
--   something silly into their own display name can't corrupt admin data.
-- * `renters.avatar_id` is a short slug, NOT a URL or an uploaded file --
--   the owner drops real image files at `/assets/avatars/<avatar_id>.png`
--   whenever they're ready; the portal ships a small built-in fallback set
--   (initials/generic icons) so avatar picking works today even with zero
--   files on disk, and starts showing real art the moment files land at
--   those paths. The CHECK constraint below is defense-in-depth against the
--   value ever reaching an <img src> unescaped -- it's still esc()'d
--   client-side regardless.
-- * update_my_profile() is the ONLY way to change either column from the
--   client -- there is no direct anon/authenticated UPDATE grant on
--   renters for these columns, so a customer can't rename themselves via a
--   raw PostgREST call, only through this validated RPC.
-- * ensure_my_renter() (migration_12) now also returns both columns, so the
--   portal's existing first-load call gets them for free with no second
--   round trip.
--
-- WITHOUT THIS: no profile editing; portal keeps showing nothing for a
-- customer-chosen name/avatar because the columns don't exist.
--
-- HOW TO RUN: new query tab, Ctrl+A to select ALL, Run. Safe to re-run.
-- ============================================================================

alter table renters add column if not exists display_name text;
alter table renters add column if not exists avatar_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'renters_avatar_id_format'
  ) then
    alter table renters add constraint renters_avatar_id_format
      check (avatar_id is null or avatar_id ~ '^[a-z0-9_-]{1,40}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'renters_display_name_length'
  ) then
    alter table renters add constraint renters_display_name_length
      check (display_name is null or char_length(display_name) between 1 and 40);
  end if;
end $$;

-- ============================================================================
-- update_my_profile(p_display_name, p_avatar_id) -- security definer, but
-- only ever touches the caller's OWN renter row (looked up by auth.uid(),
-- never by a client-supplied id) so it needs no separate ownership check.
-- Pass null for either argument to leave it unchanged; pass the matching
-- p_clear_* flag to explicitly reset one back to null (distinguishes "leave
-- alone" from "clear it" without overloading empty-string semantics).
-- ============================================================================
create or replace function update_my_profile(
  p_display_name text default null,
  p_avatar_id text default null,
  p_clear_display_name boolean default false,
  p_clear_avatar boolean default false
)
returns table(ok boolean, error text, display_name text, avatar_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  v_renter_id bigint;
  v_name text;
  v_avatar text;
begin
  if uid is null then
    return query select false, 'not_signed_in', null::text, null::text;
    return;
  end if;

  select id, display_name, avatar_id into v_renter_id, v_name, v_avatar
    from renters where auth_user_id = uid;

  if v_renter_id is null then
    return query select false, 'no_renter', null::text, null::text;
    return;
  end if;

  if p_clear_display_name then
    v_name := null;
  elsif p_display_name is not null then
    v_name := nullif(trim(p_display_name), '');
    if v_name is not null and char_length(v_name) > 40 then
      return query select false, 'name_too_long', null::text, null::text;
      return;
    end if;
  end if;

  if p_clear_avatar then
    v_avatar := null;
  elsif p_avatar_id is not null then
    v_avatar := nullif(trim(p_avatar_id), '');
    if v_avatar is not null and v_avatar !~ '^[a-z0-9_-]{1,40}$' then
      return query select false, 'bad_avatar_id', null::text, null::text;
      return;
    end if;
  end if;

  update renters set display_name = v_name, avatar_id = v_avatar
    where id = v_renter_id;

  return query select true, null::text, v_name, v_avatar;
exception when others then
  return query select false, 'unexpected_error', null::text, null::text;
end;
$$;

grant execute on function update_my_profile(text, text, boolean, boolean) to authenticated;

-- ============================================================================
-- Extend ensure_my_renter() to also return the profile fields, so the
-- portal's existing on-load call gets them for free. Return type is
-- changing, so the old 2-column function must be dropped first.
-- ============================================================================
drop function if exists ensure_my_renter();

create or replace function ensure_my_renter()
returns table(renter_id bigint, created boolean, display_name text, avatar_id text, name text, public_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  new_id bigint;
  derived_name text;
  user_email text;
  user_meta jsonb;
  r renters%rowtype;
begin
  if uid is null then
    raise exception 'ensure_my_renter: no authenticated user';
  end if;

  select * into r from renters where auth_user_id = uid;
  if found then
    return query select r.id, false, r.display_name, r.avatar_id, r.name, r.public_code;
    return;
  end if;

  begin
    select au.email, au.raw_user_meta_data into user_email, user_meta
    from auth.users au where au.id = uid;
  exception when others then
    user_email := null;
    user_meta := null;
  end;

  derived_name := coalesce(
    nullif(trim(user_meta ->> 'full_name'), ''),
    nullif(trim(user_meta ->> 'name'), ''),
    nullif(trim(split_part(coalesce(user_email, ''), '@', 1)), ''),
    'Customer ' || substr(uid::text, 1, 8)
  );

  insert into renters (name, auth_user_id, contact_note)
  values (
    derived_name,
    uid,
    'Auto-created via ensure_my_renter() on login (' || coalesce(user_email, uid::text) ||
      ') -- check Renters for a matching walk-in to merge into.'
  )
  on conflict (auth_user_id) do nothing
  returning id into new_id;

  if new_id is null then
    select * into r from renters where auth_user_id = uid;
    return query select r.id, false, r.display_name, r.avatar_id, r.name, r.public_code;
    return;
  end if;

  select * into r from renters where id = new_id;
  return query select r.id, true, r.display_name, r.avatar_id, r.name, r.public_code;
end;
$$;

grant execute on function ensure_my_renter() to authenticated;

-- ============================================================================
-- VERIFICATION -- read the actual rows.
-- ============================================================================
select column_name, data_type from information_schema.columns
 where table_name = 'renters' and column_name in ('display_name', 'avatar_id');

select conname from pg_constraint
 where conname in ('renters_avatar_id_format', 'renters_display_name_length');

-- Should print two rows: update_my_profile (4 args) and ensure_my_renter (0 args).
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('update_my_profile', 'ensure_my_renter');
