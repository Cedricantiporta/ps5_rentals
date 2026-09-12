(function () {
  'use strict';

  var supabase = window.rcSupabase;
  var state = { games: [], renters: [], rentals: [], requests: [] };

  function $(id) { return document.getElementById(id); }
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
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function daysLeft(endIso) {
    var end = new Date(endIso + 'T00:00:00');
    var today = new Date(todayISO() + 'T00:00:00');
    return Math.round((end - today) / 86400000);
  }
  function timeLeftLabel(endIso) {
    var n = daysLeft(endIso);
    if (n > 1) return n + ' days left';
    if (n === 1) return '1 day left';
    if (n === 0) return 'Ends today';
    return 'Overdue ' + Math.abs(n) + 'd';
  }

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
      if (r.payment_status === 'paid' && (r.status === 'active' || r.status === 'ended')) paid += r.amount || 0;
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
        '<td class="a-actions-cell">' +
          '<button class="a-btn a-btn-primary" data-action="use" data-id="' + req.id + '">Use this</button>' +
          '<button class="a-btn" data-action="dismiss" data-id="' + req.id + '">Dismiss</button>' +
        '</td>';
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
  function paymentPill(p) {
    return '<span class="a-pill ' + (p === 'paid' ? 'a-pill-paid' : 'a-pill-pending') + '">' + esc(p) + '</span>';
  }

  function renderRentals() {
    var tbody = document.querySelector('#rentalsTable tbody');
    tbody.innerHTML = '';
    $('rentalsEmpty').hidden = state.rentals.length > 0;
    state.rentals.forEach(function (r) {
      var tr = document.createElement('tr');
      var game = r.games || {};
      var renter = r.renters || {};
      var actions = '';
      var timeLeftCell = '—';
      if (r.status === 'pending') {
        actions += '<button class="a-btn a-btn-green" data-action="activate" data-id="' + r.id + '">Confirm Payment &amp; Activate</button>';
        actions += '<button class="a-btn" data-action="cancel" data-id="' + r.id + '">Cancel</button>';
      } else if (r.status === 'active') {
        var left = daysLeft(r.end_date);
        timeLeftCell = timeLeftLabel(r.end_date);
        if (left > 0) {
          // Timer hasn't run out -- ending requires an explicit override
          // (confirm dialog) instead of a plain one-click button, so it
          // can't happen by accident.
          actions += '<button class="a-btn" data-action="end-override" data-id="' + r.id + '">Override: End Early</button>';
        } else {
          actions += '<button class="a-btn a-btn-red" data-action="end" data-id="' + r.id + '">End Rental</button>';
        }
      }
      tr.innerHTML =
        '<td>' + esc(game.title) + '</td>' +
        '<td>' + esc(renter.name) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + ' (₱<span data-amount-display>' + r.amount + '</span>' +
          ' <button type="button" class="a-edit-amount" data-action="edit-amount" data-id="' + r.id + '" title="Edit amount">✎</button>)</td>' +
        '<td>' + statusPill(r.status) + '</td>' +
        '<td>' + paymentPill(r.payment_status) + '</td>' +
        '<td>' + fmtDate(r.start_date) + '</td>' +
        '<td>' + fmtDate(r.end_date) + '</td>' +
        '<td>' + timeLeftCell + '</td>' +
        '<td class="a-actions-cell">' + actions + '</td>';
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
    if (action === 'activate') activateRental(rental);
    else if (action === 'cancel') setRentalStatus(rental, 'cancelled', false);
    else if (action === 'end') setRentalStatus(rental, 'ended', true);
    else if (action === 'end-override') {
      var left = daysLeft(rental.end_date);
      var ok = window.confirm(
        'This rental still has ' + timeLeftLabel(rental.end_date).toLowerCase() +
        ' (' + left + ' day' + (left === 1 ? '' : 's') + ' remaining). End it early anyway?'
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
    }
  });

  function activateRental(rental) {
    var start = todayISO();
    var end = addDaysISO(start, rental.plan === 'weekly' ? 7 : 30);
    supabase.from('rentals').update({
      status: 'active', payment_status: 'paid', start_date: start, end_date: end
    }).eq('id', rental.id).then(function (res) {
      if (res.error) { alert(res.error.message); return; }
      return setGameSlotAvailable(rental.game_id, rental.slot, false).then(loadAll);
    });
  }

  function setRentalStatus(rental, status, freeSlot) {
    supabase.from('rentals').update({ status: status }).eq('id', rental.id).then(function (res) {
      if (res.error) { alert(res.error.message); return; }
      if (freeSlot) return setGameSlotAvailable(rental.game_id, rental.slot, true).then(loadAll);
      return loadAll();
    });
  }

  function setGameSlotAvailable(gameId, slot, available) {
    var patch = {};
    patch[slot + '_available'] = available;
    return supabase.from('games').update(patch).eq('id', gameId);
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
    dl.innerHTML = state.games.map(function (g) { return '<option value="' + esc(g.title) + '">'; }).join('');
    sel.innerHTML = state.games.map(function (g) { return '<option value="' + g.id + '">' + esc(g.title) + '</option>'; }).join('');
  }
  $('gameSearch').addEventListener('input', function () {
    var title = this.value;
    var match = state.games.filter(function (g) { return g.title === title; })[0];
    if (match) { $('gameSelect').value = match.id; updateSlotHintAndAmount(); }
  });
  $('slotSelect').addEventListener('change', updateSlotHintAndAmount);
  $('planSelect').addEventListener('change', updateSlotHintAndAmount);

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
    var available = g[slot + '_available'];
    var price = g[slot + '_' + plan];
    $('amountInput').value = price || 0;
    hint.textContent = (available ? 'Slot currently open.' : 'Heads up: this slot is currently marked FULL.') +
      ' Price on file: ₱' + (price || 0) + '.';
  }

  $('newRentalForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('newRentalError').textContent = '';
    var g = selectedGame();
    if (!g) { $('newRentalError').textContent = 'Pick a game first.'; return; }

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
      var plan = $('planSelect').value;
      var start = todayISO();
      var end = addDaysISO(start, plan === 'weekly' ? 7 : 30);
      return supabase.from('rentals').insert({
        game_id: g.id, renter_id: renterId, slot: $('slotSelect').value, plan: plan,
        amount: Number($('amountInput').value) || 0, status: 'pending', payment_status: 'pending',
        start_date: start, end_date: end, notes: $('rentalNotes').value.trim() || null
      }).then(function (res2) {
        if (res2.error) { $('newRentalError').textContent = res2.error.message; return; }
        $('newRentalForm').reset();
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
      var totalPaid = theirRentals.reduce(function (sum, x) { return sum + (x.payment_status === 'paid' ? (x.amount || 0) : 0); }, 0);
      var activeNow = theirRentals.filter(function (x) { return x.status === 'active'; }).length;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(r.name) + '</td><td>' + esc(r.messenger_name) + '</td>' +
        '<td>' + esc(r.contact_note) + '</td><td>' + fmtDate((r.created_at || '').slice(0, 10)) + '</td>' +
        '<td>₱' + totalPaid.toLocaleString() + '</td>' +
        '<td>' + theirRentals.length + '</td>' +
        '<td>' + (activeNow ? '<span class="a-pill a-pill-active">' + activeNow + '</span>' : '—') + '</td>';
      tbody.appendChild(tr);
    });
  }

  $('addRenterForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('addRenterError').textContent = '';
    var name = $('renterNameInput').value.trim();
    if (!name) { $('addRenterError').textContent = 'Name is required.'; return; }
    supabase.from('renters').insert({
      name: name, messenger_name: $('renterMsgInput').value.trim() || null, contact_note: $('renterNoteInput').value.trim() || null
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
    tbody.innerHTML = '';
    state.games.forEach(function (g) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(g.title) + '</td><td>' + (g.status === 'upcoming' ? 'Pre-Reserve' : 'Available') + '</td>' +
        '<td>' + slotControlHtml(g, 'trophy') + '</td>' +
        '<td>' + slotControlHtml(g, 'nontrophy') + '</td>';
      tbody.appendChild(tr);
    });
  }

  document.querySelector('#gamesTable tbody').addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-game]');
    if (!sel) return;
    var gameId = Number(sel.getAttribute('data-game'));
    var slot = sel.getAttribute('data-slot');
    var field = sel.getAttribute('data-field');
    var patch = {};
    if (field === 'available') patch[slot + '_available'] = sel.value === 'true';
    else patch[slot + '_reservation_status'] = sel.value;
    supabase.from('games').update(patch).eq('id', gameId).then(function (res) {
      if (res.error) alert(res.error.message);
      loadAll();
    });
  });

  // ---- boot ----
  window.rcRequireAuth().then(function (session) {
    if (!session) return;
    $('whoami').textContent = session.user.email;
    loadAll();
  });
})();
