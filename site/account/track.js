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
    activeGrid: document.getElementById('rcGuestActiveGrid'),
    activeEmpty: document.getElementById('rcGuestActiveEmpty'),
    historyGrid: document.getElementById('rcGuestHistoryGrid'),
    historyEmpty: document.getElementById('rcGuestHistoryEmpty')
  };

  var currentCode = '';
  var currentRentals = [];

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

  // Active Rentals: a tall, portrait "card" -- big cover art with a large
  // focal days-left badge overlaid on it, matching the signed-in portal's
  // card style (see RCAccount.daysLeftBig / index.html).
  function renderGuestCard(r) {
    var status = RCAccount.statusInfo(r.status);
    var payment = RCAccount.paymentInfo(r.payment_status);
    var swapsLeft = Math.max(0, SWAP_LIMIT - (r.swap_count || 0));

    var big = r.days_left !== null && r.days_left !== undefined ? RCAccount.daysLeftBig(r.days_left) : null;
    var daysBadge = big ?
      '<p class="rc-rental-days-plain ' + big.cls + '">' +
        '<span class="rc-rental-days-num">' + RCAccount.esc(big.num) + '</span> ' +
        '<span class="rc-rental-days-label">' + RCAccount.esc(big.label) + '</span>' +
      '</p>' : '';

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
      '<div class="rc-rental-card" data-game-slug="' + RCAccount.esc(r.game_slug || '') + '">' +
        '<div class="rc-rental-cover-wrap">' +
          '<img class="rc-rental-cover" loading="lazy" src="' + RCAccount.esc(r.game_cover || '') + '" alt="' + RCAccount.esc(r.game_title || '') + '">' +
        '</div>' +
        daysBadge +
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
          '</div>' +
          '<div class="rc-rental-meta">Ref code <strong>' + RCAccount.esc(r.ref_code || '') + '</strong> &middot; Swaps left ' + swapsLeft + '</div>' +
          swapBlock +
        '</div>' +
      '</div>';
  }

  // History: deliberately NOT the big card style -- a compact "receipt
  // list" row (tiny cover, essentials only, no swap controls) so a past
  // rental never reads as prominent/urgent the way an Active one does.
  function renderGuestHistoryRow(r) {
    var status = RCAccount.statusInfo(r.status);
    var payment = RCAccount.paymentInfo(r.payment_status);

    return '' +
      '<div class="rc-rental-history-row" data-game-slug="' + RCAccount.esc(r.game_slug || '') + '">' +
        '<img class="rc-rental-history-cover" loading="lazy" src="' + RCAccount.esc(r.game_cover || '') + '" alt="">' +
        '<div class="rc-rental-history-info">' +
          '<p class="rc-rental-history-title">' + RCAccount.esc(r.game_title || 'Unknown game') + '</p>' +
          '<div class="rc-rental-history-meta">' +
            '<span>' + RCAccount.fmtDate(r.start_date) + ' &ndash; ' + RCAccount.fmtDate(r.end_date) + '</span>' +
            '<span class="rc-rental-pill ' + status.cls + '">' + status.label + '</span>' +
            '<span class="rc-rental-pill ' + payment.cls + '">' + payment.label + '</span>' +
            '<span>Ref <strong>' + RCAccount.esc(r.ref_code || '') + '</strong></span>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renderRentals(rows) {
    var activeRows = rows.filter(function (r) { return r.status === 'active' || r.status === 'pending'; });
    var historyRows = rows.filter(function (r) { return r.status === 'ended' || r.status === 'cancelled'; });
    els.activeGrid.innerHTML = activeRows.map(renderGuestCard).join('');
    els.historyGrid.innerHTML = historyRows.map(renderGuestHistoryRow).join('');
    show(els.activeEmpty, activeRows.length === 0);
    show(els.historyEmpty, historyRows.length === 0);
  }

  // Single delegated click handler shared by both grids: a dedicated
  // The card itself is not clickable (an active rental isn't something to
  // "rent again" by tapping it, and it was confusing customers into landing
  // on the New Rental/Swap intent screen for a game they already have) --
  // only the "Swap Game" button does anything.
  function handleRentalGridClick(e) {
    var btn = e.target.closest('.rc-rental-swap-btn');
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-rental-id');
    var rental = currentRentals.filter(function (r) { return String(r.rental_id) === String(id); })[0];
    // rental_id/ref_code/game_slug/game_title/slot/plan are exactly the
    // fields RCAccount.openSwapModal's shared implementation needs, and
    // lookup_rentals_by_code already returns them under those same names --
    // no adapting required here (see shared.js's swap-modal comment for why
    // index.html, whose rental rows look different, needs a small mapper).
    if (rental) {
      RCAccount.openSwapModal(rental, {
        onSwapped: function () { if (currentCode) doLookup(currentCode, true); }
      });
    }
  }
  els.activeGrid.addEventListener('click', handleRentalGridClick);
  els.historyGrid.addEventListener('click', handleRentalGridClick);

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
