# June Digitals -- active task list

Working backlog from the owner's Sep 20 batch of requests. Updated as items
land; not a permanent design doc -- delete/trim finished sections once
they're stable in `main` and mentioned in a commit message.

## Done this session

- [x] Sidebar reorder + Swap/Reservations/History nested under Rentals (no
      longer collapsible -- always expanded, per follow-up).
- [x] Collapsible whole-sidebar hide/show, topbar separator removed,
      New Rental/Add Renter moved onto the search row.
- [x] Swap Current Rental disabled (with reason shown) unless the customer
      actually has an active rental.
- [x] Fixed "I've Paid" occasionally opening Messenger in a new tab (the
      RPC-failure fallback path wasn't using the same-tab nav the success
      path already had).
- [x] Actions column pinned to the right edge on Pending/Swaps/Rentals/
      Reservations/Renters tables (horizontal scroll for the rest).
- [x] Panel intro hints moved to a "?" tooltip next to the topbar title.
- [x] Renters table's Note column truncated to match the other tables.
- [x] New pending payment / swap request now beeps + fires a browser
      notification.
- [x] Nameless renters get their own tracking code as their name instead of
      the generic "Guest" (`supabase/migration_21...sql` -- **owner still
      needs to run this one**, see below).
- [x] Search on the public catalog auto-switches to the "All" chip when the
      current quick-filter tab has zero matches but another tab would.
- [x] Active rental cards are no longer clickable; only "Swap Game" is
      (added that button to the signed-in portal, which never had one).
      Styled solid white (dark theme) / blue (light theme).
- [x] Admin tables no longer lock in a too-narrow actions column when their
      first-ever load happens to have zero rows.
- [x] Chat assistant's system prompt now covers pre-release reservations,
      the full-account profile, and the active-rental-required swap gate.
- [x] One-time welcome modal on the signed-in account portal's first visit
      (localStorage-gated, copy is a first pass -- worth the owner's
      eyeball once seen live).
- [x] Unified the two portals' swap flow onto one correct, RPC-based
      implementation (`shared.js`'s `RCAccount.openSwapModal`) -- the
      signed-in portal's Swap Game button previously fell back to a fake/
      static-Messenger swap path, now uses the real `submit_swap_request`
      flow the guest portal always had.
- [x] Swap game picker groups candidates by price relative to the rental
      being swapped out of: same price (no label), pricier ascending
      (`+₱150`), cheaper descending (`Save ₱100`). **Display only** --
      swapping is still mechanically free; see the still-open question
      below if that's not what's wanted.
- [x] Admin: "Edit" action (Rentals/Reservations menu, a new icon button on
      Pending) opens a modal to change a renter's name and/or a rental's
      note; clicking any editable Notes cell opens the same modal
      pre-filled. History's Notes column stays read-only, on purpose.

### Migrations the owner still needs to run (Supabase SQL editor, Ctrl+A, Run)
- `migration_21_guest_name_uses_tracking_code.sql`
- `migration_20_reservation_queue_fix.sql` (from the previous session, if
  not already applied)

## Open questions for the owner (nothing built yet pending an answer)

1. **Swap price-tier labels** -- currently display-only (see above).
   Should swapping to a pricier game actually require collecting the price
   difference before approval? That would be a real new feature (payment
   UI, admin confirmation step, RPC changes), not a small follow-up --
   flagging before anyone builds it on spec.
2. **"Delete" on a rental** -- read as the existing End Rental/Cancel
   actions (already present), not a new hard-delete. The new Edit action
   only covers renaming/notes. Confirm this is what was meant.

## Known gap, not yet scheduled

The signed-in portal's active-rental card still doesn't show swap
eligibility or an in-progress state the way the guest portal's does
(`can_swap` / `swap_blocked_reason` / "Swap pending -> Title") -- clicking
Swap Game there always opens the picker regardless of whether the rental
is actually swappable right now, and a request already pending doesn't
show anywhere on the card. Pre-dates this session's swap-unification work;
worth a follow-up pass if the owner wants parity between the two portals.
