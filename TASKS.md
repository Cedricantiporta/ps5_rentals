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
- [x] Admin: "Edit" action (Rentals/Reservations menu) opens a modal to
      change a rental's note; renter name+note editing moved onto the
      Renters tab's own "Edit name / note" menu item (was briefly on
      Pending Payments, corrected to Renters per owner's follow-up).
- [x] Add Game: price is a tier picker (4 real catalog price points) instead
      of four free-typed numbers; "Custom..." still falls back to manual
      entry.
- [x] **Critical fix**: signed-in customers' self-serve rentals now always
      link to their account instead of silently falling back to the
      tracking-code/guest path (`create_rental_hold` was always called
      through the anon Supabase client, so `auth.uid()` was never set even
      when the customer was signed in via the other client -- see
      `catalog.js`'s `confirmPaymentSent()`).
- [x] Device-specific tracking code auto-populate on the guest login/track
      pages -- investigated, already worked correctly; not a bug.
- [x] Removed game cover thumbnails from the Swap Requests table.
- [x] Swap price-tier labels are no longer display-only: swapping to a
      pricier game now actually collects the difference via the same GCash
      flow a new rental uses ("Add ₱X" -> submit -> payment screen ->
      "I've Paid"), enforced server-side (`migration_22`). Same-price/
      cheaper swaps are unaffected -- still free, no label.
- [x] A rental (including its very first swap) can't be swapped until 24h
      after it was created -- was already hinted at in the admin dashboard
      but never actually enforced for the customer-facing RPC; now is
      (`migration_22`, new `too_new` error code).
- [x] Admin layout: sidebar narrowed to 188px, the two separate hide/show
      hamburgers merged into one always-visible toggle beside the topbar
      title, Rentals' Game column capped/truncated so a long title + swap
      pills can't stretch the table.
- [x] All admin tables' horizontal scrollbar is now always visibly drawn
      (thin, styled thumb) instead of relying on an auto-hiding OS/overlay
      scrollbar to reveal that a table can scroll.
- [x] Swap Requests tab now shows each request's payment status ("Unpaid
      ₱X" / "Paid ₱X" / "--" for a free swap) and a "Confirm Payment"
      action (plain `payment_status` column write) for an unpaid upcharge;
      Approve stays disabled with an explanatory tooltip until that's
      done -- `approve_swap_request` already refused server-side, this is
      just the admin UI finally showing that state.

### Migrations
- `migration_21_guest_name_uses_tracking_code.sql` -- run.
- `migration_22_swap_upcharge_payment.sql` -- run.
- `migration_20_reservation_queue_fix.sql` -- from the previous session;
  confirm applied if not sure.

## Known gap, not yet scheduled

The signed-in portal's active-rental card still doesn't show swap
eligibility or an in-progress state the way the guest portal's does
(`can_swap` / `swap_blocked_reason` / "Swap pending -> Title") -- clicking
Swap Game there always opens the picker regardless of whether the rental
is actually swappable right now, and a request already pending doesn't
show anywhere on the card. Pre-dates this session's swap-unification work;
worth a follow-up pass if the owner wants parity between the two portals.
