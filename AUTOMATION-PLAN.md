# June Digitals — Automation Plan

Goal: customers self-serve on the website (rent, pay, swap, check status) instead of
negotiating everything over Messenger, and the admin stops doing manual work that a
webhook can do.

This doc is the brief for implementation sessions. Each phase is independently
shippable. Do them in order — later phases assume earlier ones.

---

## Stack (context for a fresh session)

- **Front end**: static site in `site/`, vanilla JS, no framework or build step.
  Public catalog = `site/index.html` + `site/assets/catalog.js` / `catalog.css`.
  Admin = `site/admin/` (`dashboard.html` / `.js` / `.css`, `admin.js` for auth).
- **Backend**: Supabase — Postgres, Auth, Edge Functions (Deno), `pg_cron`.
- **Hosting**: Vercel, auto-deploys `site/` on push to `main`.
- **Tables**: `games`, `renters`, `rentals`, `rental_requests`, `chat_usage`, `chat_log`.
- **Edge Functions**: `chat` (Gemini-backed support bot).

### Deployment reality — read this before planning any task

| Change type | How it ships |
|---|---|
| Anything in `site/` | `git push` → Vercel auto-deploys. Fully automatable. |
| SQL migration | Human pastes into Supabase SQL editor. **Cannot be automated.** |
| Edge Function | Human pastes into Supabase dashboard → Deploy. **Cannot be automated.** |

There is no Supabase CLI access in these sessions. Any task touching the database or
an Edge Function ends at "code written, awaiting deploy" and cannot be verified until
a human deploys it. Plan tasks so front-end work isn't blocked behind a deploy.

---

## Phase 0 — Security prerequisite (blocking)

Current policies on `games`, `renters`, `rentals` are all
`auth.role() = 'authenticated'`, and `rcRequireAuth()` in `site/admin/admin.js` only
checks that a session exists. This is safe *only* because public signup is disabled
and one admin account exists.

**Adding customer accounts without fixing this gives every customer full write access
to all business data and entry to the admin dashboard.** Fix first.

Tasks:

- [ ] Migration: create `admins` table (`user_id uuid references auth.users primary key`),
      insert the existing admin's `user_id`.
- [ ] Migration: replace every `auth.role() = 'authenticated'` policy with
      `exists (select 1 from admins where user_id = auth.uid())`.
- [ ] Migration: same treatment for `rental_requests` and the `game-covers` storage policies.
- [ ] `admin.js`: `rcRequireAuth()` must also verify the session's user is in `admins`,
      and sign out + redirect if not.
- [ ] Verify: admin dashboard still fully works end to end after the policy swap.

---

## Phase 1 — Customer accounts

Use **email + password** first, not Facebook. Reasons: no Meta app review, no external
setup, and agents can create test accounts to verify the flows. Facebook becomes an
additional provider later (same `auth.users` table, portal code unchanged).

Tasks:

- [ ] Supabase dashboard (human): Authentication → Providers → Email → enable signups.
      Safe only after Phase 0 lands.
- [ ] Migration: `renters.auth_user_id uuid references auth.users unique`.
- [ ] Migration: RLS on `renters` / `rentals` so a customer reads only their own rows
      (`renter_id in (select id from renters where auth_user_id = auth.uid())`).
      Keep the admin policy alongside it.
- [ ] `site/account/login.html` + signup — separate from the admin login page.
- [ ] Account claiming: a new signup with no matching `renters` row creates one.
      An existing walk-in renter needs linking — match on name/Messenger, admin confirms.
- [ ] Admin dashboard: show which renters have a linked account; allow manual linking.
- [ ] **Clean up duplicate renters before this ships** (there are two "Cedrok") —
      otherwise one person's history splits across two accounts permanently.

---

## Phase 2 — Customer portal (read-only)

Pure front end. No deploy gate — fully agent-testable once Phase 1 is live.

- [ ] `site/account/index.html` — the portal shell, reusing existing site styles.
- [ ] Active rentals: game, slot, plan, start/end date, days left, payment status.
- [ ] Rental history, including swap chains.
- [ ] Empty state for a customer with no rentals.
- [ ] Nav: show "My Account" when a session exists, "Sign in" when not.
- [ ] Verify as a real customer: sign up, see own rentals, confirm another customer's
      rentals are not visible (RLS check, not just UI).

---

## Phase 3 — Online payment (removes the Messenger bottleneck)

GCash has no public API for individuals. Use a PH gateway that exposes it —
**PayMongo** or **Xendit**. Both give a real API plus webhooks. Expect roughly 2–3%
per transaction (confirm current rates) and business KYC at signup.

Interim option if signup drags: customer uploads a GCash receipt screenshot in the
portal, admin taps approve. Kills the back-and-forth at zero fees.

- [ ] Human: sign up with the chosen provider, complete KYC, get test + live keys.
- [ ] Human: add keys as Edge Function secrets.
- [ ] Migration: `payments` table — `rental_id`, `provider`, `provider_ref`, `amount`,
      `status`, `created_at`, `paid_at`.
- [ ] Edge Function `create-payment`: takes a rental, creates the provider checkout,
      returns the redirect URL.
- [ ] Edge Function `payment-webhook`: **verify the provider's signature** (do not skip),
      mark payment paid, activate the rental, increment `times_rented`, claim the slot.
      Must be idempotent — providers retry webhooks.
- [ ] Portal: "Pay now" on a pending rental → provider checkout → return page.
- [ ] Admin: payment status column; keep a manual "mark as paid" override for edge cases.
- [ ] Verify in the provider's **test mode** end to end before touching live keys.

---

## Phase 4 — Self-service rent and swap

The rules already exist in `site/admin/dashboard.js`: 24h swap cooldown, weekly = 1 swap,
monthly = unlimited, reservation queue ordering, slot availability. Moving them
server-side is what makes them trustworthy — a client-side check is advisory only.

- [ ] Edge Function `request-rental`: validate slot is genuinely free, create the rental
      as pending, return it for payment. Replaces the blind `rental_requests` insert for
      logged-in customers.
- [ ] Edge Function `request-swap`: validate cooldown, remaining swap allowance, and target
      availability; execute the swap atomically (end old rental, free its slot, create the
      new one carrying the same end date, link `swapped_from_rental_id`).
- [ ] Portal: rent flow for logged-in customers; swap picker on an active rental showing
      only genuinely swappable games.
- [ ] Surface refusals clearly: "cooldown, 6h left", "weekly plan includes 1 swap".
- [ ] Keep every admin override in place — admins must still fix things by hand.
- [ ] Verify: cooldown blocks a second swap, weekly limit blocks swap #2, taken slot
      is refused, successful swap keeps the original end date.

---

## Phase 5 — Notifications

- [ ] Human: Resend account + API key as an Edge Function secret (free tier ≈3k/month).
- [ ] Edge Function `send-email` with simple templates.
- [ ] Trigger on: payment confirmed, rental activated, swap completed.
- [ ] `pg_cron` daily job: rentals expiring within 2 days → reminder email.
      Follow the existing auto-expire cron as the pattern.
- [ ] Optional: daily admin digest — new rentals, payments, expiring soon.

---

## Phase 6 — Credential delivery (highest risk; decide before building)

Renting a digital PS5 game means handing over PSN account credentials. There is no
model for this in the schema today — it happens entirely by hand over Messenger.

Automating it is technically easy and operationally the riskiest thing in the system:
leaked credentials, two customers logged into one account at once, Sony bans.

If you do build it:

- [ ] Migration: `psn_accounts` (credentials **encrypted at rest**, never in a public table),
      `game_accounts` linking accounts to games and slots.
- [ ] Credentials visible in the portal **only** while the rental is active.
- [ ] Log every reveal — who, when, which rental.
- [ ] Never send credentials by email; portal-only display.
- [ ] Consider keeping a human approval step here even when everything else is automated.

---

## Phase 7 — Messenger automation (optional)

Possible via the Messenger Send API on the existing Facebook Page, but constrained:
outside a 24-hour window from the customer's last message you may only send under an
approved message tag (`POST_PURCHASE_UPDATE`, `ACCOUNT_UPDATE`), which requires Meta app
review. Treat as a late nice-to-have — email covers the same ground with no review.

- [ ] Meta app + review for the needed tags.
- [ ] Migration: store `messenger_psid` on `renters`.
- [ ] Edge Function `send-messenger`.
- [ ] Keep Messenger as a human fallback regardless — some customers will always prefer it.

---

## Deliberately not automated

- Refunds, disputes, chargebacks.
- Buying a new title, or provisioning a new PSN account.
- Sony account lockouts and bans.
- Customers who simply prefer chatting — keep the Messenger route open.

---

## Testing approach

- Front-end phases: verify in a real browser against local dev, then production.
- Anything behind RLS: verify as **two different customers**, confirming customer A
  cannot read customer B's rows. UI-level checks prove nothing here.
- Payments: provider test mode only, until the full path works.
- Never test against live business data if a staging Supabase project exists.
