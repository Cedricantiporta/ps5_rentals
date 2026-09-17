# Self-Serve Rent Flow — API Contract (v1)

Frozen contract. Every agent builds against exactly these names/shapes.
SQL agent implements them; client agents call them. Do not rename anything here.

## Design decisions (locked)

1. **A rental request IS a pending rental.** `rentals.status='pending'` already means
   "awaiting GCash confirmation". We stop creating a parallel `rental_requests` row for
   the normal rent flow and write straight to `rentals`. The admin's old Incoming
   Requests tab becomes a **Pending Payments** queue over `rentals` with two one-click
   buttons. No form to fill, no renter to link — the row is already complete.
   `rental_requests` stays in the DB read-only for historical rows.

2. **Pending soft-holds the slot** for `HOLD_MINUTES` (30). This flips
   `games.<slot>_available = false` immediately so two customers can't both pay for the
   same slot. A cron job releases expired unpaid holds automatically.

3. **Money is computed server-side** from `games.<slot>_<plan>`. The client never sends
   an amount. Anything the client sends for price is ignored.

4. **No signup required.** Every renter gets a `public_code` (like a tracking number).
   Customer can view rentals + swap with just that code. Signing in is an optional
   convenience that links the same renter row.

5. **Swap is fully automatic** when the rules pass. No admin approval step. Admin only
   still has to hand over credentials on Messenger.

## Codes

- `renters.public_code` — customer's permanent tracking code. Format `JD-XXXXXX`.
- `rentals.ref_code` — per-rental payment reference. Format `R-XXXXXX`. Customer types
  this in the GCash message so the admin can match a screenshot to a row instantly.
- Alphabet: `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O/1/I/L). Case-insensitive on lookup.

## RPCs (all `security definer`, `set search_path = public, pg_temp`)

### `create_rental_hold(p_game_slug text, p_slot text, p_plan text, p_renter_id bigint default null, p_name text default null, p_messenger text default null)`
Callable by `anon` and `authenticated`.
Creates renter if needed, creates `rentals` row `status='pending'`, soft-holds slot.
If `p_renter_id` is passed it must belong to `auth.uid()` (checked via `is_own_rental`),
otherwise it is ignored and a new/guest renter is used.

Returns one row:
```
rental_id bigint, ref_code text, public_code text, amount int,
plan text, slot text, game_title text, end_date date,
hold_expires_at timestamptz, gcash_number text, gcash_name text, ok boolean, error text
```
On failure returns `ok=false` with `error` in: `game_not_found`, `slot_unavailable`,
`no_price`, `bad_plan`, `bad_slot`. Never raises — always returns a row.

### `lookup_rentals_by_code(p_code text)`
Callable by `anon`. Accepts a `public_code` OR a `ref_code`.
Returns zero+ rows, newest first:
```
rental_id bigint, ref_code text, public_code text, renter_name text,
game_slug text, game_title text, game_cover text, slot text, plan text,
amount int, status text, payment_status text,
start_date date, end_date date, days_left int,
swap_count int, can_swap boolean, swap_blocked_reason text
```
Returns empty set for an unknown code. Leaks nothing about other renters.

### `request_swap(p_code text, p_rental_id bigint, p_new_game_slug text, p_new_slot text)`
Callable by `anon`. `p_code` authenticates (public_code or that rental's ref_code).
Auto-approves when ALL are true, else returns `ok=false`:
- rental `status='active'`
- `end_date >= current_date + 1`
- `swap_count < SWAP_LIMIT` (2)
- target game slot is available
- target game is not the same game+slot

On success: old rental → `status='ended'` (frees its slot), new `rentals` row created
`status='active'`, `payment_status='paid'`, same `end_date`, `amount=0`,
`swapped_from_rental_id` set, `swap_count = old + 1`, target slot flipped unavailable.

Returns one row:
```
ok boolean, error text, new_rental_id bigint, new_ref_code text,
game_title text, slot text, end_date date, swaps_left int
```
`error` in: `not_found`, `not_active`, `too_close_to_end`, `swap_limit_reached`,
`slot_unavailable`, `same_game`.

### `get_public_settings()`
Callable by `anon`. Returns one row: `gcash_number text, gcash_name text,
messenger_url text, hold_minutes int, swap_limit int`.

## Table additions (SQL agent)

```
settings(key text primary key, value text)   -- admin-editable, anon can read via RPC only
renters.public_code text unique
rentals.ref_code text unique
rentals.swap_count int not null default 0
rentals.hold_expires_at timestamptz
```
Backfill `public_code` for every existing renter and `ref_code` for every existing rental.

## Cron

`release_expired_holds()` every 5 min: any `rentals` with `status='pending'` and
`hold_expires_at < now()` → `status='cancelled'`, slot freed.

## Client call shape (supabase-js v2, ES5 style used in this repo)

```js
sb.rpc('create_rental_hold', { p_game_slug: g.slug, p_slot: 'trophy', p_plan: 'weekly', p_renter_id: renterId })
  .then(function (res) { var row = res.data && res.data[0]; ... });
```
RPCs returning `table(...)` come back as an **array**. Always read `res.data[0]` for the
single-row ones. Always handle `res.error` (migration not applied yet) by failing soft
back to the current Messenger-only flow — the site must never hard-break pre-migration.
