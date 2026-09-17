# Contract Amendment 1 — Swap goes through the admin app

Supersedes the `request_swap` section of `RENT-FLOW-CONTRACT.md`. Everything else
in that file still stands.

## What changed and why

Owner decision: a swap must NOT auto-approve. It goes into the **admin app** as a new
**Swap Requests** tab, and the admin approves or declines it there. Rationale: the admin
has to hand over account credentials for the new game anyway, so there is always a human
step — better to have one clear queue than an auto-approval the admin then has to chase.
The customer never gets sent to Messenger to request a swap.

## New table

```sql
swap_requests(
  id bigint generated always as identity primary key,
  rental_id    bigint not null references rentals(id) on delete cascade,
  renter_id    bigint not null references renters(id) on delete cascade,
  from_game_id bigint not null references games(id),
  from_slot    text not null,
  to_game_id   bigint not null references games(id),
  to_slot      text not null check (to_slot in ('trophy','nontrophy')),
  status       text not null default 'pending'
                 check (status in ('pending','approved','declined','expired')),
  ref_code     text unique,              -- 'S-XXXXXX', same gen_code() helper
  hold_expires_at timestamptz,           -- target slot is held until this
  admin_note   text,
  created_at   timestamptz not null default now(),
  handled_at   timestamptz
)
```
RLS on. Admin full access via `is_admin()`. No direct anon access — anon only reaches it
through the RPCs below. Index `status`, `rental_id`, `hold_expires_at`.

**Submitting a swap request soft-holds the target slot immediately** (same mechanism as a
pending rental: `games.<to_slot>_available = false`). Otherwise someone else rents that
slot while the request waits for the admin. Hold length = `swap_hold_hours` setting,
default 24. Add `swap_hold_hours` to the seeded `settings` rows.

## `submit_swap_request(p_code text, p_rental_id bigint, p_new_game_slug text, p_new_slot text)`
Replaces `request_swap`. Callable by `anon` and `authenticated`. `p_code` authenticates
(the renter's `public_code` or that rental's `ref_code`). Validates exactly the same rules
`can_swap` reports, plus "no existing pending swap_request for this rental".

Returns one row:
```
ok boolean, error text, swap_request_id bigint, swap_ref_code text,
from_game_title text, to_game_title text, to_slot text, swaps_left int
```
`error` in: `not_found`, `not_active`, `too_close_to_end`, `swap_limit_reached`,
`slot_unavailable`, `same_game`, `already_pending`. Never raises.

## `approve_swap_request(p_id bigint, p_note text default null)`
Admin only — must check `is_admin()` and return `ok=false, error='not_admin'` otherwise.
Performs the swap atomically:
- old rental → `status='ended'`, its slot freed (`available=true`, `available_at=null`)
- new `rentals` row: `status='active'`, `payment_status='paid'`, `amount=0`,
  same `end_date` as the old rental, `swapped_from_rental_id` = old id,
  `swap_count` = old + 1, fresh `ref_code`
- target slot stays unavailable (already held), `hold_expires_at=null`
- swap_request → `status='approved'`, `handled_at=now()`

Returns `ok boolean, error text, new_rental_id bigint, new_ref_code text`.

## `decline_swap_request(p_id bigint, p_note text default null)`
Admin only. Sets `status='declined'`, `handled_at=now()`, and **frees the held target
slot**. Returns `ok boolean, error text`.

## `lookup_rentals_by_code` — two added columns
Append to its return table:
```
pending_swap_id bigint,        -- null when none
pending_swap_to_title text     -- null when none
```
and `can_swap` must now also be false (with `swap_blocked_reason = 'A swap request is
already waiting for approval.'`) when a pending swap_request exists for that rental.

## Cron
Extend `release_expired_holds()` to also expire `swap_requests` that are still `pending`
past `hold_expires_at`: set `status='expired'` and free the held target slot.
