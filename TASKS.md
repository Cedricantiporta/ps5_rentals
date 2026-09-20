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

### Migrations the owner still needs to run (Supabase SQL editor, Ctrl+A, Run)
- `migration_21_guest_name_uses_tracking_code.sql`
- `migration_20_reservation_queue_fix.sql` (from the previous session, if
  not already applied)

## Open -- in progress / not started

### 1. Unify the two portals' swap flow (prep work for #2)
`site/account/index.html` (signed-in portal) never had its own "Swap Game"
button before this session -- it relied entirely on the whole active-rental
card being clickable, which opened the generic catalog rent/swap modal
(`site/assets/catalog.js`'s `openModal`). That modal's swap path is the
OLD one: a static Messenger message, not the real `submit_swap_request` RPC.
`site/account/track.js` (guest tracking-code portal) has its own, CORRECT,
self-contained swap modal (`ensureSwapModal`/`openSwapModal`/`submitSwap`)
that actually calls `submit_swap_request` and shows a real pending/approved
state. Right now the two portals behave inconsistently for the same action.

**Plan:** move track.js's swap-modal functions into `site/account/shared.js`
so both portals call the same, correct implementation. index.html's new
Swap Game button (added this session) should call the shared version
instead of `window.RCCatalog.openModal(slug)`.

### 2. Swap game picker: price-tier grouping
Owner's request: group the swappable-games list by price relative to the
rental being swapped out of --
- same price first (no label needed, it's a lateral swap)
- more expensive next, labeled with the upcharge, e.g. "+₱150"
- cheaper last, labeled with the price (or the savings)

**Open question for the owner, don't assume:** is this purely a DISPLAY
change (just show the price difference, staff still handle everything
manually same as today -- swapping stays "free" per the current FAQ/chat
copy), or should swapping to a pricier game actually require collecting
the difference before approval (a real new payment step)? Defaulting to
the display-only interpretation unless told otherwise -- actually charging
a price difference is a materially bigger feature (new payment UI, admin
confirmation step, RPC changes) and souldn't be built silently.

Depends on #1 landing first (so there's one swap picker to enhance, not two).

### 3. Admin: edit a rental's renter name/note; click-to-edit on Notes
- New "Edit" action on Rentals/Reservations/Pending Payments rows (their
  existing 3-dot menu or, for Pending, alongside Confirm Paid/Decline) that
  opens a small modal to change the renter's name and/or the rental's note.
- Clicking the (already-truncated) Notes cell anywhere it appears opens
  that same modal, pre-filled, instead of only showing the full text via a
  hover tooltip.
- "delete" in the owner's phrasing is being read as the EXISTING End
  Rental/Cancel actions (already present), not a new hard-delete -- flag
  to the owner if that's wrong.

### 4. ~~Account page: first-visit welcome/onboarding popup~~ -- done
Moved to "Done this session" above.
