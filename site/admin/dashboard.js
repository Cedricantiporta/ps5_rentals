(function () {
  'use strict';

  var supabase = window.rcSupabase;
  var state = { games: [], renters: [], rentals: [] };

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
      supabase.from('rentals').select('*, games(id,title,slug), renters(id,name)').order('end_date')
    ]).then(function (results) {
      state.games = (results[0].data || []);
      state.renters = (results[1].data || []);
      state.rentals = (results[2].data || []);
      renderRentals();
      renderRenters();
      renderGames();
      populateRenterSelect();
      populateGameOptions();
    });
  }

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
      if (r.status === 'pending') {
        actions += '<button class="a-btn a-btn-green" data-action="activate" data-id="' + r.id + '">Confirm Payment &amp; Activate</button>';
        actions += '<button class="a-btn" data-action="cancel" data-id="' + r.id + '">Cancel</button>';
      } else if (r.status === 'active') {
        actions += '<button class="a-btn a-btn-red" data-action="end" data-id="' + r.id + '">End Rental</button>';
      }
      tr.innerHTML =
        '<td>' + esc(game.title) + '</td>' +
        '<td>' + esc(renter.name) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + ' (₱' + r.amount + ')</td>' +
        '<td>' + statusPill(r.status) + '</td>' +
        '<td>' + paymentPill(r.payment_status) + '</td>' +
        '<td>' + fmtDate(r.start_date) + '</td>' +
        '<td>' + fmtDate(r.end_date) + '</td>' +
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
    var ensureRenter = renterSel === '__new'
      ? supabase.from('renters').insert({
          name: $('newRenterName').value.trim(),
          messenger_name: $('newRenterMessenger').value.trim() || null,
          contact_note: $('newRenterNote').value.trim() || null
        }).select().single().then(function (res) { return res; })
      : Promise.resolve({ data: { id: Number(renterSel) }, error: null });

    ensureRenter.then(function (res) {
      if (res.error) { $('newRentalError').textContent = res.error.message; return; }
      if (renterSel === '__new' && !$('newRenterName').value.trim()) {
        $('newRentalError').textContent = 'Renter name is required.'; return;
      }
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
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(r.name) + '</td><td>' + esc(r.messenger_name) + '</td>' +
        '<td>' + esc(r.contact_note) + '</td><td>' + fmtDate((r.created_at || '').slice(0, 10)) + '</td>';
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
