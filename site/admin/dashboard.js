(function () {
  'use strict';

  var supabase = window.rcSupabase;
  var state = { games: [], renters: [], rentals: [], requests: [], swapFromRental: null, amountManuallyEdited: false, rentalsFilter: 'all' };

  function $(id) { return document.getElementById(id); }
  var MESSENGER_ICON = '<svg class="a-msg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Has a Messenger link"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  function messengerIcon(url) { return url ? MESSENGER_ICON : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function addDaysISO(iso, days) {
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var yy = String(d.getFullYear()).slice(-2);
    return mm + '/' + dd + '/' + yy;
  }
  function daysLeft(endIso) {
    var end = new Date(endIso + 'T00:00:00');
    var today = new Date(todayISO() + 'T00:00:00');
    return Math.round((end - today) / 86400000);
  }
  function timeLeftLabel(endIso) {
    var n = daysLeft(endIso);
    return n < 0 ? '-' + Math.abs(n) : String(n);
  }

  // ---- action dropdown menus (3-dot button -> popup list) ----
  function actionsMenu(itemsHtml) {
    if (!itemsHtml) return '';
    return '<div class="a-menu"><button type="button" class="a-menu-btn" aria-label="Actions">⋮</button>' +
      '<div class="a-menu-list" hidden>' + itemsHtml + '</div></div>';
  }
  function closeAllMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('.a-menu-list'), function (list) { list.hidden = true; });
  }
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('.a-menu-btn');
    if (!toggle) { closeAllMenus(); return; }
    var list = toggle.parentElement.querySelector('.a-menu-list');
    var wasHidden = list.hidden;
    closeAllMenus();
    if (wasHidden) {
      var rect = toggle.getBoundingClientRect();
      list.hidden = false;
      var menuWidth = list.offsetWidth || 190;
      var left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
      list.style.left = Math.max(8, left) + 'px';
      list.style.top = Math.min(rect.bottom + 4, window.innerHeight - list.offsetHeight - 8) + 'px';
    }
    e.stopPropagation();
  });
  // Any click inside a menu (running an action, or an Open Messenger link)
  // closes the menu -- action buttons re-render the table anyway, but the
  // plain link doesn't trigger a re-render so needs this explicitly.
  document.addEventListener('click', function (e) {
    if (e.target.closest('.a-menu-item')) closeAllMenus();
  }, true);

  // ---- tabs ----
  Array.prototype.forEach.call(document.querySelectorAll('.a-tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.a-tab'), function (t) { t.classList.remove('is-active'); });
      Array.prototype.forEach.call(document.querySelectorAll('.a-panel'), function (p) { p.classList.remove('is-active'); });
      tab.classList.add('is-active');
      $('panel-' + tab.getAttribute('data-tab')).classList.add('is-active');
    });
  });

  $('signOutBtn').addEventListener('click', function () { window.rcSignOut(); });

  // ---- data loading ----
  function loadAll() {
    return Promise.all([
      supabase.from('games').select('*').order('title'),
      supabase.from('renters').select('*').order('name'),
      supabase.from('rentals').select('*, games(id,title,slug), renters(id,name)').order('end_date'),
      supabase.from('rental_requests').select('*').eq('handled', false).order('created_at', { ascending: false })
    ]).then(function (results) {
      state.games = (results[0].data || []);
      state.renters = (results[1].data || []);
      state.rentals = (results[2].data || []);
      state.requests = (results[3].data || []);
      renderRentals();
      renderRenters();
      renderGames();
      renderRequests();
      renderOverview();
      populateRenterSelect();
      populateGameOptions();
      updateSlotHintAndAmount();
    });
  }

  // ---- overview tab ----
  function renderOverview() {
    var paid = 0, pending = 0, pendingCount = 0, activeCount = 0, endingSoon = [];
    state.rentals.forEach(function (r) {
      // A rental ended by a swap isn't a separate payment -- its successor
      // rental carries the same paid period forward, so only count the
      // latest link in a swap chain to avoid double-counting revenue.
      if (r.payment_status === 'paid' && (r.status === 'active' || r.status === 'ended') && !wasSwapped(r.id)) paid += r.amount || 0;
      if (r.status === 'pending') { pending += r.amount || 0; pendingCount++; }
      if (r.status === 'active') {
        activeCount++;
        var left = daysLeft(r.end_date);
        if (left <= 2) endingSoon.push(r);
      }
    });
    endingSoon.sort(function (a, b) { return daysLeft(a.end_date) - daysLeft(b.end_date); });

    $('statRevenuePaid').textContent = '₱' + paid.toLocaleString();
    $('statRevenuePending').textContent = '₱' + pending.toLocaleString();
    $('statPendingCount').textContent = pendingCount + ' pending rental' + (pendingCount === 1 ? '' : 's');
    $('statActiveCount').textContent = activeCount;
    $('statEndingSoon').textContent = endingSoon.length + ' ending in 2 days';
    $('statRenterCount').textContent = state.renters.length;
    $('statRequestCount').textContent = state.requests.length + ' new request' + (state.requests.length === 1 ? '' : 's');

    var tbody = document.querySelector('#endingSoonTable tbody');
    tbody.innerHTML = '';
    $('endingSoonEmpty').hidden = endingSoon.length > 0;
    endingSoon.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc((r.games || {}).title) + '</td><td>' + esc((r.renters || {}).name) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td><td>' + timeLeftLabel(r.end_date) + '</td>';
      tbody.appendChild(tr);
    });
  }

  // ---- incoming requests tab ----
  function renderRequests() {
    var tbody = document.querySelector('#requestsTable tbody');
    tbody.innerHTML = '';
    $('requestsEmpty').hidden = state.requests.length > 0;
    var badge = $('requestsBadge');
    badge.textContent = state.requests.length ? '(' + state.requests.length + ')' : '';
    state.requests.forEach(function (req) {
      var tr = document.createElement('tr');
      var when = new Date(req.created_at);
      tr.innerHTML =
        '<td>' + esc(req.game_title) + '</td>' +
        '<td>' + (req.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + esc(req.plan || '—') + '</td>' +
        '<td>' + (req.amount != null ? '₱' + req.amount : '—') + '</td>' +
        '<td>' + when.toLocaleString() + '</td>' +
        '<td class="a-actions-cell">' + actionsMenu(
          '<button type="button" class="a-menu-item" data-action="use" data-id="' + req.id + '">Use this</button>' +
          '<button type="button" class="a-menu-item" data-action="dismiss" data-id="' + req.id + '">Dismiss</button>'
        ) + '</td>';
      tbody.appendChild(tr);
    });
  }

  document.querySelector('#requestsTable tbody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-id'));
    var req = state.requests.filter(function (r) { return r.id === id; })[0];
    if (!req) return;
    if (btn.getAttribute('data-action') === 'dismiss') {
      supabase.from('rental_requests').update({ handled: true }).eq('id', id).then(loadAll);
      return;
    }
    // "Use this": jump to New Rental with game/slot/plan pre-filled.
    var match = state.games.filter(function (g) { return g.slug === req.game_slug; })[0];
    if (match) {
      $('gameSearch').value = match.title;
      $('gameSelect').value = match.id;
    }
    $('slotSelect').value = req.slot;
    if (req.plan) $('planSelect').value = req.plan;
    updateSlotHintAndAmount();
    supabase.from('rental_requests').update({ handled: true }).eq('id', id).then(function () {
      state.requests = state.requests.filter(function (r) { return r.id !== id; });
      renderRequests();
    });
    document.querySelector('.a-tab[data-tab="new-rental"]').click();
  });

  // ---- rentals tab ----
  function statusPill(status) {
    var map = { pending: 'a-pill-pending', active: 'a-pill-active', ended: 'a-pill-ended', cancelled: 'a-pill-cancelled' };
    return '<span class="a-pill ' + (map[status] || 'a-pill-ended') + '">' + esc(status) + '</span>';
  }
  function wasSwapped(rentalId) {
    return state.rentals.some(function (x) { return x.swapped_from_rental_id === rentalId; });
  }
  // 24h cooldown since this rental began (whether by activation or a
  // previous swap) before it can be swapped again -- stops same-day
  // back-to-back swapping.
  function swapCooldownHoursLeft(rental) {
    var hoursSince = (Date.now() - new Date(rental.created_at).getTime()) / 3600000;
    return Math.max(0, Math.ceil(24 - hoursSince));
  }
  function paymentPill(p) {
    return '<span class="a-pill ' + (p === 'paid' ? 'a-pill-paid' : 'a-pill-pending') + '">' + esc(p) + '</span>';
  }

  function rentalsMatchFilter(r) {
    if (state.rentalsFilter === 'active') return r.status === 'active';
    if (state.rentalsFilter === 'pending') return r.status === 'pending';
    if (state.rentalsFilter === 'history') return r.status === 'ended' || r.status === 'cancelled';
    return true;
  }
  document.querySelectorAll('#rentalsFilterRow .a-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('#rentalsFilterRow .a-chip').forEach(function (c) { c.classList.remove('is-active'); });
      chip.classList.add('is-active');
      state.rentalsFilter = chip.getAttribute('data-filter');
      renderRentals();
    });
  });

  function renderRentals() {
    var tbody = document.querySelector('#rentalsTable tbody');
    tbody.innerHTML = '';
    var rows = state.rentals.filter(rentalsMatchFilter);
    $('rentalsEmpty').hidden = rows.length > 0;
    $('rentalsEmpty').textContent = state.rentals.length ? 'No rentals match this filter.' : 'No rentals yet.';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var game = r.games || {};
      var renter = r.renters || {};
      var renterObj = state.renters.filter(function (x) { return x.id === r.renter_id; })[0];
      var actions = '';
      var timeLeftCell = '—';
      if (r.status === 'pending') {
        if (r.queue_position != null) timeLeftCell = 'Queue #' + r.queue_position;
        actions += '<button type="button" class="a-menu-item" data-action="activate" data-id="' + r.id + '">Confirm Payment &amp; Activate</button>';
        actions += '<button type="button" class="a-menu-item" data-action="cancel" data-id="' + r.id + '">Cancel</button>';
      } else if (r.status === 'active') {
        var left = daysLeft(r.end_date);
        timeLeftCell = timeLeftLabel(r.end_date);
        if (left > 0) {
          // Timer hasn't run out -- ending requires an explicit override
          // (confirm dialog) instead of a plain one-click button, so it
          // can't happen by accident.
          actions += '<button type="button" class="a-menu-item" data-action="end-override" data-id="' + r.id + '">Override: End Early</button>';
        } else {
          actions += '<button type="button" class="a-menu-item a-menu-item-danger" data-action="end" data-id="' + r.id + '">End Rental</button>';
        }
        var cooldownHours = swapCooldownHoursLeft(r);
        if (cooldownHours > 0) {
          actions += '<button type="button" class="a-menu-item" disabled title="This rental started less than 24h ago">Swap in ' + cooldownHours + 'h</button>';
        } else {
          actions += '<button type="button" class="a-menu-item" data-action="swap" data-id="' + r.id + '">Swap Game</button>';
        }
        if (renterObj && renterObj.messenger_url) {
          actions += '<a class="a-menu-item" href="' + esc(renterObj.messenger_url) + '" target="_blank" rel="noopener">Open Messenger</a>';
        }
      }
      tr.innerHTML =
        '<td>' + esc(game.title) + '</td>' +
        '<td>' + esc(renter.name) + ' ' + messengerIcon(renterObj && renterObj.messenger_url) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + ' (₱<span data-amount-display>' + r.amount + '</span>' +
          ' <button type="button" class="a-edit-amount" data-action="edit-amount" data-id="' + r.id + '" title="Edit amount">✎</button>)</td>' +
        '<td>' + (r.status === 'ended' && wasSwapped(r.id) ? '<span class="a-pill a-pill-swap">SWAPPED</span>' : statusPill(r.status)) + '</td>' +
        '<td>' + paymentPill(r.payment_status) + '</td>' +
        '<td>' + fmtDate(r.start_date) + '</td>' +
        '<td>' + fmtDate(r.end_date) + '</td>' +
        '<td>' + timeLeftCell + '</td>' +
        '<td class="a-actions-cell">' + actionsMenu(actions) + '</td>';
      tbody.appendChild(tr);
    });
  }

  document.querySelector('#rentalsTable tbody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-id'));
    var rental = state.rentals.filter(function (r) { return r.id === id; })[0];
    if (!rental) return;
    var action = btn.getAttribute('data-action');
    if (action === 'activate') {
      if (rental.queue_position != null && rental.queue_position > 1) {
        var ahead = pendingQueue(rental.game_id, rental.slot).filter(function (r) { return r.queue_position < rental.queue_position; });
        if (ahead.length) {
          var aheadNames = ahead.map(function (r) {
            var ren = state.renters.filter(function (x) { return x.id === r.renter_id; })[0];
            return '#' + r.queue_position + ' (' + (ren ? ren.name : 'unknown') + ')';
          }).join(', ');
          var ok = window.confirm(
            'This renter is #' + rental.queue_position + ' in the queue for this slot -- ' + aheadNames +
            ' is still ahead of them and hasn\'t been activated or cancelled yet. Activate this one anyway?'
          );
          if (!ok) return;
        }
      }
      activateRental(rental);
    }
    else if (action === 'cancel') setRentalStatus(rental, 'cancelled', false);
    else if (action === 'end') setRentalStatus(rental, 'ended', true);
    else if (action === 'end-override') {
      var left = daysLeft(rental.end_date);
      var ok = window.confirm(
        'This rental still has ' + left + ' day' + (left === 1 ? '' : 's') + ' remaining. End it early anyway?'
      );
      if (ok) setRentalStatus(rental, 'ended', true);
    } else if (action === 'edit-amount') {
      var input = window.prompt('Amount actually paid (₱) for this rental:', rental.amount);
      if (input === null) return;
      var newAmount = Number(input);
      if (!(newAmount >= 0)) { alert('Enter a valid non-negative number.'); return; }
      supabase.from('rentals').update({ amount: newAmount }).eq('id', id).then(function (res) {
        if (res.error) { alert(res.error.message); return; }
        loadAll();
      });
    } else if (action === 'swap') {
      startSwap(rental);
    }
  });

  function activateRental(rental) {
    var start = todayISO();
    var end = addDaysISO(start, rental.plan === 'weekly' ? 7 : 30);
    supabase.from('rentals').update({
      status: 'active', payment_status: 'paid', start_date: start, end_date: end
    }).eq('id', rental.id).then(function (res) {
      if (res.error) { alert(res.error.message); return; }
      // Slot frees up the day after the rental's end date -- shown on the
      // public site as a "Xd left" countdown instead of a flat FULL.
      return setGameSlotAvailable(rental.game_id, rental.slot, false, addDaysISO(end, 1)).then(function (res2) {
        if (res2.error) { alert(res2.error.message); return; }
        return resolveQueueSlot(rental).then(loadAll);
      });
    });
  }

  function setRentalStatus(rental, status, freeSlot) {
    supabase.from('rentals').update({ status: status }).eq('id', rental.id).then(function (res) {
      if (res.error) { alert(res.error.message); return; }
      if (freeSlot) return setGameSlotAvailable(rental.game_id, rental.slot, true).then(function (res2) {
        if (res2.error) { alert(res2.error.message); return; }
        return resolveQueueSlot(rental).then(loadAll);
      });
      return resolveQueueSlot(rental).then(loadAll);
    });
  }

  function setGameSlotAvailable(gameId, slot, available, availableAt) {
    var patch = {};
    patch[slot + '_available'] = available;
    patch[slot + '_available_at'] = available ? null : (availableAt || null);
    return supabase.from('games').update(patch).eq('id', gameId);
  }

  // ---- pre-reserve queue (multiple people can want the same upcoming
  // game's slot before it's released -- only one gets it, the rest hold a
  // place in line) ----
  function pendingQueue(gameId, slot) {
    return state.rentals
      .filter(function (r) { return r.game_id === gameId && r.slot === slot && r.status === 'pending' && r.queue_position != null; })
      .sort(function (a, b) { return a.queue_position - b.queue_position; });
  }
  function nextQueuePosition(gameId, slot) {
    var q = pendingQueue(gameId, slot);
    return q.length ? q[q.length - 1].queue_position + 1 : 1;
  }
  // Reservation status reflects the real queue depth (OPEN/LIMITED/
  // PRIORITY_LIST) unless the admin has manually CLOSED it -- that
  // override always wins until they reopen it themselves.
  function syncReservationStatus(gameId, slot) {
    var game = state.games.filter(function (g) { return g.id === gameId; })[0];
    if (!game || game.status !== 'upcoming') return Promise.resolve();
    var current = game[slot + '_reservation_status'];
    if (current === 'CLOSED') return Promise.resolve();
    var count = pendingQueue(gameId, slot).length;
    var next = count === 0 ? 'OPEN' : (count === 1 ? 'LIMITED' : 'PRIORITY_LIST');
    if (next === current) return Promise.resolve();
    var patch = {};
    patch[slot + '_reservation_status'] = next;
    return supabase.from('games').update(patch).eq('id', gameId);
  }
  // Called after a queued reservation leaves the queue (activated,
  // cancelled, or ended) -- closes the gap so remaining places stay 1,2,3...
  function resolveQueueSlot(rental) {
    if (rental.queue_position == null) return Promise.resolve();
    var behind = state.rentals.filter(function (r) {
      return r.game_id === rental.game_id && r.slot === rental.slot && r.status === 'pending' &&
        r.queue_position != null && r.queue_position > rental.queue_position;
    });
    return Promise.all(behind.map(function (r) {
      return supabase.from('rentals').update({ queue_position: r.queue_position - 1 }).eq('id', r.id);
    })).then(function () { return syncReservationStatus(rental.game_id, rental.slot); });
  }

  // ---- new rental tab ----
  function populateRenterSelect() {
    var sel = $('renterSelect');
    var current = sel.value;
    sel.innerHTML = '<option value="__new">+ New renter</option>' +
      state.renters.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + '</option>'; }).join('');
    sel.value = current || '__new';
    toggleNewRenterFields();
  }
  $('renterSelect').addEventListener('change', toggleNewRenterFields);
  function toggleNewRenterFields() {
    var isNew = $('renterSelect').value === '__new';
    $('newRenterNameField').style.display = isNew ? '' : 'none';
    $('newRenterExtraRow').style.display = isNew ? '' : 'none';
  }

  function populateGameOptions() {
    var dl = $('gameList');
    var sel = $('gameSelect');
    var current = sel.value;
    dl.innerHTML = state.games.map(function (g) { return '<option value="' + esc(g.title) + '">'; }).join('');
    sel.innerHTML = state.games.map(function (g) { return '<option value="' + g.id + '">' + esc(g.title) + '</option>'; }).join('');
    sel.value = current;
  }
  $('gameSearch').addEventListener('input', function () {
    var title = this.value;
    var match = state.games.filter(function (g) { return g.title === title; })[0];
    if (match) { $('gameSelect').value = match.id; state.amountManuallyEdited = false; updateSlotHintAndAmount(); }
  });
  $('slotSelect').addEventListener('change', function () { state.amountManuallyEdited = false; updateSlotHintAndAmount(); });
  $('planSelect').addEventListener('change', function () { state.amountManuallyEdited = false; updateSlotHintAndAmount(); });
  $('amountInput').addEventListener('input', function () { state.amountManuallyEdited = true; });

  function selectedGame() {
    var id = Number($('gameSelect').value);
    return state.games.filter(function (g) { return g.id === id; })[0];
  }

  function updateSlotHintAndAmount() {
    var g = selectedGame();
    var hint = $('slotHint');
    if (!g) { hint.textContent = ''; return; }
    var slot = $('slotSelect').value;
    var plan = $('planSelect').value;
    var price = g[slot + '_' + plan];
    if (!state.amountManuallyEdited) $('amountInput').value = price || 0;
    if (g.status === 'upcoming') {
      var position = nextQueuePosition(g.id, slot);
      hint.textContent = 'Not released yet -- this will be reservation #' + position + ' for the ' +
        (slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + ' slot. Price on file: ₱' + (price || 0) + '.';
      return;
    }
    var available = g[slot + '_available'];
    hint.textContent = (available ? 'Slot currently open.' : 'Heads up: this slot is currently marked FULL.') +
      ' Price on file: ₱' + (price || 0) + '.';
  }

  // ---- swap game (ends the old rental, starts a new one on the same
  // renter/end-date so the remaining paid time carries over) ----
  function startSwap(rental) {
    var cooldownHours = swapCooldownHoursLeft(rental);
    if (cooldownHours > 0) {
      alert('This rental started less than 24 hours ago. Swap available in ' + cooldownHours + ' more hour' + (cooldownHours === 1 ? '' : 's') + '.');
      return;
    }
    var renter = state.renters.filter(function (r) { return r.id === rental.renter_id; })[0];
    var game = state.games.filter(function (g) { return g.id === rental.game_id; })[0];
    state.swapFromRental = rental;
    populateRenterSelect();
    $('renterSelect').value = String(rental.renter_id);
    $('renterSelect').disabled = true;
    toggleNewRenterFields();
    $('gameSearch').value = '';
    $('gameSelect').value = '';
    $('slotSelect').value = 'trophy';
    $('planSelect').value = rental.plan;
    $('amountInput').value = '';
    state.amountManuallyEdited = false;
    $('rentalNotes').value = '';
    $('slotHint').textContent = '';
    $('newRentalError').textContent = '';
    $('swapBanner').hidden = false;
    $('swapBannerText').textContent = 'Swapping ' + (renter ? renter.name : 'this renter') + '’s rental of "' +
      (game ? game.title : 'this game') + '" — pick the new game below. Ends the old rental, frees its slot, ' +
      'and keeps the same end date (' + fmtDate(rental.end_date) + ').';
    $('newRentalHeading').textContent = 'Swap game';
    $('createRentalBtn').textContent = 'Swap to this game';
    document.querySelector('.a-tab[data-tab="new-rental"]').click();
  }

  function cancelSwap() {
    state.swapFromRental = null;
    $('swapBanner').hidden = true;
    $('renterSelect').disabled = false;
    $('newRentalHeading').textContent = 'New rental';
    $('createRentalBtn').textContent = 'Create rental (pending payment)';
    $('newRentalForm').reset();
    state.amountManuallyEdited = false;
    toggleNewRenterFields();
  }
  $('cancelSwapBtn').addEventListener('click', cancelSwap);

  function doSwap(newGame) {
    var oldRental = state.swapFromRental;
    var slot = $('slotSelect').value;
    var plan = $('planSelect').value;
    var amount = Number($('amountInput').value) || 0;
    var notes = $('rentalNotes').value.trim() || null;
    var endDate = oldRental.end_date;
    var btn = $('createRentalBtn');
    btn.disabled = true;

    supabase.from('rentals').update({ status: 'ended' }).eq('id', oldRental.id)
      .then(function (res) { if (res.error) throw res.error; return setGameSlotAvailable(oldRental.game_id, oldRental.slot, true); })
      .then(function (res) {
        if (res && res.error) throw res.error;
        return supabase.from('rentals').insert({
          game_id: newGame.id, renter_id: oldRental.renter_id, slot: slot, plan: plan,
          amount: amount, status: 'active', payment_status: 'paid',
          start_date: todayISO(), end_date: endDate, notes: notes,
          swapped_from_rental_id: oldRental.id
        });
      })
      .then(function (res) { if (res.error) throw res.error; return setGameSlotAvailable(newGame.id, slot, false, addDaysISO(endDate, 1)); })
      .then(function (res) { if (res && res.error) throw res.error; cancelSwap(); loadAll(); })
      .catch(function (err) { $('newRentalError').textContent = (err && err.message) || 'Swap failed.'; })
      .then(function () { btn.disabled = false; });
  }

  $('newRentalForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('newRentalError').textContent = '';
    var g = selectedGame();
    if (!g) { $('newRentalError').textContent = 'Pick a game first.'; return; }

    if (state.swapFromRental) { doSwap(g); return; }

    var renterSel = $('renterSelect').value;
    if (renterSel === '__new' && !$('newRenterName').value.trim()) {
      $('newRentalError').textContent = 'Renter name is required.'; return;
    }
    var ensureRenter = renterSel === '__new'
      ? supabase.from('renters').insert({
          name: $('newRenterName').value.trim(),
          messenger_name: $('newRenterMessenger').value.trim() || null,
          contact_note: $('newRenterNote').value.trim() || null
        }).select().single()
      : Promise.resolve({ data: { id: Number(renterSel) }, error: null });

    ensureRenter.then(function (res) {
      if (res.error) { $('newRentalError').textContent = res.error.message; return; }
      var renterId = res.data.id;
      var slot = $('slotSelect').value;
      var plan = $('planSelect').value;
      var start = todayISO();
      var end = addDaysISO(start, plan === 'weekly' ? 7 : 30);
      var isReservation = g.status === 'upcoming';
      return supabase.from('rentals').insert({
        game_id: g.id, renter_id: renterId, slot: slot, plan: plan,
        amount: Number($('amountInput').value) || 0, status: 'pending', payment_status: 'pending',
        start_date: start, end_date: end, notes: $('rentalNotes').value.trim() || null,
        queue_position: isReservation ? nextQueuePosition(g.id, slot) : null
      }).then(function (res2) {
        if (res2.error) { $('newRentalError').textContent = res2.error.message; return; }
        $('newRentalForm').reset();
        state.amountManuallyEdited = false;
        if (isReservation) return syncReservationStatus(g.id, slot).then(loadAll);
        loadAll();
      });
    });
  });

  // ---- renters tab ----
  function renderRenters() {
    var tbody = document.querySelector('#rentersTable tbody');
    tbody.innerHTML = '';
    $('rentersEmpty').hidden = state.renters.length > 0;
    state.renters.forEach(function (r) {
      var theirRentals = state.rentals.filter(function (x) { return x.renter_id === r.id; });
      var totalPaid = theirRentals.reduce(function (sum, x) { return sum + (x.payment_status === 'paid' && !wasSwapped(x.id) ? (x.amount || 0) : 0); }, 0);
      var activeNow = theirRentals.filter(function (x) { return x.status === 'active'; }).length;
      var tr = document.createElement('tr');
      var menuItems = '';
      if (r.messenger_url) menuItems += '<a class="a-menu-item" href="' + esc(r.messenger_url) + '" target="_blank" rel="noopener">Open Messenger</a>';
      menuItems += '<button type="button" class="a-menu-item" data-action="edit-messenger-link" data-id="' + r.id + '">' +
        (r.messenger_url ? 'Edit Messenger link' : 'Add Messenger link') + '</button>';
      tr.innerHTML = '<td>' + esc(r.name) + ' ' + messengerIcon(r.messenger_url) + '</td><td>' + esc(r.messenger_name) + '</td>' +
        '<td>' + esc(r.contact_note) + '</td><td>' + fmtDate((r.created_at || '').slice(0, 10)) + '</td>' +
        '<td>₱' + totalPaid.toLocaleString() + '</td>' +
        '<td>' + theirRentals.length + '</td>' +
        '<td>' + (activeNow ? '<span class="a-pill a-pill-active">' + activeNow + '</span>' : '—') + '</td>' +
        '<td class="a-actions-cell">' + actionsMenu(menuItems) + '</td>';
      tbody.appendChild(tr);
    });
  }

  document.querySelector('#rentersTable tbody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action="edit-messenger-link"]');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-id'));
    var renter = state.renters.filter(function (r) { return r.id === id; })[0];
    if (!renter) return;
    var input = window.prompt(
      'Messenger conversation link for ' + renter.name + ' (paste the URL from your address bar while viewing their thread in Messenger/Business Suite):',
      renter.messenger_url || 'https://www.facebook.com/messages/t/'
    );
    if (input === null) return;
    supabase.from('renters').update({ messenger_url: input.trim() || null }).eq('id', id).then(function (res) {
      if (res.error) { alert(res.error.message); return; }
      loadAll();
    });
  });

  $('addRenterForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('addRenterError').textContent = '';
    var name = $('renterNameInput').value.trim();
    if (!name) { $('addRenterError').textContent = 'Name is required.'; return; }
    supabase.from('renters').insert({
      name: name, messenger_name: $('renterMsgInput').value.trim() || null, contact_note: $('renterNoteInput').value.trim() || null,
      messenger_url: $('renterMsgLinkInput').value.trim() || null
    }).then(function (res) {
      if (res.error) { $('addRenterError').textContent = res.error.message; return; }
      $('addRenterForm').reset();
      loadAll();
    });
  });

  // ---- games tab ----
  function slotControlHtml(g, slot) {
    if (g.status === 'upcoming') {
      var val = g[slot + '_reservation_status'];
      var opts = ['OPEN', 'LIMITED', 'PRIORITY_LIST', 'CLOSED'];
      return '<select data-game="' + g.id + '" data-slot="' + slot + '" data-field="reservation">' +
        opts.map(function (o) { return '<option value="' + o + '"' + (o === val ? ' selected' : '') + '>' + o.replace('_', ' ') + '</option>'; }).join('') +
        '</select>';
    }
    var avail = g[slot + '_available'];
    return '<select data-game="' + g.id + '" data-slot="' + slot + '" data-field="available">' +
      '<option value="true"' + (avail ? ' selected' : '') + '>AVAILABLE</option>' +
      '<option value="false"' + (!avail ? ' selected' : '') + '>FULL</option>' +
      '</select>';
  }

  function renderGames() {
    var tbody = document.querySelector('#gamesTable tbody');
    var q = ($('gamesSearch') && $('gamesSearch').value || '').trim().toLowerCase();
    var games = q ? state.games.filter(function (g) { return g.title.toLowerCase().indexOf(q) !== -1; }) : state.games;
    tbody.innerHTML = '';
    games.forEach(function (g) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(g.title) + '</td><td>' + (g.status === 'upcoming' ? 'Pre-Reserve' : 'Available') + '</td>' +
        '<td>' + slotControlHtml(g, 'trophy') + '</td>' +
        '<td>' + slotControlHtml(g, 'nontrophy') + '</td>';
      tbody.appendChild(tr);
    });
  }
  if ($('gamesSearch')) $('gamesSearch').addEventListener('input', renderGames);

  document.querySelector('#gamesTable tbody').addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-game]');
    if (!sel) return;
    var gameId = Number(sel.getAttribute('data-game'));
    var slot = sel.getAttribute('data-slot');
    var field = sel.getAttribute('data-field');
    var patch = {};
    if (field === 'available') {
      patch[slot + '_available'] = sel.value === 'true';
      if (sel.value === 'true') patch[slot + '_available_at'] = null;
    } else patch[slot + '_reservation_status'] = sel.value;
    supabase.from('games').update(patch).eq('id', gameId).then(function (res) {
      if (res.error) alert(res.error.message);
      loadAll();
    });
  });

  // ---- add game ----
  function slugify(s) {
    return String(s).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  if ($('gStatus')) {
    $('gStatus').addEventListener('change', function () {
      $('gReservationRow').hidden = $('gStatus').value !== 'upcoming';
    });
  }

  function uploadCover(file, slug) {
    var ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    var path = slug + '-' + Date.now() + '.' + ext;
    return supabase.storage.from('game-covers').upload(path, file, { upsert: true }).then(function (res) {
      if (res.error) throw res.error;
      return supabase.storage.from('game-covers').getPublicUrl(path).data.publicUrl;
    });
  }

  if ($('addGameForm')) {
    $('addGameForm').addEventListener('submit', function (e) {
      e.preventDefault();
      $('addGameError').textContent = '';
      var title = $('gTitle').value.trim();
      if (!title) { $('addGameError').textContent = 'Title is required.'; return; }
      var slug = slugify($('gSlug').value.trim() || title);
      var status = $('gStatus').value;
      var genre = $('gGenre').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var file = $('gCover').files[0];
      var btn = $('addGameBtn');
      btn.disabled = true;

      Promise.resolve(file ? uploadCover(file, slug) : null).then(function (coverUrl) {
        return supabase.from('games').insert({
          slug: slug, title: title, genre: genre, platform: $('gPlatform').value.trim() || 'PS5',
          cover: coverUrl || null, release_date: $('gReleaseDate').value || null, status: status,
          upcoming_order: Number($('gUpcomingOrder').value) || 99999,
          trophy_available: $('gTrophyAvailable').value === 'true',
          trophy_weekly: Number($('gTrophyWeekly').value) || null,
          trophy_monthly: Number($('gTrophyMonthly').value) || null,
          trophy_reservation_status: $('gTrophyReservation').value,
          nontrophy_available: $('gNontrophyAvailable').value === 'true',
          nontrophy_weekly: Number($('gNontrophyWeekly').value) || null,
          nontrophy_monthly: Number($('gNontrophyMonthly').value) || null,
          nontrophy_reservation_status: $('gNontrophyReservation').value
        });
      }).then(function (res) {
        if (res.error) throw res.error;
        $('addGameForm').reset();
        $('gReservationRow').hidden = true;
        loadAll();
      }).catch(function (err) {
        $('addGameError').textContent = err.message || 'Failed to add game.';
      }).then(function () { btn.disabled = false; });
    });
  }

  // ---- boot ----
  window.rcRequireAuth().then(function (session) {
    if (!session) return;
    $('whoami').textContent = session.user.email;
    $('userAvatar').textContent = session.user.email.charAt(0).toUpperCase();
    loadAll();
    // Incoming requests (and everything else) come from customers using the
    // public site in real time -- poll instead of requiring a manual refresh
    // to notice a new one.
    setInterval(loadAll, 20000);
  });
})();
