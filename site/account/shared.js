// Shared helpers for the customer account pages (login.html, index.html).
// Vanilla JS, ES5-ish (var, .then chains) to match catalog.js/admin.js style.
//
// IMPORTANT: this client is deliberately isolated from the admin client in
// site/admin/admin.js. Both point at the same Supabase project, and
// supabase-js's default storageKey is derived from the project URL alone
// ("sb-<ref>-auth-token") -- so two default-configured clients in the same
// browser would silently overwrite each other's session. We give the
// customer client its own storageKey so an admin and a customer session can
// coexist in the same browser without stomping each other.
(function () {
  'use strict';

  var CUSTOMER_STORAGE_KEY = 'rc-customer-auth-token';

  // Tracking-code guest portal (track.html) behaves like an auto-login:
  // once a customer has a code, it's remembered across tabs/restarts so
  // they never have to type it again. This exact key/plain-string shape is
  // a cross-agent contract -- site/assets/catalog.js (owned by another
  // agent) writes this same key the instant a rent request succeeds, so a
  // customer who just rented lands in the portal already tracked. Do not
  // rename the key or wrap the value (e.g. JSON) without updating that
  // agent's code too. Kept separate from CUSTOMER_STORAGE_KEY -- a guest
  // code and a signed-in session are unrelated, independent ways into the
  // portal (see RENT-FLOW-CONTRACT.md). localStorage throws in
  // private-browsing / storage-blocked modes, so every read and write here
  // is wrapped -- a guest who can't persist the code just has to retype
  // it; the page must never break because of it.
  var GUEST_CODE_KEY = 'rc-track-code';
  function saveGuestCode(code) {
    try { window.localStorage.setItem(GUEST_CODE_KEY, code); } catch (e) {}
  }
  function loadGuestCode() {
    try { return window.localStorage.getItem(GUEST_CODE_KEY) || ''; } catch (e) { return ''; }
  }
  function clearGuestCode() {
    try { window.localStorage.removeItem(GUEST_CODE_KEY); } catch (e) {}
  }

  // Accepts a renters.public_code ("JD-XXXXXX") or a rentals.ref_code
  // ("R-XXXXXX") per RENT-FLOW-CONTRACT.md, case-insensitively and tolerant
  // of surrounding whitespace and a missing prefix. When a recognizable
  // JD/R prefix is present (with or without its dash) it's normalized to
  // "PREFIX-REST"; otherwise the trimmed/uppercased/whitespace-stripped
  // value is sent as-is and left to the RPC to match.
  function normalizeTrackingCode(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
    var m = /^(JD|R)-?(.+)$/.exec(s);
    if (m && m[2]) return m[1] + '-' + m[2];
    return s;
  }

  var client = null;
  function getClient() {
    if (client) return client;
    if (!window.supabase || !window.RC_PUBLIC_CONFIG || !window.RC_PUBLIC_CONFIG.SUPABASE_URL) return null;
    client = window.supabase.createClient(
      window.RC_PUBLIC_CONFIG.SUPABASE_URL,
      window.RC_PUBLIC_CONFIG.SUPABASE_ANON_KEY,
      { auth: { persistSession: true, storageKey: CUSTOMER_STORAGE_KEY, storage: window.localStorage } }
    );
    return client;
  }

  function getSession() {
    var sb = getClient();
    if (!sb) return Promise.resolve(null);
    return sb.auth.getSession().then(function (res) {
      return (res.data && res.data.session) || null;
    }, function () { return null; });
  }

  // Redirects to the login page when signed out; resolves with the session
  // otherwise. Used by index.html (the portal) as its gate.
  function requireAuth() {
    return getSession().then(function (session) {
      if (!session) {
        window.location.href = '/account/login.html';
        return null;
      }
      return session;
    });
  }

  // Calls the ensure_my_renter() RPC (see supabase/migration_12_renter_claiming_rpc.sql)
  // so a signed-in customer with no renters row yet (fresh signup, or an
  // orphaned account from before the migration shipped) gets one created
  // right now, before we query rentals. Deliberately fails silently: if the
  // migration hasn't been applied yet the RPC won't exist (PostgREST answers
  // with a 404/PGRST202), and the portal must still load and fall back to
  // its existing "no rental history linked yet" state rather than breaking.
  function ensureRenter() {
    var sb = getClient();
    if (!sb) return Promise.resolve(null);
    return sb.rpc('ensure_my_renter').then(function (res) {
      if (res.error) {
        console.warn('June Digitals: ensure_my_renter RPC unavailable (migration not applied yet?)', res.error);
        return null;
      }
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      return row || null;
    }, function (err) {
      console.warn('June Digitals: ensure_my_renter call failed', err);
      return null;
    });
  }

  // Calls the update_my_profile() RPC (see
  // supabase/migration_19_customer_profile.sql) so a signed-in customer can
  // set their display name and/or avatar slug. Same fail-soft contract as
  // ensureRenter(): never throws, always resolves to an object the caller
  // can check .ok/.error on. If the migration hasn't been applied yet the
  // RPC won't exist (PostgREST answers with a 404/PGRST202) and this
  // resolves to { ok: false, error: 'unavailable' } instead of rejecting,
  // so callers can show a single "not available yet" message for both that
  // case and an RPC-reported error.
  //
  // opts: { displayName, avatarId, clearDisplayName, clearAvatar }. Pass
  // displayName/avatarId as null (or omit) to leave that field unchanged;
  // pass the matching clear* flag as true to explicitly reset it to null.
  function updateMyProfile(opts) {
    opts = opts || {};
    var sb = getClient();
    if (!sb) return Promise.resolve({ ok: false, error: 'unavailable' });
    return sb.rpc('update_my_profile', {
      p_display_name: opts.displayName != null ? opts.displayName : null,
      p_avatar_id: opts.avatarId != null ? opts.avatarId : null,
      p_clear_display_name: !!opts.clearDisplayName,
      p_clear_avatar: !!opts.clearAvatar
    }).then(function (res) {
      if (res.error) {
        console.warn('June Digitals: update_my_profile RPC unavailable (migration not applied yet?)', res.error);
        return { ok: false, error: 'unavailable' };
      }
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!row) return { ok: false, error: 'unavailable' };
      return row;
    }, function (err) {
      console.warn('June Digitals: update_my_profile call failed', err);
      return { ok: false, error: 'unavailable' };
    });
  }

  function signOut() {
    var sb = getClient();
    if (!sb) return Promise.resolve();
    return sb.auth.signOut().then(function () {
      window.location.href = '/account/login.html';
    });
  }

  // ---- formatting helpers, matching the conventions in assets/catalog.js
  // and admin/dashboard.js so the portal reads like the same site. ----

  function peso(n) { return (n === null || n === undefined || isNaN(n)) ? '—' : '₱' + Number(n).toLocaleString('en-PH'); }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function daysLeft(endIso) {
    if (!endIso) return null;
    var end = new Date(endIso + 'T00:00:00');
    if (isNaN(end.getTime())) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((end - today) / 86400000);
  }

  function daysLeftLabel(endIso) {
    var n = daysLeft(endIso);
    if (n === null) return '—';
    if (n < 0) return 'Ended ' + Math.abs(n) + 'd ago';
    if (n === 0) return 'Ends today';
    return n + 'd left';
  }

  function slotName(slot) { return slot === 'trophy' ? 'Trophy' : 'Non-Trophy'; }
  function planName(plan) { return plan === 'weekly' ? 'Weekly' : 'Monthly'; }

  // Formats an already-computed day-count into the big "X DAYS LEFT" focal
  // display used by both the signed-in portal (index.html) and the guest
  // tracking page (track.js), so the two pages read the same way. Takes a
  // plain number (or null/undefined) rather than a date, so each caller can
  // feed it whatever it already has -- index.html computes it locally via
  // daysLeft(), track.js gets it straight from lookup_rentals_by_code's
  // days_left column. Returns { num, label, cls } for the caller to drop
  // into a "<big num><small label>" badge; cls is a CSS hook for styling
  // ended/urgent states (see .rc-rental-days-badge in account.css).
  function daysLeftBig(n) {
    if (n === null || n === undefined || isNaN(n)) return { num: '—', label: '', cls: '' };
    if (n < 0) return { num: 'Ended', label: Math.abs(n) + (Math.abs(n) === 1 ? ' day ago' : ' days ago'), cls: 'is-ended' };
    if (n === 0) return { num: '0', label: 'Days Left · Ends Today', cls: 'is-urgent' };
    return { num: String(n), label: n === 1 ? 'Day Left' : 'Days Left', cls: n <= 2 ? 'is-urgent' : '' };
  }

  function statusInfo(status) {
    switch (status) {
      case 'active': return { label: 'ACTIVE', cls: 'rc-status-available' };
      case 'pending': return { label: 'PENDING', cls: 'rc-status-limited' };
      case 'ended': return { label: 'ENDED', cls: 'rc-status-closed' };
      case 'cancelled': return { label: 'CANCELLED', cls: 'rc-status-closed' };
      default: return { label: String(status || '').toUpperCase(), cls: 'rc-status-closed' };
    }
  }

  function paymentInfo(paymentStatus) {
    return paymentStatus === 'paid'
      ? { label: 'PAID', cls: 'rc-status-available' }
      : { label: 'PAYMENT PENDING', cls: 'rc-status-full' };
  }

  var ICON_PATHS = {
    trophy: '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'
  };
  function icon(name, cls) {
    var paths = ICON_PATHS[name] || '';
    return '<svg class="rc-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Walks swapped_from_rental_id backward, oldest first -- same convention
  // as admin/dashboard.js's swapChain(), so a swap chain reads the same way
  // in the portal as it does in the admin dashboard.
  function swapChain(rental, allRentals) {
    var chain = [rental];
    var cur = rental;
    while (cur.swapped_from_rental_id != null) {
      var prev = allRentals.filter(function (r) { return r.id === cur.swapped_from_rental_id; })[0];
      if (!prev) break;
      chain.unshift(prev);
      cur = prev;
    }
    return chain;
  }

  // ---- swap modal -- shared by track.js's guest portal and index.html's
  // signed-in portal, both of which call submit_swap_request() per
  // RENT-FLOW-CONTRACT.md / CONTRACT-AMENDMENT-1. Previously each portal
  // had its own copy; track.js's was the correct, complete one (index.html
  // just opened the general catalog rent modal's old static-Messenger swap
  // path) so this is that implementation, moved here and adapted to accept
  // either portal's rental shape.
  //
  // Callers pass a normalized `rental` object with only the fields both
  // portals can trivially supply: { rental_id, ref_code, game_slug,
  // game_title, slot, plan }. ref_code alone is enough to authenticate
  // the swap -- submit_swap_request's p_code also accepts a renter's
  // public_code, but this specific rental's own ref_code is on both
  // portals' rental rows already (lookup_rentals_by_code's flat columns,
  // and index.html's raw `rentals.*` select) and scopes identically, since
  // p_rental_id already pins the exact rental (see code_matches() in
  // migration_16_swap_and_lookup.sql).
  //
  // opts.onSwapped(row), if given, fires when the customer dismisses the
  // "Swap Requested" screen -- not immediately on submit, since a swap
  // request only ever lands in an admin queue here; there's nothing for a
  // caller to refresh until the customer has read that and clicked through.
  // ---------------------------------------------------------------------
  var SWAP_MESSENGER_URL = 'https://m.me/junedigitalaccess';
  var swapState = { rental: null, opts: null, selected: null, games: null, fromPrice: null };
  var swapGamesCache = null;

  // Mirrors assets/catalog.js's loadGames() is_test filter so the picker
  // matches the live public catalog. During manual testing, feed fake rows
  // straight into swapState.games instead of relying on this filter, so
  // zz-test-game-a/b aren't hidden.
  function loadSwapGames() {
    if (swapGamesCache) return Promise.resolve(swapGamesCache);
    var sb = getClient();
    if (!sb) return Promise.reject(new Error('no supabase client'));
    return sb.from('games').select('*').then(function (res) {
      if (res.error) throw res.error;
      swapGamesCache = res.data.filter(function (row) { return row.is_test !== true; }).map(function (row) {
        return {
          slug: row.slug, title: row.title, cover: row.cover,
          trophy_available: row.trophy_available, nontrophy_available: row.nontrophy_available,
          trophy_weekly: row.trophy_weekly, trophy_monthly: row.trophy_monthly
        };
      });
      return swapGamesCache;
    });
  }

  // trophy_/nontrophy_ prices are identical for every game in this catalog
  // (see seed_games.sql) -- trophy_* is used as the one representative
  // price per game+plan for the picker's grouping/sort/tag. If a game is
  // ever priced differently per slot, this needs to move to a per-slot-
  // button price instead of one tag per game row.
  function swapGamePrice(g, plan) {
    var p = plan === 'monthly' ? g.trophy_monthly : g.trophy_weekly;
    return (p === null || p === undefined) ? null : p;
  }

  // Display-only tag, per the owner's request to show swap candidates
  // relative to the price of the rental being swapped out of -- the swap
  // itself stays free/unchanged no matter what this says (submit_swap_
  // request never charges or credits a price difference); it's here only
  // so a customer isn't surprised by what a "free" swap actually gets them.
  function swapPriceTag(price, fromPrice) {
    if (price == null || fromPrice == null) return '';
    var diff = price - fromPrice;
    if (diff === 0) return '';
    return diff > 0
      ? ' <span class="rc-swap-price-tag rc-swap-price-more">+' + peso(diff) + '</span>'
      : ' <span class="rc-swap-price-tag rc-swap-price-less">Save ' + peso(-diff) + '</span>';
  }

  function ensureSwapModal() {
    if (document.getElementById('rcSwapOverlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'rc-modal-overlay';
    overlay.id = 'rcSwapOverlay';
    overlay.innerHTML =
      '<div class="rc-modal" id="rcSwapModal">' +
        '<button type="button" class="rc-modal-close" id="rcSwapCloseX" aria-label="Close">' + icon('x') + '</button>' +
        '<div class="rc-modal-body" id="rcSwapBody"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSwapModal(); });
    document.getElementById('rcSwapCloseX').addEventListener('click', closeSwapModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeSwapModal();
    });
  }

  function openSwapModal(rental, opts) {
    ensureSwapModal();
    swapState.rental = rental;
    swapState.opts = opts || {};
    swapState.selected = null;
    swapState.fromPrice = null;
    document.getElementById('rcSwapOverlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
    renderSwapPick();
  }

  function closeSwapModal() {
    var overlay = document.getElementById('rcSwapOverlay');
    if (overlay) overlay.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function swapSlotBtn(g, slotKey) {
    var available = slotKey === 'trophy' ? g.trophy_available : g.nontrophy_available;
    var isCurrent = swapState.rental.game_slug === g.slug && swapState.rental.slot === slotKey;
    var disabled = !available || isCurrent;
    return '<button type="button" class="rc-slot-option' + (disabled ? ' is-disabled' : '') + '"' +
      (disabled ? ' disabled' : '') +
      ' data-slug="' + esc(g.slug) + '" data-slot="' + slotKey + '"' +
      ' data-title="' + esc(g.title) + '" data-cover="' + esc(g.cover || '') + '">' +
      '<div class="rc-slot-option-top"><span class="rc-slot-option-name">' + slotName(slotKey) + '</span></div>' +
      '<span class="rc-slot-option-price">' + (isCurrent ? 'Current' : (available ? 'Available' : 'Unavailable')) + '</span>' +
    '</button>';
  }

  // Groups the picker into same-price / pricier / cheaper tiers relative to
  // the current rental's own plan price (owner's request) -- a lateral
  // (same-price) swap gets no tag, only a difference is worth flagging.
  // Falls back to the plain, untagged, unsorted list if the current game's
  // price can't be found (e.g. it's since been removed from the catalog)
  // rather than showing a comparison that might be wrong.
  function renderSwapGameList(query) {
    var list = document.getElementById('rcSwapGameList');
    if (!list) return;
    var r = swapState.rental;
    var all = swapState.games || [];
    var q = (query || '').trim().toLowerCase();
    var games = q ? all.filter(function (g) { return g.title.toLowerCase().indexOf(q) !== -1; }) : all;

    if (!games.length) {
      list.innerHTML = '<p class="rc-account-sub">No games match.</p>';
      return;
    }

    var fromPrice = swapState.fromPrice;
    var rows = games;
    if (fromPrice != null) {
      var same = [], pricier = [], cheaper = [];
      games.forEach(function (g) {
        var p = swapGamePrice(g, r.plan);
        if (p == null || p === fromPrice) same.push(g);
        else if (p > fromPrice) pricier.push(g);
        else cheaper.push(g);
      });
      pricier.sort(function (a, b) { return swapGamePrice(a, r.plan) - swapGamePrice(b, r.plan); });
      cheaper.sort(function (a, b) { return swapGamePrice(b, r.plan) - swapGamePrice(a, r.plan); });
      rows = same.concat(pricier, cheaper);
    }

    list.innerHTML = rows.map(function (g) {
      var tag = fromPrice != null ? swapPriceTag(swapGamePrice(g, r.plan), fromPrice) : '';
      return '' +
        '<div class="rc-swap-game-row">' +
          '<img class="rc-swap-game-cover" loading="lazy" src="' + esc(g.cover || '') + '" alt="">' +
          '<p class="rc-swap-game-title">' + esc(g.title) + tag + '</p>' +
          '<div class="rc-swap-game-slots">' + swapSlotBtn(g, 'trophy') + swapSlotBtn(g, 'nontrophy') + '</div>' +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(list.querySelectorAll('.rc-slot-option:not(.is-disabled)'), function (btn) {
      btn.addEventListener('click', function () {
        swapState.selected = {
          slug: btn.getAttribute('data-slug'),
          slot: btn.getAttribute('data-slot'),
          title: btn.getAttribute('data-title'),
          cover: btn.getAttribute('data-cover')
        };
        renderSwapConfirm();
      });
    });
  }

  function renderSwapPick() {
    var body = document.getElementById('rcSwapBody');
    var r = swapState.rental;
    body.innerHTML =
      '<h2 class="rc-modal-title">Swap Game</h2>' +
      '<p class="rc-modal-note" style="text-align:left;margin:0 0 1rem;">Swapping out <strong>' +
        esc(r.game_title) + '</strong> (' + slotName(r.slot) + '). Pick a new game and slot.</p>' +
      '<div class="rc-search" style="margin-bottom:1rem;">' +
        '<span class="rc-search-icon">' + icon('search') + '</span>' +
        '<input id="rcSwapSearch" type="text" placeholder="Search games...">' +
      '</div>' +
      '<div id="rcSwapGameList" class="rc-swap-game-list"><p class="rc-account-sub">Loading games...</p></div>';

    document.getElementById('rcSwapSearch').addEventListener('input', function (e) {
      renderSwapGameList(e.target.value);
    });

    loadSwapGames().then(function (games) {
      swapState.games = games;
      var fromGame = games.filter(function (g) { return g.slug === r.game_slug; })[0];
      swapState.fromPrice = fromGame ? swapGamePrice(fromGame, r.plan) : null;
      renderSwapGameList('');
    }, function (err) {
      console.warn('June Digitals: loading games for swap picker failed', err);
      var list = document.getElementById('rcSwapGameList');
      if (list) list.innerHTML = '<p class="rc-account-error">Couldn\'t load the game list. Please try again, or message us on Messenger.</p>';
    });
  }

  function renderSwapConfirm() {
    var body = document.getElementById('rcSwapBody');
    var r = swapState.rental, s = swapState.selected;
    body.innerHTML =
      '<h2 class="rc-modal-title">Confirm Swap</h2>' +
      '<p class="rc-modal-note" style="text-align:left;margin-bottom:0.5rem;">' +
        '<strong>' + esc(r.game_title) + '</strong> (' + slotName(r.slot) + ') &rarr; ' +
        '<strong>' + esc(s.title) + '</strong> (' + slotName(s.slot) + ')' +
      '</p>' +
      '<p class="rc-account-sub" style="margin:0 0 1.25rem;">This submits a swap request -- it isn\'t instant. Our admin reviews it and messages you once it\'s approved with the new account details.</p>' +
      '<button type="button" class="rc-modal-cta" id="rcSwapConfirmBtn">Confirm Swap</button>' +
      '<button type="button" class="rc-account-signout" id="rcSwapBackBtn" style="width:100%;margin-top:0.6rem;">Back</button>' +
      '<p class="rc-account-error" id="rcSwapConfirmError"></p>';

    document.getElementById('rcSwapBackBtn').addEventListener('click', renderSwapPick);
    document.getElementById('rcSwapConfirmBtn').addEventListener('click', submitSwap);
  }

  function mapSwapError(code) {
    switch (code) {
      case 'not_found': return "We couldn't find that rental.";
      case 'not_active': return "This rental isn't active, so it can't be swapped.";
      case 'too_close_to_end': return 'Your rental ends too soon to swap.';
      case 'swap_limit_reached': return "You've used all your swaps for this rental.";
      case 'slot_unavailable': return 'That slot just became unavailable. Pick another.';
      case 'same_game': return 'Pick a different game or slot than what you already have.';
      case 'already_pending': return 'You already have a swap request waiting for approval.';
      default: return 'Something went wrong with that swap request. Please try again or message us on Messenger.';
    }
  }

  function renderSwapUnavailable() {
    var body = document.getElementById('rcSwapBody');
    body.innerHTML =
      '<h2 class="rc-modal-title">Swap Requests Aren\'t Live Yet</h2>' +
      '<p class="rc-account-sub">This feature isn\'t set up on our end just yet. Message us on Messenger and we\'ll take care of the swap for you.</p>' +
      '<a href="' + SWAP_MESSENGER_URL + '" target="_blank" class="rc-guide-cta" style="display:block;text-align:center;">Message Us</a>' +
      '<button type="button" class="rc-account-signout" id="rcSwapDoneBtn" style="width:100%;margin-top:0.6rem;">Close</button>';
    document.getElementById('rcSwapDoneBtn').addEventListener('click', closeSwapModal);
  }

  // Per the swap-flow amendment: ok=true means SUBMITTED, not done. Never
  // claim the swap happened -- show a pending confirmation with the swap
  // reference code, and keep Messenger as a secondary "ask about this" link,
  // never as the way to submit.
  function renderSwapResult(row) {
    var body = document.getElementById('rcSwapBody');
    body.innerHTML =
      '<h2 class="rc-modal-title">Swap Requested</h2>' +
      '<p class="rc-account-notice" style="margin:0 0 1rem;">Reference code <strong>' + esc(row.swap_ref_code || '') + '</strong></p>' +
      '<p class="rc-modal-note" style="text-align:left;">' +
        '<strong>' + esc(row.from_game_title || '') + '</strong> &rarr; <strong>' + esc(row.to_game_title || '') + '</strong> (' + slotName(row.to_slot) + ')' +
      '</p>' +
      '<p class="rc-account-sub">Not done yet -- our admin will review this and message you the new account details once it\'s approved. Swaps left: ' +
        (row.swaps_left != null ? row.swaps_left : '—') + '.</p>' +
      '<a href="' + SWAP_MESSENGER_URL + '" target="_blank" class="rc-guide-cta" style="display:block;text-align:center;margin-bottom:0.6rem;">Message Us About This</a>' +
      '<button type="button" class="rc-account-signout" id="rcSwapDoneBtn" style="width:100%;">Close</button>';

    document.getElementById('rcSwapDoneBtn').addEventListener('click', function () {
      var onSwapped = swapState.opts && swapState.opts.onSwapped;
      closeSwapModal();
      if (onSwapped) onSwapped(row);
    });
  }

  function submitSwap() {
    var btn = document.getElementById('rcSwapConfirmBtn');
    var errEl = document.getElementById('rcSwapConfirmError');
    var r = swapState.rental, s = swapState.selected;
    var sb = getClient();
    if (!sb) { renderSwapUnavailable(); return; }

    btn.disabled = true;
    btn.textContent = 'Submitting...';
    errEl.textContent = '';

    sb.rpc('submit_swap_request', {
      p_code: r.ref_code,
      p_rental_id: r.rental_id,
      p_new_game_slug: s.slug,
      p_new_slot: s.slot
    }).then(function (res) {
      if (res.error) {
        console.warn('June Digitals: submit_swap_request unavailable (migration not applied yet?)', res.error);
        renderSwapUnavailable();
        return;
      }
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!row) { renderSwapUnavailable(); return; }
      if (!row.ok) {
        btn.disabled = false;
        btn.textContent = 'Confirm Swap';
        errEl.textContent = mapSwapError(row.error);
        return;
      }
      renderSwapResult(row);
    }, function (err) {
      console.warn('June Digitals: submit_swap_request call failed', err);
      renderSwapUnavailable();
    });
  }

  // Nav link ("Sign in" <-> "My Account"). Any element in the page tagged
  // data-rc-account-link gets its text/href updated once we know whether a
  // customer session exists. Fails silently (leaves the signed-out default
  // in place) if Supabase isn't reachable/configured -- a broken nav link
  // check should never break the rest of the page.
  function setLinkText(a, label) {
    // Desktop nav links are Webflow's hover-reveal pattern: two nested
    // ".text-sm" divs positioned/clipped by CSS, with the <a> itself never
    // meant to hold a bare text node. Overwriting a.textContent would wipe
    // that structure and silently render nothing visible. Update the inner
    // text nodes when present (desktop nav); fall back to plain textContent
    // for simple links that have none (the mobile drawer's <a>).
    var textEls = a.querySelectorAll('.text-sm');
    if (textEls.length) {
      Array.prototype.forEach.call(textEls, function (el) { el.textContent = label; });
    } else {
      a.textContent = label;
    }
  }

  // "Track rental" nav entry. A customer who rented without signing up has
  // a tracking code and nowhere to type it from the homepage -- "Sign in"
  // is the only account entry in the nav, and it doesn't apply to them.
  // Injected here rather than into 173 exported HTML files, all of which
  // already load this script. Idempotent, and skipped entirely for a
  // signed-in customer, whose account link already covers it.
  function injectTrackLink(session) {
    if (session) return;
    if (document.querySelector('[data-rc-track-link]')) return;

    var code = loadGuestCode();
    var label = code ? 'My Rentals' : 'Track Rental';
    var href = '/account/track.html';

    // Mobile drawer: plain <a>, simple text node.
    var drawer = document.querySelector('.rc-drawer-nav');
    if (drawer) {
      var d = document.createElement('a');
      d.setAttribute('href', href);
      d.setAttribute('data-rc-track-link', '');
      d.className = 'rc-drawer-link';
      d.textContent = label;
      drawer.appendChild(d);
    }

    // Desktop nav: Webflow's hover-reveal pattern needs the two nested
    // .text-sm divs, so clone an existing sibling link and retarget it
    // rather than hand-building markup that would drift from the export.
    var list = document.querySelector('.navbar_list');
    if (list) {
      var sibling = list.querySelector('a.link');
      if (sibling) {
        var a = sibling.cloneNode(true);
        a.removeAttribute('data-rc-account-link');
        a.removeAttribute('id');
        a.setAttribute('href', href);
        a.setAttribute('data-rc-track-link', '');
        a.classList.remove('is-current-page');
        setLinkText(a, label);
        var accountLink = list.querySelector('[data-rc-account-link]');
        if (accountLink) list.insertBefore(a, accountLink);
        else list.appendChild(a);
      }
    }
  }

  function wireNavLink() {
    var links = document.querySelectorAll('[data-rc-account-link]');
    var controls = document.querySelectorAll('[data-rc-account-control]');
    getSession().then(function (session) {
      try { injectTrackLink(session); } catch (e) { /* nav is cosmetic */ }
      if (!links.length && !controls.length) return;
      Array.prototype.forEach.call(links, function (a) {
        if (session) {
          setLinkText(a, 'My Account');
          a.setAttribute('href', '/account/');
        } else {
          setLinkText(a, 'Sign in');
          a.setAttribute('href', '/account/login.html');
        }
      });

      // Desktop nav profile control: "Sign in" when signed out, "My Account"
      // when signed in -- always a text label, never just an avatar.
      // Structure is ours (not Webflow markup), so no textContent trap here.
      Array.prototype.forEach.call(controls, function (a) {
        var label = a.querySelector('.rc-account-label');
        if (session) {
          a.classList.add('is-signed-in');
          a.setAttribute('href', '/account/');
          a.setAttribute('aria-label', 'My Account');
          if (label) label.textContent = 'My Account';
        } else {
          a.classList.remove('is-signed-in');
          a.setAttribute('href', '/account/login.html');
          a.setAttribute('aria-label', 'Sign in');
          if (label) label.textContent = 'Sign in';
        }
      });
    });
  }

  window.RCAccount = {
    getClient: getClient,
    getSession: getSession,
    requireAuth: requireAuth,
    ensureRenter: ensureRenter,
    updateMyProfile: updateMyProfile,
    signOut: signOut,
    saveGuestCode: saveGuestCode,
    loadGuestCode: loadGuestCode,
    clearGuestCode: clearGuestCode,
    normalizeTrackingCode: normalizeTrackingCode,
    peso: peso,
    fmtDate: fmtDate,
    daysLeft: daysLeft,
    daysLeftLabel: daysLeftLabel,
    daysLeftBig: daysLeftBig,
    slotName: slotName,
    planName: planName,
    statusInfo: statusInfo,
    paymentInfo: paymentInfo,
    icon: icon,
    esc: esc,
    swapChain: swapChain,
    openSwapModal: openSwapModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireNavLink);
  } else {
    wireNavLink();
  }
})();
