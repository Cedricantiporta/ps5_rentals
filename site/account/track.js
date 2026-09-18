// Guest tracking-code portal (track.html). No account, no password --
// customer types (or auto-carries) a renters.public_code ("JD-XXXXXX") or a
// rentals.ref_code ("R-XXXXXX") and sees their rentals + swap chain, per
// RENT-FLOW-CONTRACT.md's lookup_rentals_by_code / submit_swap_request RPCs.
//
// Behaves like an auto-login (owner's spec): the code is remembered in
// localStorage under RCAccount's shared 'rc-track-code' key -- the exact
// same key site/assets/catalog.js writes the instant a rent request
// succeeds, so a customer who just rented lands here already tracked, no
// prompt. ES5-ish (var, .then chains) to match the rest of this codebase.
//
// FAIL SOFT: none of the RPCs this file calls exist in the database yet
// (a parallel agent is writing that SQL). Every call checks res.error and
// falls back to a friendly "message us on Messenger" state instead of a
// stack trace or blank page.
(function () {
  'use strict';

  if (!window.RCAccount) return;

  var MESSENGER_URL = 'https://m.me/junedigitalaccess';
  // RENT-FLOW-CONTRACT.md: "swap_count < SWAP_LIMIT (2)". The RPC enforces
  // this server-side; this is only used to show "swaps left" on a card.
  var SWAP_LIMIT = 2;

  var els = {
    header: document.getElementById('rcTrackHeader'),
    codeLabel: document.getElementById('rcTrackCodeLabel'),
    forgetBtn: document.getElementById('rcForgetBtn'),
    entryState: document.getElementById('rcEntryState'),
    entryForm: document.getElementById('rcEntryForm'),
    entryInput: document.getElementById('rcEntryCode'),
    entryErr: document.getElementById('rcEntryError'),
    loading: document.getElementById('rcLoading'),
    failState: document.getElementById('rcFailState'),
    rentalsWrap: document.getElementById('rcRentalsWrap'),
    grid: document.getElementById('rcGuestGrid')
  };

  var currentCode = '';
  var currentRentals = [];
  var gamesCache = null;
  var swapState = { rental: null, selected: null, games: null };

  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }

  function showState(name) {
    show(els.entryState, name === 'entry');
    show(els.loading, name === 'loading');
    show(els.failState, name === 'fail');
    show(els.rentalsWrap, name === 'rentals');
    show(els.header, name === 'loading' || name === 'rentals' || name === 'fail');
  }

  // ---- lookup ----

  // knownGood: true when the code came from storage/a previous successful
  // lookup (auto-login, or a post-swap refresh) -- an empty result then
  // gets the neutral "no longer works" phrasing from the owner's spec.
  // false for a code the customer just typed, which gets the original
  // "couldn't find that code" phrasing. Either way we never say whether
  // the *format* was valid -- both messages read identically for a
  // malformed code and a well-formed-but-unknown one.
  function doLookup(code, knownGood) {
    showState('loading');
    if (els.codeLabel) els.codeLabel.textContent = code;
    // Save immediately, not only on confirmed success: a manually-typed
    // code should stick around (so it can be moved to a second device just
    // by typing it once there, per spec) even while the lookup is still in
    // flight or the RPC isn't deployed yet -- we only ever clear it once
    // the backend actually confirms the code is dead (the empty-result
    // branch below).
    RCAccount.saveGuestCode(code);
    var sb = RCAccount.getClient();
    if (!sb) { showState('fail'); return; }

    sb.rpc('lookup_rentals_by_code', { p_code: code }).then(function (res) {
      if (res.error) {
        console.warn('June Digitals: lookup_rentals_by_code unavailable (migration not applied yet?)', res.error);
        showState('fail');
        return;
      }
      var rows = res.data || [];
      if (!rows.length) {
        RCAccount.clearGuestCode();
        currentCode = '';
        currentRentals = [];
        els.entryInput.value = code;
        els.entryErr.textContent = knownGood
          ? 'That code no longer works. Double-check it, or message us on Messenger if you lost it.'
          : "We couldn't find that code. It's on your rent confirmation message, and also on Messenger if you lost it.";
        showState('entry');
        return;
      }

      currentCode = code;
      currentRentals = rows;
      if (els.codeLabel) els.codeLabel.textContent = code;
      renderRentals(rows);
      showState('rentals');
    }, function (err) {
      console.warn('June Digitals: lookup_rentals_by_code call failed', err);
      showState('fail');
    });
  }

  // ---- rendering ----

  function daysLeftLabel(r) {
    var n = r.days_left;
    if (n === null || n === undefined) return '';
    if (n < 0) return 'Ended ' + Math.abs(n) + 'd ago';
    if (n === 0) return 'Ends today';
    return n + 'd left';
  }

  function renderGuestCard(r) {
    var status = RCAccount.statusInfo(r.status);
    var payment = RCAccount.paymentInfo(r.payment_status);
    var swapsLeft = Math.max(0, SWAP_LIMIT - (r.swap_count || 0));
    var daysLine = daysLeftLabel(r);

    var swapBlock;
    if (r.pending_swap_id) {
      swapBlock = '<div class="rc-swap-pending">' + RCAccount.icon('clock') + ' Swap pending &rarr; ' +
        RCAccount.esc(r.pending_swap_to_title || 'new game') + '</div>';
    } else if (r.can_swap) {
      swapBlock = '<button type="button" class="rc-rental-swap-btn" data-rental-id="' + RCAccount.esc(r.rental_id) + '">' +
        RCAccount.icon('refresh-cw') + ' Swap Game</button>';
    } else {
      swapBlock = '<button type="button" class="rc-rental-swap-btn" disabled>' + RCAccount.icon('refresh-cw') + ' Swap Game</button>' +
        '<p class="rc-rental-swap-reason">' + RCAccount.esc(r.swap_blocked_reason || "Swapping isn't available for this rental.") + '</p>';
    }

    return '' +
      '<div class="rc-rental-card">' +
        '<img class="rc-rental-cover" loading="lazy" src="' + RCAccount.esc(r.game_cover || '') + '" alt="' + RCAccount.esc(r.game_title || '') + '">' +
        '<div class="rc-rental-body">' +
          '<p class="rc-rental-title">' + RCAccount.esc(r.game_title || 'Unknown game') + '</p>' +
          '<div class="rc-rental-tags">' +
            '<span class="rc-rental-tag">' + RCAccount.icon(r.slot === 'trophy' ? 'trophy' : 'user') + ' ' + RCAccount.slotName(r.slot) + '</span>' +
            '<span class="rc-rental-tag">' + RCAccount.planName(r.plan) + '</span>' +
            '<span class="rc-rental-pill ' + status.cls + '">' + status.label + '</span>' +
            '<span class="rc-rental-pill ' + payment.cls + '">' + payment.label + '</span>' +
          '</div>' +
          '<div class="rc-rental-dates">' +
            '<strong>' + RCAccount.fmtDate(r.start_date) + '</strong> &ndash; <strong>' + RCAccount.fmtDate(r.end_date) + '</strong>' +
            (r.status === 'active' && daysLine ? ' &middot; ' + daysLine : '') +
          '</div>' +
          '<div class="rc-rental-meta">Ref code <strong>' + RCAccount.esc(r.ref_code || '') + '</strong> &middot; Swaps left ' + swapsLeft + '</div>' +
          swapBlock +
        '</div>' +
      '</div>';
  }

  function renderRentals(rows) {
    els.grid.innerHTML = rows.map(renderGuestCard).join('');
  }

  els.grid.addEventListener('click', function (e) {
    var btn = e.target.closest('.rc-rental-swap-btn');
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-rental-id');
    var rental = currentRentals.filter(function (r) { return String(r.rental_id) === String(id); })[0];
    if (rental) openSwapModal(rental);
  });

  // ---- swap games list (copied from assets/catalog.js's loadGames(), not
  // imported -- this file only owns site/account/. Keeps the same
  // client-side is_test filter so the picker matches the live catalog;
  // during manual testing, feed fake game rows straight into swapState.games
  // instead of relying on this filter, so zz-test-game-a/b aren't hidden. ----

  function loadSwapGames() {
    if (gamesCache) return Promise.resolve(gamesCache);
    var sb = RCAccount.getClient();
    if (!sb) return Promise.reject(new Error('no supabase client'));
    return sb.from('games').select('*').then(function (res) {
      if (res.error) throw res.error;
      gamesCache = res.data.filter(function (row) { return row.is_test !== true; }).map(function (row) {
        return {
          slug: row.slug, title: row.title, cover: row.cover,
          trophy_available: row.trophy_available, nontrophy_available: row.nontrophy_available
        };
      });
      return gamesCache;
    });
  }

  // ---- swap modal ----

  function ensureSwapModal() {
    if (document.getElementById('rcSwapOverlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'rc-modal-overlay';
    overlay.id = 'rcSwapOverlay';
    overlay.innerHTML =
      '<div class="rc-modal" id="rcSwapModal">' +
        '<button type="button" class="rc-modal-close" id="rcSwapCloseX" aria-label="Close">' + RCAccount.icon('x') + '</button>' +
        '<div class="rc-modal-body" id="rcSwapBody"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSwapModal(); });
    document.getElementById('rcSwapCloseX').addEventListener('click', closeSwapModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeSwapModal();
    });
  }

  function openSwapModal(rental) {
    ensureSwapModal();
    swapState.rental = rental;
    swapState.selected = null;
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
      ' data-slug="' + RCAccount.esc(g.slug) + '" data-slot="' + slotKey + '"' +
      ' data-title="' + RCAccount.esc(g.title) + '" data-cover="' + RCAccount.esc(g.cover || '') + '">' +
      '<div class="rc-slot-option-top"><span class="rc-slot-option-name">' + RCAccount.slotName(slotKey) + '</span></div>' +
      '<span class="rc-slot-option-price">' + (isCurrent ? 'Current' : (available ? 'Available' : 'Unavailable')) + '</span>' +
    '</button>';
  }

  function renderSwapGameList(query) {
    var list = document.getElementById('rcSwapGameList');
    if (!list) return;
    var games = swapState.games || [];
    var q = (query || '').trim().toLowerCase();
    if (q) games = games.filter(function (g) { return g.title.toLowerCase().indexOf(q) !== -1; });

    if (!games.length) {
      list.innerHTML = '<p class="rc-account-sub">No games match.</p>';
      return;
    }

    list.innerHTML = games.map(function (g) {
      return '' +
        '<div class="rc-swap-game-row">' +
          '<img class="rc-swap-game-cover" loading="lazy" src="' + RCAccount.esc(g.cover || '') + '" alt="">' +
          '<p class="rc-swap-game-title">' + RCAccount.esc(g.title) + '</p>' +
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
        RCAccount.esc(r.game_title) + '</strong> (' + RCAccount.slotName(r.slot) + '). Pick a new game and slot.</p>' +
      '<div class="rc-search" style="margin-bottom:1rem;">' +
        '<span class="rc-search-icon">' + RCAccount.icon('search') + '</span>' +
        '<input id="rcSwapSearch" type="text" placeholder="Search games...">' +
      '</div>' +
      '<div id="rcSwapGameList" class="rc-swap-game-list"><p class="rc-account-sub">Loading games...</p></div>';

    document.getElementById('rcSwapSearch').addEventListener('input', function (e) {
      renderSwapGameList(e.target.value);
    });

    loadSwapGames().then(function (games) {
      swapState.games = games;
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
        '<strong>' + RCAccount.esc(r.game_title) + '</strong> (' + RCAccount.slotName(r.slot) + ') &rarr; ' +
        '<strong>' + RCAccount.esc(s.title) + '</strong> (' + RCAccount.slotName(s.slot) + ')' +
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
      '<a href="' + MESSENGER_URL + '" target="_blank" class="rc-guide-cta" style="display:block;text-align:center;">Message Us</a>' +
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
      '<p class="rc-account-notice" style="margin:0 0 1rem;">Reference code <strong>' + RCAccount.esc(row.swap_ref_code || '') + '</strong></p>' +
      '<p class="rc-modal-note" style="text-align:left;">' +
        '<strong>' + RCAccount.esc(row.from_game_title || '') + '</strong> &rarr; <strong>' + RCAccount.esc(row.to_game_title || '') + '</strong> (' + RCAccount.slotName(row.to_slot) + ')' +
      '</p>' +
      '<p class="rc-account-sub">Not done yet -- our admin will review this and message you the new account details once it\'s approved. Swaps left: ' +
        (row.swaps_left != null ? row.swaps_left : '—') + '.</p>' +
      '<a href="' + MESSENGER_URL + '" target="_blank" class="rc-guide-cta" style="display:block;text-align:center;margin-bottom:0.6rem;">Message Us About This</a>' +
      '<button type="button" class="rc-account-signout" id="rcSwapDoneBtn" style="width:100%;">Close</button>';

    document.getElementById('rcSwapDoneBtn').addEventListener('click', function () {
      closeSwapModal();
      if (currentCode) doLookup(currentCode, true);
    });
  }

  function submitSwap() {
    var btn = document.getElementById('rcSwapConfirmBtn');
    var errEl = document.getElementById('rcSwapConfirmError');
    var r = swapState.rental, s = swapState.selected;
    var sb = RCAccount.getClient();
    if (!sb) { renderSwapUnavailable(); return; }

    btn.disabled = true;
    btn.textContent = 'Submitting...';
    errEl.textContent = '';

    sb.rpc('submit_swap_request', {
      p_code: currentCode,
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

  // ---- entry form / forget / init ----

  els.entryForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = RCAccount.normalizeTrackingCode(els.entryInput.value);
    if (!code) {
      els.entryErr.textContent = 'Enter the tracking code from your rent confirmation.';
      return;
    }
    els.entryErr.textContent = '';
    doLookup(code, false);
  });

  if (els.forgetBtn) {
    els.forgetBtn.addEventListener('click', function () {
      RCAccount.clearGuestCode();
      currentCode = '';
      currentRentals = [];
      els.entryInput.value = '';
      els.entryErr.textContent = '';
      showState('entry');
    });
  }

  function init() {
    RCAccount.getSession().then(function (session) {
      if (session) { window.location.href = '/account/'; return; }

      var code = '';
      try {
        var params = new URLSearchParams(window.location.search);
        code = params.get('code') || '';
      } catch (e) {}
      if (!code) code = RCAccount.loadGuestCode();
      code = RCAccount.normalizeTrackingCode(code);

      if (code) {
        doLookup(code, true);
      } else {
        showState('entry');
      }
    });
  }

  init();
})();
