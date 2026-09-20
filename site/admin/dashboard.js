(function () {
  'use strict';

  var supabase = window.rcSupabase;
  var state = {
    games: [], renters: [], rentals: [], swapFromRental: null,
    amountManuallyEdited: false, rentalsSearch: '', historySearch: '',
    rentersFilter: 'all', mergeRemoveId: null,
    // Per-table click-to-sort state -- keyed by table id, e.g.
    // { rentalsTable: { key: 'end_date', dir: 'asc' } }. Not persisted
    // across reloads (see wireTableSort()/sortRows() near the bottom).
    tableSort: {},
    // Self-serve rent flow additions (RENT-FLOW-CONTRACT.md / CONTRACT-AMENDMENT-1.md).
    // settings/swapRequests may not exist in the live DB yet -- see the
    // *Available flags, checked before rendering their panels so a missing
    // table degrades to a "run this migration" hint instead of an error.
    settings: {}, settingsAvailable: true,
    swapRequests: [], swapRequestsAvailable: true
  };

  function $(id) { return document.getElementById(id); }

  // ---- generic modal system (replaces every native alert()/confirm()/
  // prompt() with a styled modal that matches the rest of the app, instead
  // of the browser's own native dialog box). Built fresh here rather than
  // tied to any one #panel-*, since it's used from all over the dashboard --
  // markup is injected into <body> once, on first use, and reused after
  // that. Same visual language as the existing .a-modal-backdrop /
  // .a-modal-card pattern (see admin.css), just a smaller generic card. ----
  var gm = { resolve: null, mode: null };
  function ensureGenericModalDom() {
    if ($('genericModalBackdrop')) return;
    var host = document.createElement('div');
    host.innerHTML =
      '<div class="a-modal-backdrop" id="genericModalBackdrop" hidden></div>' +
      '<div class="a-card a-modal-card a-generic-modal" id="genericModal" hidden>' +
        '<p class="a-generic-modal-msg" id="genericModalMsg"></p>' +
        '<div class="a-field" id="genericModalInputWrap" style="display:none;"><input type="text" id="genericModalInput"></div>' +
        '<div class="a-generic-modal-actions">' +
          '<button type="button" class="a-btn" id="genericModalCancelBtn">Cancel</button>' +
          '<button type="button" class="a-btn a-btn-primary" id="genericModalOkBtn">OK</button>' +
        '</div>' +
      '</div>';
    while (host.firstChild) document.body.appendChild(host.firstChild);

    $('genericModalBackdrop').addEventListener('click', function () { finishGenericModal(false); });
    $('genericModalCancelBtn').addEventListener('click', function () { finishGenericModal(false); });
    $('genericModalOkBtn').addEventListener('click', function () { finishGenericModal(true); });
    $('genericModalInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finishGenericModal(true); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('genericModal').hidden) finishGenericModal(false);
    });
  }
  function finishGenericModal(accepted) {
    if (!gm.resolve) return; // nothing open (or already resolved) -- ignore
    var mode = gm.mode;
    var resolve = gm.resolve;
    gm.resolve = null;
    gm.mode = null;
    $('genericModalBackdrop').hidden = true;
    $('genericModal').hidden = true;
    if (mode === 'alert') { resolve(true); return; }
    if (mode === 'confirm') { resolve(!!accepted); return; }
    // mode === 'prompt': mirror native prompt()'s null-on-cancel contract.
    resolve(accepted ? $('genericModalInput').value : null);
  }
  function openGenericModal(mode, message, opts) {
    ensureGenericModalDom();
    opts = opts || {};
    gm.mode = mode;
    var msgEl = $('genericModalMsg');
    msgEl.textContent = message; // .a-generic-modal-msg has white-space:pre-line, so \n still breaks lines
    var inputWrap = $('genericModalInputWrap');
    var input = $('genericModalInput');
    var cancelBtn = $('genericModalCancelBtn');
    var okBtn = $('genericModalOkBtn');
    okBtn.className = 'a-btn ' + (opts.danger ? 'a-btn-red' : 'a-btn-primary');
    okBtn.textContent = opts.okLabel || (mode === 'alert' ? 'OK' : 'Confirm');
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    cancelBtn.hidden = mode === 'alert';
    // .a-field sets display:flex unconditionally, which beats the [hidden]
    // attribute's UA display:none at equal specificity -- toggle inline
    // style instead (same reason the rest of the app uses style.display for
    // .a-field visibility, e.g. toggleNewRenterFields, rather than .hidden).
    if (mode === 'prompt') {
      inputWrap.style.display = '';
      input.type = opts.inputType || 'text';
      input.value = opts.defaultValue != null ? opts.defaultValue : '';
      input.placeholder = opts.placeholder || '';
    } else {
      inputWrap.style.display = 'none';
    }
    $('genericModalBackdrop').hidden = false;
    $('genericModal').hidden = false;
    // Focus the input (prompt) or the primary action (alert/confirm) --
    // not a full focus trap, but Tab still cycles between Cancel/OK/input
    // since they're the only focusable elements in the modal.
    setTimeout(function () {
      if (mode === 'prompt') { input.focus(); input.select(); } else { okBtn.focus(); }
    }, 0);
    return new Promise(function (resolve) { gm.resolve = resolve; });
  }
  // showAlert(message, opts) -- one message, one OK button.
  function showAlert(message, opts) { return openGenericModal('alert', message, opts); }
  // showConfirm(message, opts) -- Cancel/Confirm (or opts.okLabel, e.g.
  // "Decline"), opts.danger for a destructive action's red confirm button.
  // Returns a Promise<boolean>.
  function showConfirm(message, opts) { return openGenericModal('confirm', message, opts); }
  // showPrompt(message, opts) -- Cancel/OK plus a text input. opts.defaultValue,
  // opts.placeholder, opts.inputType. Resolves with the string entered, or
  // null on cancel (matches native prompt()'s contract exactly).
  function showPrompt(message, opts) { return openGenericModal('prompt', message, opts); }

  var MESSENGER_ICON = '<svg class="a-msg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Has a Messenger link"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  function messengerIcon(url) { return url ? MESSENGER_ICON : ''; }
  // Inline "copied" icon for icon-only copy buttons (no external icon
  // library -- same house style as MESSENGER_ICON above: lucide-style 24x24
  // viewBox, currentColor stroke). COPY_ICON (the un-copied state) was
  // removed along with the last icon-only copy button that used it --
  // publicCodeCell()'s tracking-code button is a plain text .a-refcode-btn
  // now, styled/animated the same way the ref-code copy buttons always were.
  var CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';
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

  // ---- topbar (section title + live-refresh indicator) ----
  // help is the fuller explanation, shown via the "?" badge's native title
  // tooltip next to the topbar title -- moved off the panel body (where it
  // used to sit as a permanent <p class="a-hint">) so the panel itself
  // starts with actual data instead of a paragraph of instructions every
  // time. pending's is built dynamically in renderPending() below (it
  // needs the live hold_minutes setting), not listed here.
  var TAB_META = {
    pending: { title: 'Pending Payments', help: 'Customer already picked a game on the public site and got a GCash reference on the payment screen -- their slot is already held. Match the ref code below to their Messenger screenshot, then click Confirm Paid. Nothing else to fill in.' },
    swaps: { title: 'Swap Requests', help: "Customer self-served a swap on the public site -- the new slot is already held for them. Approve to finish the swap (send the new game's credentials on Messenger right after), or decline to release the hold." },
    overview: { title: 'Overview', help: 'Snapshot of revenue, active rentals, and renters.' },
    rentals: { title: 'Rentals', help: 'Only currently active rentals show here. For rentals awaiting payment or activation, see Reservations (or Pending Payments); for ended/cancelled rentals, see History.' },
    reservations: { title: 'Reservations', help: 'Pre-reserve queue for upcoming games -- multiple renters can be queued for the same slot before it releases. Only the front of the queue (#1) can be activated once paid.' },
    history: { title: 'History', help: 'Past rentals -- ended or cancelled.' },
    renters: { title: 'Renters', help: 'Renter profiles, Messenger links, and lifetime spend.' },
    games: { title: 'Games', help: 'Changing these here updates the public site immediately -- use this only for manual overrides outside the normal rental flow.' },
    settings: { title: 'Settings', help: 'GCash details, Messenger link, hold time, and swap limit shown to customers.' }
  };
  function setTopbarSection(tabKey) {
    var meta = TAB_META[tabKey];
    if (!meta) return;
    $('topbarTitle').textContent = meta.title;
    $('topbarHelpBtn').title = meta.help;
  }
  var lastLoadAt = null;
  function updateLiveText() {
    var el = $('topbarLiveText');
    if (!lastLoadAt) { el.textContent = 'Connecting…'; return; }
    var secs = Math.round((Date.now() - lastLoadAt) / 1000);
    if (secs < 3) el.textContent = 'Updated just now';
    else el.textContent = 'Updated ' + secs + 's ago';
  }

  // ---- sidebar collapse (per-browser convenience, not shared state) ----
  var shellEl = document.querySelector('.a-shell');
  function setSidebarCollapsed(collapsed) {
    shellEl.classList.toggle('is-sidebar-collapsed', collapsed);
    try { localStorage.setItem('a_sidebar_collapsed', collapsed ? '1' : '0'); } catch (e) {}
  }
  $('sidebarCollapseBtn').addEventListener('click', function () { setSidebarCollapsed(true); });
  $('sidebarShowBtn').addEventListener('click', function () { setSidebarCollapsed(false); });
  try { if (localStorage.getItem('a_sidebar_collapsed') === '1') setSidebarCollapsed(true); } catch (e) {}

  // ---- tabs ----
  // NOTE: 'add-game' is deliberately not a .a-tab anymore -- it moved behind
  // an "+ Add Game" button on the Games tab that opens it as a modal (same
  // pattern as New Rental below), so it never shows up in this loop.
  // Swap Requests/Reservations/History are nested under Rentals (owner's
  // request) but always shown, not a collapsible submenu.
  Array.prototype.forEach.call(document.querySelectorAll('.a-tab'), function (tab) {
    tab.addEventListener('click', function () {
      closeNewRentalModal();
      closeAddGameModal();
      closeAddRenterModal();
      Array.prototype.forEach.call(document.querySelectorAll('.a-tab'), function (t) { t.classList.remove('is-active'); });
      Array.prototype.forEach.call(document.querySelectorAll('.a-panel'), function (p) { p.classList.remove('is-active'); });
      tab.classList.add('is-active');
      $('panel-' + tab.getAttribute('data-tab')).classList.add('is-active');
      setTopbarSection(tab.getAttribute('data-tab'));
    });
  });

  // ---- New Rental as a popup (opened from the Rentals tab's "+ New
  // Rental" button, or pre-filled by Swap Game) ----
  function openNewRentalModal() {
    $('panel-new-rental').classList.add('is-modal-open');
    $('newRentalBackdrop').hidden = false;
    $('closeNewRentalModalBtn').hidden = false;
  }
  function closeNewRentalModal() {
    $('panel-new-rental').classList.remove('is-modal-open');
    $('newRentalBackdrop').hidden = true;
    $('closeNewRentalModalBtn').hidden = true;
  }
  $('newRentalBackdrop').addEventListener('click', closeNewRentalModal);
  $('closeNewRentalModalBtn').addEventListener('click', closeNewRentalModal);
  $('openBlankNewRentalBtn').addEventListener('click', function () {
    cancelSwap();
    openNewRentalModal();
  });

  // ---- Add Game as a popup (moved off the sidebar -- same modal pattern
  // as New Rental, opened from a button on the Games tab instead) ----
  function openAddGameModal() {
    $('panel-add-game').classList.add('is-modal-open');
    $('addGameBackdrop').hidden = false;
    $('closeAddGameModalBtn').hidden = false;
  }
  function closeAddGameModal() {
    $('panel-add-game').classList.remove('is-modal-open');
    $('addGameBackdrop').hidden = true;
    $('closeAddGameModalBtn').hidden = true;
  }
  $('addGameBackdrop').addEventListener('click', closeAddGameModal);
  $('closeAddGameModalBtn').addEventListener('click', closeAddGameModal);
  $('openAddGameBtn').addEventListener('click', openAddGameModal);

  // ---- Add Renter as a popup (same modal pattern as Add Game -- moved off
  // the Renters panel body into a modal opened from a button) ----
  function openAddRenterModal() {
    $('panel-add-renter').classList.add('is-modal-open');
    $('addRenterBackdrop').hidden = false;
    $('closeAddRenterModalBtn').hidden = false;
  }
  function closeAddRenterModal() {
    $('panel-add-renter').classList.remove('is-modal-open');
    $('addRenterBackdrop').hidden = true;
    $('closeAddRenterModalBtn').hidden = true;
  }
  $('addRenterBackdrop').addEventListener('click', closeAddRenterModal);
  $('closeAddRenterModalBtn').addEventListener('click', closeAddRenterModal);
  $('openAddRenterBtn').addEventListener('click', openAddRenterModal);

  $('signOutBtn').addEventListener('click', function () { window.rcSignOut(); });

  // ---- data loading ----
  // ---- new-item alerts (sound + browser notification) ----
  // The dashboard only polls every 5s while its own tab is open, so a
  // backgrounded/minimized tab can sit on a new pending payment or swap
  // request for a while with nothing to draw the admin back. This fires a
  // beep + OS-level notification the moment either count goes UP.
  //
  // Counts here are computed straight from state.rentals/state.swapRequests
  // (not from pendingRows()/renderSwaps()'s row lists), because those are
  // filtered by whatever the admin currently has typed into search -- using
  // them would fire a false "new item" every time a search narrows the
  // count back down and then a re-render widens it again.
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  var audioCtx = null;
  function playAlertBeep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.36);
    } catch (e) {}
  }
  function notifyNewItem(title, body) {
    playAlertBeep();
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body: body, tag: title });
      }
    } catch (e) {}
  }
  var alertCounts = { pending: null, swaps: null };
  function checkForNewAlerts() {
    var pendingCount = state.rentals.filter(function (r) { return r.status === 'pending' && r.queue_position == null; }).length;
    var swapsCount = state.swapRequestsAvailable
      ? state.swapRequests.filter(function (r) { return r.status === 'pending'; }).length
      : 0;
    // null means "first load" -- skip alerting on whatever's already sitting
    // there when the dashboard opens, only alert on genuinely new arrivals.
    if (alertCounts.pending !== null && pendingCount > alertCounts.pending) {
      var newPending = pendingCount - alertCounts.pending;
      notifyNewItem('New pending payment', newPending === 1 ? 'A customer is waiting for payment confirmation.' : newPending + ' customers are waiting for payment confirmation.');
    }
    if (alertCounts.swaps !== null && swapsCount > alertCounts.swaps) {
      var newSwaps = swapsCount - alertCounts.swaps;
      notifyNewItem('New swap request', newSwaps === 1 ? 'A customer submitted a swap request.' : newSwaps + ' customers submitted swap requests.');
    }
    alertCounts.pending = pendingCount;
    alertCounts.swaps = swapsCount;
  }

  function loadAll() {
    return Promise.all([
      supabase.from('games').select('*').order('title'),
      // Newest first: a renter the owner just created (or who just signed up)
      // is the one they're about to act on. populateRenterSelect() re-sorts a
      // copy by name, so the dropdown stays alphabetical for scanning.
      supabase.from('renters').select('*').order('created_at', { ascending: false }),
      // Embed nested games/renters with '*' rather than naming columns --
      // ref_code/swap_count/hold_expires_at/public_code may not exist yet
      // (see RENT-FLOW-CONTRACT.md), and naming an unknown column anywhere
      // in a server-side select errors the WHOLE query, taking the
      // dashboard down (this exact bug bit site/assets/catalog.js's
      // loadGames() before -- see the comment there). '*' always works
      // regardless of which columns exist.
      supabase.from('rentals').select('*, games(*), renters(*)').order('created_at', { ascending: false }),
      // `settings` (migration_14) and `swap_requests` (migration_16,
      // CONTRACT-AMENDMENT-1.md) may not exist in the live DB at all yet --
      // a query against a table that doesn't exist resolves with
      // `res.error` set (PostgREST/PostgREST-over-fetch doesn't throw), so
      // it's safe to run these in the same Promise.all as everything else;
      // one failing does not reject the others. Checked via *Available
      // flags below instead of letting the error propagate.
      supabase.from('settings').select('*'),
      supabase.from('swap_requests').select('*').order('created_at', { ascending: false })
    ]).then(function (results) {
      state.games = (results[0].data || []);
      state.renters = (results[1].data || []);
      state.rentals = (results[2].data || []);

      var settingsRes = results[3];
      state.settingsAvailable = !settingsRes.error;
      state.settings = {};
      (settingsRes.data || []).forEach(function (row) { state.settings[row.key] = row.value; });

      var swapReqRes = results[4];
      state.swapRequestsAvailable = !swapReqRes.error;
      state.swapRequests = swapReqRes.data || [];

      checkForNewAlerts();

      renderPending();
      renderSwaps();
      renderRentals();
      renderReservations();
      renderHistory();
      renderRenters();
      renderGames();
      renderOverview();
      renderSettings();
      populateRenterSelect();
      populateGameOptions();
      updateSlotHintAndAmount();
      lastLoadAt = Date.now();
      updateLiveText();
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
    endingSoon = sortRows('endingSoonTable', endingSoon);

    $('statRevenuePaid').textContent = '₱' + paid.toLocaleString();
    $('statRevenuePending').textContent = '₱' + pending.toLocaleString();
    $('statPendingCount').textContent = pendingCount + ' pending rental' + (pendingCount === 1 ? '' : 's');
    $('statActiveCount').textContent = activeCount;
    $('statEndingSoon').textContent = endingSoon.length + ' ending in 2 days';
    $('statRenterCount').textContent = state.renters.length;

    var tbody = document.querySelector('#endingSoonTable tbody');
    tbody.innerHTML = '';
    $('endingSoonEmpty').hidden = endingSoon.length > 0;
    endingSoon.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc((r.games || {}).title) + '</td><td>' + esc((r.renters || {}).name) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td><td>' + timeLeftLabel(r.end_date) + '</td>';
      tbody.appendChild(tr);
    });

    var topGames = state.games.filter(function (g) { return (g.times_rented || 0) > 0; })
      .sort(function (a, b) { return b.times_rented - a.times_rented; }).slice(0, 5);
    topGames = sortRows('mostRentedTable', topGames);
    var mrTbody = document.querySelector('#mostRentedTable tbody');
    mrTbody.innerHTML = '';
    $('mostRentedEmpty').hidden = topGames.length > 0;
    topGames.forEach(function (g) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(g.title) + '</td><td>' + g.times_rented + '</td>';
      mrTbody.appendChild(tr);
    });
  }

  // ---- shared: clipboard copy + live "time since" / "time left" cells
  // (self-serve rent flow -- Pending Payments and Swap Requests tabs) ----
  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
    } catch (e) { /* fall through to legacy path below */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* clipboard unsupported -- nothing more we can do */ }
  }
  function flashCopied(btn) {
    // Icon-only buttons (e.g. the copy-message button) give feedback by
    // briefly swapping their icon for a checkmark instead of replacing
    // text that isn't there; text buttons (e.g. the ref-code button) keep
    // the original "Copied!" text swap.
    if (btn.classList.contains('a-icon-btn')) {
      var originalTitle = btn.getAttribute('title');
      var originalHtml = btn.innerHTML;
      btn.innerHTML = CHECK_ICON;
      btn.classList.add('is-copied');
      btn.setAttribute('title', 'Copied!');
      setTimeout(function () {
        btn.innerHTML = originalHtml;
        btn.classList.remove('is-copied');
        if (originalTitle != null) btn.setAttribute('title', originalTitle);
      }, 1200);
      return;
    }
    var original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = original; }, 1200);
  }
  // Ref-code copy buttons (Pending Payments, Swap Requests) and the
  // public-code "Copy message" action (Pending Payments, Swap Requests,
  // Renters) are rendered in several different tables -- one delegated
  // listener covers all of them instead of re-wiring per table.
  document.addEventListener('click', function (e) {
    var copyBtn = e.target.closest('.a-refcode-btn[data-copy]');
    if (copyBtn) { copyToClipboard(copyBtn.getAttribute('data-copy')); flashCopied(copyBtn); return; }
    // [data-copy-msg] (not scoped to a specific class) covers both the
    // icon-only "Copy message" buttons still used elsewhere and
    // publicCodeCell()'s tracking-code button, which is a plain
    // .a-refcode-btn that copies the ready-to-paste message instead of
    // the bare code.
    var msgBtn = e.target.closest('[data-copy-msg]');
    if (msgBtn) { copyToClipboard(msgBtn.getAttribute('data-copy-msg')); flashCopied(msgBtn); }
  });

  // Customer's tracking code (renters.public_code) is auto-saved on their
  // device at rent time, so the admin normally never needs it -- but it
  // comes up (cleared browser, new phone, asking on Messenger), so every
  // place we show it also offers a one-click "Copy message" with a
  // ready-to-paste Messenger line pointing them back to it.
  function siteAccountUrl() {
    var origin = (window.location && window.location.origin) || '';
    // Guard against file:// (this repo's own test harness) or an opaque
    // 'null' origin -- fall back to a real, readable example URL rather
    // than copying garbage into the admin's Messenger message.
    if (origin.indexOf('http') === 0) return origin + '/account/';
    return 'https://ps5-rentals.vercel.app/account/';
  }
  function publicCodeMessage(code) {
    return 'Your June Digitals tracking code is ' + code + ' -- open ' + siteAccountUrl() +
      ' and enter it to see your rentals and request a swap.';
  }
  // renter may be missing entirely (embed came back null) or simply not
  // have a public_code yet (pre-migration_14, or a pre-existing renter row
  // that hasn't been backfilled) -- both render as a plain dash, never an
  // empty cell or a thrown error.
  function publicCodeCell(renter) {
    var code = renter && renter.public_code;
    if (!code) return '<span class="a-text-3">&mdash;</span>';
    var msg = publicCodeMessage(code);
    // The code itself is the ready-to-paste Messenger message now -- one
    // button, still labeled with just the short code, but copies the full
    // message (msg) instead of the bare code. No separate icon-only
    // "copy message" button anymore.
    return '<span class="a-code-actions">' +
      '<button type="button" class="a-refcode-btn" data-copy-msg="' + esc(msg) + '" title="Click to copy a ready-to-paste Messenger message">' + esc(code) + '</button>' +
      '</span>';
  }
  function timeSinceLabel(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return 'just now';
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm ago';
    return Math.floor(hrs / 24) + 'd ago';
  }
  function countdownLabel(msLeft) {
    var totalSecs = Math.max(0, Math.floor(msLeft / 1000));
    var mins = Math.floor(totalSecs / 60);
    var secs = totalSecs % 60;
    return mins + ':' + (secs < 10 ? '0' : '') + secs + ' left';
  }
  // Ticks the "waiting"/"hold" cells in any table rendered with
  // data-created-at / data-hold-expires on its <tr> and .a-live-since /
  // .a-live-hold cells inside it -- called once per render and then once a
  // second from the same setInterval(tickLiveClocks, 1000) that already
  // drove the topbar's "Updated Xs ago" text.
  function updateLiveCountdownCells(tableSelector) {
    var rows = document.querySelectorAll(tableSelector + ' tbody tr');
    Array.prototype.forEach.call(rows, function (tr) {
      var createdAt = tr.getAttribute('data-created-at');
      var holdExp = tr.getAttribute('data-hold-expires');
      var sinceCell = tr.querySelector('.a-live-since');
      var holdCell = tr.querySelector('.a-live-hold');
      if (sinceCell) sinceCell.textContent = createdAt ? timeSinceLabel(createdAt) : '--';
      if (holdCell) {
        if (!holdExp) {
          holdCell.textContent = 'No hold set';
          holdCell.className = 'a-live-hold a-text-3';
        } else {
          var msLeft = new Date(holdExp).getTime() - Date.now();
          if (msLeft <= 0) {
            holdCell.textContent = 'Expired';
            holdCell.className = 'a-live-hold a-text-red';
          } else {
            holdCell.textContent = countdownLabel(msLeft);
            holdCell.className = 'a-live-hold';
          }
        }
      }
    });
  }

  // ---- pending payments tab (the new main queue -- see
  // RENT-FLOW-CONTRACT.md decision #1). Source: rentals where
  // status='pending', newest first. Filters out queue_position rows --
  // those are pre-reserve reservations for 'upcoming' games, a separate
  // older flow still driven from the Rentals tab (Confirm Payment /
  // Activate honoring queue order); this queue is only the ordinary
  // self-serve pending rentals the new create_rental_hold RPC writes. ----
  function pendingMatchSearch(r) {
    var q = state.pendingSearch;
    if (!q) return true;
    var game = r.games || {};
    var renter = r.renters || {};
    var haystack = [game.title, renter.name, r.ref_code].join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  }
  function pendingRows() {
    return state.rentals.filter(function (r) { return r.status === 'pending' && r.queue_position == null; })
      .filter(pendingMatchSearch)
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  }
  function renderPending() {
    var tbody = document.querySelector('#pendingTable tbody');
    tbody.innerHTML = '';
    var rows = sortRows('pendingTable', pendingRows());
    $('pendingEmpty').hidden = rows.length > 0;
    var badge = $('pendingBadge');
    badge.textContent = rows.length ? '(' + rows.length + ')' : '';
    // The pending tab's help tooltip needs the live hold_minutes value, so
    // it's built here (where settings are freshest) instead of sitting as a
    // fixed string in TAB_META -- only touches the shared help button when
    // Pending is the tab actually showing, so it can't stomp another tab's
    // tooltip text if this render happens to run while a different tab is
    // active (loadAll() renders every tab's data every poll).
    if (document.querySelector('.a-tab.is-active[data-tab="pending"]')) {
      var holdMins = state.settings.hold_minutes || 30;
      $('topbarHelpBtn').title = 'Customer already picked a game on the public site and got a GCash reference on the payment screen -- their slot is already held for ' + holdMins + ' minutes. Match the ref code below to their Messenger screenshot, then click Confirm Paid. Nothing else to fill in.';
    }
    rows.forEach(function (r) {
      var game = r.games || {};
      var renter = r.renters || {};
      var tr = document.createElement('tr');
      tr.setAttribute('data-created-at', r.created_at || '');
      tr.setAttribute('data-hold-expires', r.hold_expires_at || '');
      var cover = game.cover ? '<img class="a-pending-cover" src="' + esc(game.cover) + '" alt="">' : '';
      var refCode = r.ref_code
        ? '<button type="button" class="a-refcode-btn" data-copy="' + esc(r.ref_code) + '" title="Click to copy">' + esc(r.ref_code) + '</button>'
        : '<span class="a-text-3" title="Pre-migration row -- ref_code not backfilled yet">&mdash;</span>';
      var linked = renter.auth_user_id
        ? '<span class="a-pill a-pill-linked" title="Signed-in customer account">Linked</span>' : '';
      tr.innerHTML =
        '<td>' + cover + esc(game.title) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + '</td>' +
        '<td>₱' + (r.amount != null ? r.amount : 0) + '</td>' +
        '<td>' + refCode + '</td>' +
        '<td>' + esc(renter.name) + ' ' + linked + '</td>' +
        '<td>' + publicCodeCell(renter) + '</td>' +
        '<td class="a-live-since">--</td>' +
        '<td class="a-live-hold">--</td>' +
        '<td class="a-actions-cell">' +
          '<button type="button" class="a-btn a-btn-green" data-action="confirm-paid" data-id="' + r.id + '">Confirm Paid</button> ' +
          '<button type="button" class="a-btn a-btn-red" data-action="decline" data-id="' + r.id + '">Decline</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    updateLiveCountdownCells('#pendingTable');
  }

  function confirmPending(rental) {
    showPrompt('GCash reference number (optional -- leave blank and click OK to skip):', { defaultValue: rental.gcash_ref || '' }).then(function (input) {
      if (input === null) return; // admin cancelled -- do nothing
      var patch = { status: 'active', payment_status: 'paid' };
      // hold_expires_at only exists once migration_14 has run -- guard with
      // hasOwnProperty (present as an explicit key, even when null, whenever
      // the column exists) rather than assuming it's there, same reasoning
      // as the select-side guidance: an unknown column in the update payload
      // 400s the whole request just as badly as one in a filter.
      if (Object.prototype.hasOwnProperty.call(rental, 'hold_expires_at')) patch.hold_expires_at = null;
      var ref = input.trim();
      if (ref) patch.gcash_ref = ref;
      // IMPORTANT: do NOT touch games.*_available/*_available_at here. The
      // slot was already soft-held (flipped unavailable) the moment
      // create_rental_hold created this pending row -- flipping it again on
      // confirm would be a second, redundant "close" that has no matching
      // "open" and desyncs the slot from reality the next time this rental
      // legitimately frees up. Confirming payment only changes the rental's
      // own status/payment_status.
      supabase.from('rentals').update(patch).eq('id', rental.id).then(function (res) {
        if (res.error) { showAlert(res.error.message); return; }
        loadAll();
      });
    });
  }

  function declinePending(rental) {
    showConfirm('Decline this pending payment and free the slot? This cannot be undone from here.', { okLabel: 'Decline', danger: true }).then(function (ok) {
      if (!ok) return;
      supabase.from('rentals').update({ status: 'cancelled' }).eq('id', rental.id).then(function (res) {
        if (res.error) { showAlert(res.error.message); return; }
        // Declining is the one case where we DO free the slot -- nobody is
        // going to pay for it, so the hold this pending row was placed on
        // needs to be released back to the public site.
        setGameSlotAvailable(rental.game_id, rental.slot, true).then(function (res2) {
          if (res2.error) { showAlert(res2.error.message); return; }
          loadAll();
        });
      });
    });
  }

  document.querySelector('#pendingTable tbody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return; // copy buttons are handled by the delegated listener above
    var id = Number(btn.getAttribute('data-id'));
    var rental = state.rentals.filter(function (r) { return r.id === id; })[0];
    if (!rental) return;
    var action = btn.getAttribute('data-action');
    if (action === 'confirm-paid') confirmPending(rental);
    else if (action === 'decline') declinePending(rental);
  });

  // ---- swap requests tab (CONTRACT-AMENDMENT-1.md -- swaps no longer
  // auto-approve; the customer's submit_swap_request RPC soft-holds the
  // target slot and drops a pending row here for the admin). swap_requests
  // may not exist yet (migration_16) -- state.swapRequestsAvailable comes
  // from loadAll() checking res.error on that query, not from anything in
  // this render, so a missing table shows a hint instead of erroring. ----
  function renderSwaps() {
    var hint = $('swapsMigrationHint');
    var wrap = $('swapsTableWrap');
    var badge = $('swapsBadge');
    if (!state.swapRequestsAvailable) {
      hint.hidden = false;
      wrap.style.display = 'none';
      $('swapsEmpty').hidden = true;
      badge.textContent = '';
      return;
    }
    hint.hidden = true;
    wrap.style.display = '';
    var tbody = document.querySelector('#swapsTable tbody');
    tbody.innerHTML = '';
    function swapMatchSearch(req) {
      var q = state.swapsSearch;
      if (!q) return true;
      var renter = state.renters.filter(function (r) { return r.id === req.renter_id; })[0] || {};
      var fromGame = state.games.filter(function (g) { return g.id === req.from_game_id; })[0] || {};
      var toGame = state.games.filter(function (g) { return g.id === req.to_game_id; })[0] || {};
      var haystack = [renter.name, fromGame.title, toGame.title].join(' ').toLowerCase();
      return haystack.indexOf(q) !== -1;
    }
    var rows = state.swapRequests.filter(function (r) { return r.status === 'pending'; })
      .filter(swapMatchSearch)
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    // swap_requests rows aren't embedded with their renter/game the way
    // rentals are (see loadAll()) -- attach the looked-up values the
    // generic sort mechanism needs as plain properties, once here, rather
    // than teaching sortRows() how to do per-table joins.
    rows.forEach(function (req) {
      var renter = state.renters.filter(function (r) { return r.id === req.renter_id; })[0] || {};
      var fromGame = state.games.filter(function (g) { return g.id === req.from_game_id; })[0] || {};
      var toGame = state.games.filter(function (g) { return g.id === req.to_game_id; })[0] || {};
      var rental = state.rentals.filter(function (r) { return r.id === req.rental_id; })[0];
      req.renterName = renter.name || '';
      req.fromTitle = fromGame.title || '';
      req.toTitle = toGame.title || '';
      req.endsDate = rental ? rental.end_date : null;
      req.swapsUsedCount = rental ? (rental.swap_count != null ? rental.swap_count : swapsUsed(rental)) : 0;
    });
    rows = sortRows('swapsTable', rows);
    $('swapsEmpty').hidden = rows.length > 0;
    badge.textContent = rows.length ? '(' + rows.length + ')' : '';
    rows.forEach(function (req) {
      var renter = state.renters.filter(function (r) { return r.id === req.renter_id; })[0] || {};
      var fromGame = state.games.filter(function (g) { return g.id === req.from_game_id; })[0] || {};
      var toGame = state.games.filter(function (g) { return g.id === req.to_game_id; })[0] || {};
      var rental = state.rentals.filter(function (r) { return r.id === req.rental_id; })[0];
      var tr = document.createElement('tr');
      tr.setAttribute('data-created-at', req.created_at || '');
      tr.setAttribute('data-hold-expires', req.hold_expires_at || '');
      var refCode = req.ref_code
        ? '<button type="button" class="a-refcode-btn" data-copy="' + esc(req.ref_code) + '" title="Click to copy">' + esc(req.ref_code) + '</button>'
        : '<span class="a-text-3">&mdash;</span>';
      var swapsInfo = '&mdash;';
      if (rental) {
        var used = rental.swap_count != null ? rental.swap_count : swapsUsed(rental);
        var limit = planSwapLimit(rental.plan);
        swapsInfo = used + (limit != null ? ' / ' + limit : '') +
          (limit != null ? ' <span class="a-text-3">(' + Math.max(0, limit - used) + ' left)</span>' : '');
      }
      tr.innerHTML =
        '<td>' + esc(renter.name || 'Unknown') + '<br>' + publicCodeCell(renter) + '</td>' +
        '<td>' + (fromGame.cover ? '<img class="a-pending-cover" src="' + esc(fromGame.cover) + '" alt="">' : '') +
          esc(fromGame.title || 'Unknown') + ' (' + (req.from_slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + ')</td>' +
        '<td>' + (toGame.cover ? '<img class="a-pending-cover" src="' + esc(toGame.cover) + '" alt="">' : '') +
          esc(toGame.title || 'Unknown') + ' (' + (req.to_slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + ')</td>' +
        '<td>' + (rental ? fmtDate(rental.end_date) : '&mdash;') + '</td>' +
        '<td>' + swapsInfo + '</td>' +
        '<td>' + refCode + '</td>' +
        '<td class="a-live-since">--</td>' +
        '<td class="a-live-hold">--</td>' +
        '<td class="a-actions-cell">' +
          '<button type="button" class="a-btn a-btn-green" data-action="approve-swap" data-id="' + req.id + '">Approve</button> ' +
          '<button type="button" class="a-btn a-btn-red" data-action="decline-swap" data-id="' + req.id + '">Decline</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    updateLiveCountdownCells('#swapsTable');
  }

  // Both RPCs are admin-only security-definer functions that do all the
  // slot/rentals bookkeeping atomically server-side -- we only ever call
  // them here, never flip games.*_available or write to rentals ourselves
  // for a swap. Doing both would double-free/double-hold the slot.
  function swapRpcResultError(res) {
    if (res.error) return res.error.message;
    var row = res.data && res.data[0];
    if (row && row.ok === false) {
      return row.error === 'not_admin'
        ? 'You are not recognized as an admin for this action.'
        : ('Could not complete: ' + (row.error || 'unknown error'));
    }
    return null;
  }
  function approveSwapRequest(req) {
    showPrompt('Optional note for this approval (leave blank and press OK to skip):', { defaultValue: '' }).then(function (note) {
      if (note === null) return;
      supabase.rpc('approve_swap_request', { p_id: req.id, p_note: note.trim() || null }).then(function (res) {
        var err = swapRpcResultError(res);
        if (err) { showAlert(err); return; }
        loadAll();
      });
    });
  }
  function declineSwapRequest(req) {
    showConfirm('Decline this swap request and release the held slot back to the public site?', { okLabel: 'Decline', danger: true }).then(function (ok) {
      if (!ok) return;
      showPrompt('Optional note for this decline (leave blank and press OK to skip):', { defaultValue: '' }).then(function (note) {
        if (note === null) return;
        supabase.rpc('decline_swap_request', { p_id: req.id, p_note: note.trim() || null }).then(function (res) {
          var err = swapRpcResultError(res);
          if (err) { showAlert(err); return; }
          loadAll();
        });
      });
    });
  }
  document.querySelector('#swapsTable tbody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return; // copy buttons are handled by the delegated listener above
    var id = Number(btn.getAttribute('data-id'));
    var req = state.swapRequests.filter(function (r) { return r.id === id; })[0];
    if (!req) return;
    var action = btn.getAttribute('data-action');
    if (action === 'approve-swap') approveSwapRequest(req);
    else if (action === 'decline-swap') declineSwapRequest(req);
  });

  // A rental created by an approved swap request still needs its new
  // game's credentials sent on Messenger -- that's the admin's only
  // remaining manual step (CONTRACT-AMENDMENT-1.md). Keyed off an actual
  // *approved* swap_requests row rather than guessing from the rental's
  // own age, so this only fires for swaps that went through the real
  // approval queue (not a plain admin-initiated Swap Game from the
  // Rentals tab, where the admin already knows and just did it).
  function approvedSwapRequestFor(rental) {
    if (rental.swapped_from_rental_id == null) return null;
    return state.swapRequests.filter(function (sr) {
      return sr.status === 'approved' && sr.rental_id === rental.swapped_from_rental_id;
    })[0];
  }
  function needsCredentialsHint(rental) {
    var sr = approvedSwapRequestFor(rental);
    if (!sr || !sr.handled_at) return false;
    return (Date.now() - new Date(sr.handled_at).getTime()) / 3600000 < 24;
  }

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
  // Walks the swapped_from_rental_id chain backward to build the full
  // history of games this same continuous rental period has been through
  // -- oldest first, ending with the current rental.
  function swapChain(rental) {
    var chain = [rental];
    var cur = rental;
    while (cur.swapped_from_rental_id != null) {
      var prev = state.rentals.filter(function (r) { return r.id === cur.swapped_from_rental_id; })[0];
      if (!prev) break;
      chain.unshift(prev);
      cur = prev;
    }
    return chain;
  }
  function swapsUsed(rental) { return swapChain(rental).length - 1; }
  // The allowance lives in settings (swap_limit_weekly / swap_limit_monthly,
  // see migration_14), so the admin app and the DB's submit_swap_request()
  // agree on one number instead of each enforcing its own. Falls back to the
  // old hardcoded rule (weekly capped at 1, monthly uncapped) only when
  // settings aren't readable -- e.g. before migration_14 is applied.
  function swapLimitReached(rental) {
    var limit = planSwapLimit(rental.plan);
    var used = rental.swap_count != null ? rental.swap_count : swapsUsed(rental);
    if (limit == null) return rental.plan === 'weekly' && used >= 1;
    return used >= limit;
  }
  function paymentPill(p) {
    return '<span class="a-pill ' + (p === 'paid' ? 'a-pill-paid' : 'a-pill-pending') + '">' + esc(p) + '</span>';
  }

  // Rentals tab is active-only, permanently -- pending (ordinary or
  // queued/reservation) rows live on the Pending Payments / Reservations
  // tabs instead, and ended/cancelled rows live on History. See the owner's
  // request: "rentals only show active rentals, no all tab".
  function rentalsMatchFilter(r) { return r.status === 'active'; }
  function rowMatchesSearch(r, q) {
    if (!q) return true;
    var game = r.games || {};
    var renter = r.renters || {};
    var haystack = [game.title, renter.name, r.slot === 'trophy' ? 'trophy' : 'non-trophy'].join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  }
  function rentalsMatchSearch(r) { return rowMatchesSearch(r, state.rentalsSearch); }
  $('rentalsSearch').addEventListener('input', function () {
    state.rentalsSearch = this.value.trim().toLowerCase();
    renderRentals();
  });
  $('pendingSearch').addEventListener('input', function () {
    state.pendingSearch = this.value.trim().toLowerCase();
    renderPending();
  });
  $('swapsSearch').addEventListener('input', function () {
    state.swapsSearch = this.value.trim().toLowerCase();
    renderSwaps();
  });
  $('rentersSearch').addEventListener('input', function () {
    state.rentersSearch = this.value.trim().toLowerCase();
    renderRenters();
  });
  $('historySearch').addEventListener('input', function () {
    state.historySearch = this.value.trim().toLowerCase();
    renderHistory();
  });

  function renderRentals() {
    var tbody = document.querySelector('#rentalsTable tbody');
    tbody.innerHTML = '';
    var rows = sortRows('rentalsTable', state.rentals.filter(rentalsMatchFilter).filter(rentalsMatchSearch));
    $('rentalsEmpty').hidden = rows.length > 0;
    $('rentalsEmpty').textContent = state.rentalsSearch ? 'No active rentals match this search.' : 'No active rentals right now.';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var game = r.games || {};
      var renter = r.renters || {};
      var renterObj = state.renters.filter(function (x) { return x.id === r.renter_id; })[0];
      var actions = '';
      var timeLeftCell = '—';
      if (r.status === 'pending') {
        if (r.queue_position == null) {
          // Ordinary pending rental (not tied to an upcoming-game queue) --
          // payment confirmation and activation happen in one step, same
          // as before.
          actions += '<button type="button" class="a-menu-item" data-action="activate" data-id="' + r.id + '">Confirm Payment &amp; Activate</button>';
        } else {
          timeLeftCell = 'Queue #' + r.queue_position;
          if (r.payment_status !== 'paid') {
            actions += '<button type="button" class="a-menu-item" data-action="confirm-payment" data-id="' + r.id + '">Confirm Payment</button>';
          } else if (r.queue_position === 1) {
            actions += '<button type="button" class="a-menu-item" data-action="activate" data-id="' + r.id + '">Activate</button>';
          } else {
            actions += '<button type="button" class="a-menu-item" disabled title="Only the front of the queue can be activated">Activate (queue #' + r.queue_position + ')</button>';
          }
        }
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
        var usedSoFar = swapsUsed(r);
        if (swapLimitReached(r)) {
          var reachedLimit = planSwapLimit(r.plan);
          actions += '<button type="button" class="a-menu-item" disabled title="' +
            esc(reachedLimit != null
              ? 'This ' + r.plan + ' rental includes ' + reachedLimit + ' swap' + (reachedLimit === 1 ? '' : 's') + ', all used'
              : 'Swap allowance already used') +
            '">Swap limit reached</button>';
        } else {
          var cooldownHours = swapCooldownHoursLeft(r);
          if (cooldownHours > 0) {
            actions += '<button type="button" class="a-menu-item" disabled title="This rental started less than 24h ago">Swap in ' + cooldownHours + 'h</button>';
          } else {
            actions += '<button type="button" class="a-menu-item" data-action="swap" data-id="' + r.id + '">Swap Game' + (usedSoFar > 0 ? ' (' + usedSoFar + ' used)' : '') + '</button>';
          }
        }
        if (usedSoFar > 0) {
          actions += '<button type="button" class="a-menu-item" data-action="swap-history" data-id="' + r.id + '">Swap History (' + usedSoFar + ')</button>';
        }
        if (renterObj && renterObj.messenger_url) {
          actions += '<a class="a-menu-item" href="' + esc(renterObj.messenger_url) + '" target="_blank" rel="noopener">Open Messenger</a>';
        }
      }
      var isQueued = r.status === 'pending' && r.queue_position != null;
      // A rental created by request_swap/approve_swap_request carries
      // swapped_from_rental_id -- badge it "Swapped" (this column already
      // exists today, unlike swap_count/the swap_requests join below, so
      // this badge always shows regardless of migration state) plus how
      // many swaps it's used against the plan's limit, when swap_count is
      // available, and a "Needs credentials" cue for the ~24h window after
      // an *approved* swap request while the admin still owes the customer
      // the new game's login on Messenger.
      var swapInfo = '';
      if (r.swapped_from_rental_id != null) {
        swapInfo += ' <span class="a-pill a-pill-swap" title="Created by a swap -- old rental ended, this one carries the same end date">Swapped</span>';
        if (r.swap_count != null) {
          var swapLimitVal = planSwapLimit(r.plan);
          swapInfo += ' <span class="a-hint" style="display:inline;margin:0;">(' + r.swap_count + ' swap' + (r.swap_count === 1 ? '' : 's') +
            (swapLimitVal != null ? ', ' + Math.max(0, swapLimitVal - r.swap_count) + ' left' : '') + ')</span>';
        }
        if (needsCredentialsHint(r)) {
          swapInfo += ' <span class="a-pill a-pill-pending" title="Approved swap -- send the new game\'s credentials on Messenger">Needs credentials</span>';
        }
      }
      tr.innerHTML =
        '<td>' + esc(game.title) + swapInfo + '</td>' +
        '<td>' + esc(renter.name) + ' ' + messengerIcon(renterObj && renterObj.messenger_url) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + ' (₱<span data-amount-display>' + r.amount + '</span>' +
          ' <button type="button" class="a-edit-amount" data-action="edit-amount" data-id="' + r.id + '" title="Edit amount">✎</button>)</td>' +
        '<td>' + (r.status === 'ended' && wasSwapped(r.id) ? '<span class="a-pill a-pill-swap">Swapped</span>' : statusPill(r.status)) + '</td>' +
        '<td>' + paymentPill(r.payment_status) + '</td>' +
        // Still in the queue -- start/end aren't real yet (they only
        // become meaningful once activated), so don't show a countdown
        // that hasn't started.
        '<td>' + (isQueued ? '—' : fmtDate(r.start_date)) + '</td>' +
        '<td>' + (isQueued ? '—' : fmtDate(r.end_date)) + '</td>' +
        '<td>' + timeLeftCell + '</td>' +
        '<td class="a-notes-cell" title="' + esc(r.notes || '') + '">' + esc(r.notes || '') + '</td>' +
        '<td class="a-actions-cell">' + actionsMenu(actions) + '</td>';
      tbody.appendChild(tr);
    });
  }

  // Shared by #rentalsTable (active rows: end/end-override/edit-amount/swap/
  // swap-history) and #reservationsTable (queued pending rows: activate/
  // cancel/confirm-payment) -- same rental-mutating actions regardless of
  // which table the click came from, so one handler covers both.
  function onRentalRowAction(e) {
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
          showConfirm(
            'This renter is #' + rental.queue_position + ' in the queue for this slot -- ' + aheadNames +
            ' is still ahead of them and hasn\'t been activated or cancelled yet. Activate this one anyway?'
          ).then(function (ok) {
            if (!ok) return;
            activateRental(rental);
          });
          return;
        }
      }
      activateRental(rental);
    }
    else if (action === 'cancel') setRentalStatus(rental, 'cancelled', false);
    else if (action === 'end') setRentalStatus(rental, 'ended', true);
    else if (action === 'end-override') {
      var left = daysLeft(rental.end_date);
      showConfirm(
        'This rental still has ' + left + ' day' + (left === 1 ? '' : 's') + ' remaining. End it early anyway?',
        { okLabel: 'End Early', danger: true }
      ).then(function (ok) {
        if (ok) setRentalStatus(rental, 'ended', true);
      });
    } else if (action === 'edit-amount') {
      showPrompt('Amount actually paid (₱) for this rental:', { defaultValue: rental.amount, inputType: 'number' }).then(function (input) {
        if (input === null) return;
        var newAmount = Number(input);
        if (!(newAmount >= 0)) { showAlert('Enter a valid non-negative number.'); return; }
        supabase.from('rentals').update({ amount: newAmount }).eq('id', id).then(function (res) {
          if (res.error) { showAlert(res.error.message); return; }
          loadAll();
        });
      });
    } else if (action === 'swap') {
      startSwap(rental);
    } else if (action === 'swap-history') {
      var chain = swapChain(rental);
      var lines = chain.map(function (r, i) {
        var g = r.games || {};
        return (i + 1) + '. ' + (g.title || 'Unknown') + ' (' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + ')' + (i === chain.length - 1 ? ' -- current' : '');
      });
      showAlert('Swap history for this rental (' + (chain.length - 1) + ' swap' + (chain.length - 1 === 1 ? '' : 's') + '):\n\n' + lines.join('\n'));
    } else if (action === 'confirm-payment') {
      supabase.from('rentals').update({ payment_status: 'paid' }).eq('id', id).then(function (res) {
        if (res.error) { showAlert(res.error.message); return; }
        loadAll();
      });
    }
  }
  document.querySelector('#rentalsTable tbody').addEventListener('click', onRentalRowAction);
  document.querySelector('#reservationsTable tbody').addEventListener('click', onRentalRowAction);

  // ---- reservations tab (the pre-reserve queue rows pendingRows()
  // deliberately excludes -- rentals with queue_position != null, waiting
  // on either payment confirmation or their turn at the front of the queue.
  // Action-button logic ported verbatim from the old combined Rentals
  // table's queued-row branch. ----
  function reservationsRows() {
    return state.rentals.filter(function (r) { return r.status === 'pending' && r.queue_position != null; })
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  }
  function renderReservations() {
    var tbody = document.querySelector('#reservationsTable tbody');
    tbody.innerHTML = '';
    var rows = sortRows('reservationsTable', reservationsRows());
    $('reservationsEmpty').hidden = rows.length > 0;
    var badge = $('reservationsBadge');
    badge.textContent = rows.length ? '(' + rows.length + ')' : '';
    rows.forEach(function (r) {
      var game = r.games || {};
      var renter = r.renters || {};
      var tr = document.createElement('tr');
      var actions = '';
      if (r.payment_status !== 'paid') {
        actions += '<button type="button" class="a-menu-item" data-action="confirm-payment" data-id="' + r.id + '">Confirm Payment</button>';
      } else if (r.queue_position === 1) {
        actions += '<button type="button" class="a-menu-item" data-action="activate" data-id="' + r.id + '">Activate</button>';
      } else {
        actions += '<button type="button" class="a-menu-item" disabled title="Only the front of the queue can be activated">Activate (queue #' + r.queue_position + ')</button>';
      }
      actions += '<button type="button" class="a-menu-item" data-action="cancel" data-id="' + r.id + '">Cancel</button>';
      tr.innerHTML =
        '<td>' + esc(game.title) + '</td>' +
        '<td>' + esc(renter.name) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + '</td>' +
        '<td>₱' + (r.amount != null ? r.amount : 0) + '</td>' +
        '<td>Queue #' + r.queue_position + '</td>' +
        '<td>' + paymentPill(r.payment_status) + '</td>' +
        '<td class="a-notes-cell" title="' + esc(r.notes || '') + '">' + esc(r.notes || '') + '</td>' +
        '<td class="a-actions-cell">' + actionsMenu(actions) + '</td>';
      tbody.appendChild(tr);
    });
  }

  // ---- history tab (today's old "History" chip, promoted to its own tab
  // -- ended or cancelled rentals. Read-only: no action buttons, since
  // nothing here should mutate state anymore). ----
  function historyRows() {
    return state.rentals.filter(function (r) { return r.status === 'ended' || r.status === 'cancelled'; })
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  }
  function renderHistory() {
    var tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML = '';
    var rows = sortRows('historyTable', historyRows().filter(function (r) { return rowMatchesSearch(r, state.historySearch); }));
    $('historyEmpty').hidden = rows.length > 0;
    $('historyEmpty').textContent = state.historySearch ? 'No past rentals match this search.' : 'No past rentals yet.';
    rows.forEach(function (r) {
      var game = r.games || {};
      var renter = r.renters || {};
      var renterObj = state.renters.filter(function (x) { return x.id === r.renter_id; })[0];
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(game.title) + '</td>' +
        '<td>' + esc(renter.name) + ' ' + messengerIcon(renterObj && renterObj.messenger_url) + '</td>' +
        '<td>' + (r.slot === 'trophy' ? 'Trophy' : 'Non-Trophy') + '</td>' +
        '<td>' + (r.plan === 'weekly' ? 'Weekly' : 'Monthly') + '</td>' +
        '<td>' + (wasSwapped(r.id) ? '<span class="a-pill a-pill-swap">Swapped</span>' : statusPill(r.status)) + '</td>' +
        '<td>' + paymentPill(r.payment_status) + '</td>' +
        '<td>' + fmtDate(r.start_date) + '</td>' +
        '<td>' + fmtDate(r.end_date) + '</td>' +
        '<td class="a-notes-cell" title="' + esc(r.notes || '') + '">' + esc(r.notes || '') + '</td>';
      tbody.appendChild(tr);
    });
  }

  // Powers the "times played" count badge on the public catalog card.
  function incrementTimesRented(gameId) {
    var game = state.games.filter(function (g) { return g.id === gameId; })[0];
    var current = (game && game.times_rented) || 0;
    return supabase.from('games').update({ times_rented: current + 1 }).eq('id', gameId);
  }

  function activateRental(rental) {
    var start = todayISO();
    var end = addDaysISO(start, rental.plan === 'weekly' ? 7 : 30);
    supabase.from('rentals').update({
      status: 'active', payment_status: 'paid', start_date: start, end_date: end
    }).eq('id', rental.id).then(function (res) {
      if (res.error) { showAlert(res.error.message); return; }
      // Slot frees up the day after the rental's end date -- shown on the
      // public site as a "Xd left" countdown instead of a flat FULL.
      return setGameSlotAvailable(rental.game_id, rental.slot, false, addDaysISO(end, 1)).then(function (res2) {
        if (res2.error) { showAlert(res2.error.message); return; }
        return incrementTimesRented(rental.game_id).then(function () {
          return resolveQueueSlot(rental).then(loadAll);
        });
      });
    });
  }

  function setRentalStatus(rental, status, freeSlot) {
    supabase.from('rentals').update({ status: status }).eq('id', rental.id).then(function (res) {
      if (res.error) { showAlert(res.error.message); return; }
      if (freeSlot) return setGameSlotAvailable(rental.game_id, rental.slot, true).then(function (res2) {
        if (res2.error) { showAlert(res2.error.message); return; }
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
    // state.renters arrives newest-first for the Renters list; a dropdown is
    // scanned by name, so sort a copy rather than mutating shared state.
    var byName = state.renters.slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    var current = sel.value;
    sel.innerHTML = '<option value="__new">+ New renter</option>' +
      byName.map(function (r) {
        return '<option value="' + r.id + '">' + esc(r.name) + (r.auth_user_id ? ' (linked account)' : '') + '</option>';
      }).join('');
    sel.value = current || '__new';
    toggleNewRenterFields();
  }
  $('renterSelect').addEventListener('change', toggleNewRenterFields);
  function toggleNewRenterFields() {
    var isNew = $('renterSelect').value === '__new';
    $('newRenterNameField').style.display = isNew ? '' : 'none';
    $('newRenterExtraRow').style.display = isNew ? '' : 'none';
    if (!isNew) $('renterMatchHint').hidden = true;
  }

  // Warn when the typed name matches an existing renter, so the admin can
  // reuse that renter instead of creating a duplicate.
  $('newRenterName').addEventListener('input', function () {
    var typed = this.value.trim().toLowerCase();
    var hint = $('renterMatchHint');
    if (!typed) { hint.hidden = true; return; }
    var matches = state.renters.filter(function (r) { return r.name.trim().toLowerCase() === typed; });
    if (!matches.length) { hint.hidden = true; return; }
    hint.innerHTML = (matches.length === 1 ? 'Already a renter: ' : 'Already renters with this name: ') +
      matches.map(function (r) {
        return '<button type="button" class="a-link-btn" data-use-renter="' + r.id + '">' + esc(r.name) + '</button>';
      }).join(', ') + '.';
    hint.hidden = false;
  });
  $('renterMatchHint').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-use-renter]');
    if (!btn) return;
    $('renterSelect').value = btn.getAttribute('data-use-renter');
    toggleNewRenterFields();
  });

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
    hint.textContent = (available ? 'Slot currently open.' : 'Heads up: this slot is currently marked full.') +
      ' Price on file: ₱' + (price || 0) + '.';
  }

  // ---- swap game (ends the old rental, starts a new one on the same
  // renter/end-date so the remaining paid time carries over) ----
  function startSwap(rental) {
    if (swapLimitReached(rental)) {
      showAlert('This is a Weekly rental -- it already used its 1 included swap.');
      return;
    }
    var cooldownHours = swapCooldownHoursLeft(rental);
    if (cooldownHours > 0) {
      showAlert('This rental started less than 24 hours ago. Swap available in ' + cooldownHours + ' more hour' + (cooldownHours === 1 ? '' : 's') + '.');
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
    openNewRentalModal();
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
      .then(function (res) { if (res && res.error) throw res.error; return incrementTimesRented(newGame.id); })
      .then(function () { cancelSwap(); loadAll(); })
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
        function goToRentals() { loadAll(); document.querySelector('.a-tab[data-tab="rentals"]').click(); }
        if (isReservation) return syncReservationStatus(g.id, slot).then(goToRentals);
        goToRentals();
      });
    });
  });

  // ---- renters tab ----
  // A renter with a linked account (auth_user_id set, from migration_11's
  // signup trigger) but zero rentals is very likely a brand-new empty row
  // sitting next to that same person's real walk-in history under a
  // different renter row -- exactly the case the merge tool below exists
  // for. Surfaced as its own filter chip so the admin doesn't have to hunt.
  function renterRentals(renterId) {
    return state.rentals.filter(function (x) { return x.renter_id === renterId; });
  }
  function isMergeCandidate(r) {
    return !!r.auth_user_id && renterRentals(r.id).length === 0;
  }
  function rentersMatchFilter(r) {
    if (state.rentersFilter === 'linked') return !!r.auth_user_id;
    if (state.rentersFilter === 'needs-merge') return isMergeCandidate(r);
    return true;
  }
  function rentersMatchSearch(r) {
    var q = state.rentersSearch;
    if (!q) return true;
    var haystack = [r.name, r.messenger_name, r.public_code].join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  }
  document.querySelectorAll('#rentersFilterRow .a-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('#rentersFilterRow .a-chip').forEach(function (c) { c.classList.remove('is-active'); });
      chip.classList.add('is-active');
      state.rentersFilter = chip.getAttribute('data-filter');
      renderRenters();
    });
  });

  // Swap allowance is per plan (weekly rentals get fewer than monthly ones),
  // with the flat swap_limit as the fallback for anything unconfigured.
  function planSwapLimit(plan) {
    var st = state.settings || {};
    var v = st['swap_limit_' + String(plan || '').toLowerCase()];
    if (v === undefined || v === null || v === '') v = st.swap_limit;
    return (v === undefined || v === null || v === '') ? null : Number(v);
  }

  function renderRenters() {
    var tbody = document.querySelector('#rentersTable tbody');
    tbody.innerHTML = '';
    var candidateCount = state.renters.filter(isMergeCandidate).length;
    var hint = $('rentersMergeHint');
    if (candidateCount > 0) {
      hint.hidden = false;
      hint.textContent = candidateCount + ' renter' + (candidateCount === 1 ? '' : 's') + ' signed up for an account ' +
        'but ' + (candidateCount === 1 ? 'has' : 'have') + ' no rental history yet -- probably an existing Messenger ' +
        'customer. Check "Needs Merge Review" below and use Merge to attach their account to their real history.';
    } else {
      hint.hidden = true;
    }
    var rows = state.renters.filter(rentersMatchFilter).filter(rentersMatchSearch);
    // "Total Paid"/"Rentals"/"Active Now" are computed, not raw columns --
    // the render loop below already derives them per row for display, but
    // the generic sort mechanism needs them present *before* sorting, so
    // compute them once here too (see rentersTable's data-sort-key="_..."
    // attributes in dashboard.html).
    rows.forEach(function (r) {
      var theirRentals = renterRentals(r.id);
      r._totalPaid = theirRentals.reduce(function (sum, x) { return sum + (x.payment_status === 'paid' && !wasSwapped(x.id) ? (x.amount || 0) : 0); }, 0);
      r._rentalsCount = theirRentals.length;
      r._activeNow = theirRentals.filter(function (x) { return x.status === 'active'; }).length;
    });
    rows = sortRows('rentersTable', rows);
    $('rentersEmpty').hidden = rows.length > 0;
    $('rentersEmpty').textContent = state.renters.length ? 'No renters match this filter.' : 'No renters yet.';
    rows.forEach(function (r) {
      var theirRentals = renterRentals(r.id);
      var totalPaid = theirRentals.reduce(function (sum, x) { return sum + (x.payment_status === 'paid' && !wasSwapped(x.id) ? (x.amount || 0) : 0); }, 0);
      var activeNow = theirRentals.filter(function (x) { return x.status === 'active'; }).length;
      var tr = document.createElement('tr');
      var menuItems = '';
      if (r.messenger_url) menuItems += '<a class="a-menu-item" href="' + esc(r.messenger_url) + '" target="_blank" rel="noopener">Open Messenger</a>';
      menuItems += '<button type="button" class="a-menu-item" data-action="edit-messenger-link" data-id="' + r.id + '">' +
        (r.messenger_url ? 'Edit Messenger link' : 'Add Messenger link') + '</button>';
      menuItems += '<button type="button" class="a-menu-item" data-action="merge" data-id="' + r.id + '">Merge into another renter&hellip;</button>';
      if (r.public_code) {
        menuItems += '<button type="button" class="a-menu-item" data-copy="' + esc(welcomeLink(r.public_code)) + '">Copy welcome link</button>';
      }
      if (r.auth_user_id) {
        menuItems += '<button type="button" class="a-menu-item a-menu-item-danger" data-action="unregister" data-id="' + r.id + '">Remove account registration</button>';
      }
      if (theirRentals.length === 0) {
        menuItems += '<button type="button" class="a-menu-item a-menu-item-danger" data-action="delete-renter" data-id="' + r.id + '">Delete renter</button>';
      }
      var accountCell = r.auth_user_id
        ? '<span class="a-pill a-pill-linked" title="Has a customer-portal account">Linked</span>'
        : '—';
      tr.innerHTML = '<td>' + esc(r.name) + ' ' + messengerIcon(r.messenger_url) + '</td><td>' + esc(r.messenger_name) + '</td>' +
        '<td class="a-notes-cell" title="' + esc(r.contact_note || '') + '">' + esc(r.contact_note) + '</td><td>' + fmtDate((r.created_at || '').slice(0, 10)) + '</td>' +
        '<td>' + accountCell + '</td>' +
        '<td>' + publicCodeCell(r) + '</td>' +
        '<td>₱' + totalPaid.toLocaleString() + '</td>' +
        '<td>' + theirRentals.length + '</td>' +
        '<td>' + (activeNow ? '<span class="a-pill a-pill-active">' + activeNow + '</span>' : '—') + '</td>' +
        '<td class="a-actions-cell">' + actionsMenu(menuItems) + '</td>';
      tbody.appendChild(tr);
    });
  }

  // The onboarding page a customer lands on after the owner confirms their
  // GCash payment: it welcomes them, hands over their tracking code with a
  // copy button, explains the rules and swapping, then drops them into their
  // rentals with the code already saved. The code travels in the URL so the
  // customer never has to type it.
  function welcomeLink(code) {
    var origin = 'https://ps5-rentals.vercel.app';
    try {
      if (window.location.origin && window.location.origin.indexOf('http') === 0) origin = window.location.origin;
    } catch (err) { /* ignore -- fall back to the production origin */ }
    return origin + '/welcome/?code=' + encodeURIComponent(code);
  }

  document.querySelector('#rentersTable tbody').addEventListener('click', function (e) {
    // Unlinks the customer's portal login from this renter WITHOUT touching
    // their rental history. Deleting the auth.users row itself needs the
    // service-role key, which this browser app deliberately does not have --
    // so the confirm text tells the owner where to finish the job.
    var unregBtn = e.target.closest('button[data-action="unregister"]');
    if (unregBtn) {
      var uid = Number(unregBtn.getAttribute('data-id'));
      var ur = state.renters.filter(function (r) { return r.id === uid; })[0];
      if (!ur) return;
      showConfirm(
        'Remove the account registration for ' + ur.name + '?\n\n' +
        'Their rentals, history and tracking code all stay exactly as they are -- ' +
        'only the email login stops being attached to this renter.\n\n' +
        'If they sign up again with the same email they will get a NEW, empty renter ' +
        'row, so use Merge afterwards if that happens. To free the email address ' +
        'entirely, also delete the user in Supabase: Authentication -> Users.',
        { okLabel: 'Remove', danger: true }
      ).then(function (ok) {
        if (!ok) return;
        supabase.from('renters').update({ auth_user_id: null }).eq('id', uid).then(function (res) {
          if (res.error) { showAlert(res.error.message); return; }
          loadAll();
        });
      });
      return;
    }

    // Only offered when the renter has zero rentals -- the FK on rentals is
    // `on delete restrict`, so a delete with history would fail at the DB
    // anyway. Checked again here in case the list is stale.
    var delBtn = e.target.closest('button[data-action="delete-renter"]');
    if (delBtn) {
      var did = Number(delBtn.getAttribute('data-id'));
      var dr = state.renters.filter(function (r) { return r.id === did; })[0];
      if (!dr) return;
      if (renterRentals(did).length) {
        showAlert('This renter has rentals, so they cannot be deleted. Merge them into another renter instead.');
        return;
      }
      showConfirm('Permanently delete the renter "' + dr.name + '"? This cannot be undone.', { okLabel: 'Delete', danger: true }).then(function (ok) {
        if (!ok) return;
        supabase.from('renters').delete().eq('id', did).then(function (res) {
          if (res.error) { showAlert(res.error.message); return; }
          loadAll();
        });
      });
      return;
    }

    var editBtn = e.target.closest('button[data-action="edit-messenger-link"]');
    if (editBtn) {
      var id = Number(editBtn.getAttribute('data-id'));
      var renter = state.renters.filter(function (r) { return r.id === id; })[0];
      if (!renter) return;
      showPrompt(
        'Messenger conversation link for ' + renter.name + ' (paste the URL from your address bar while viewing their thread in Messenger/Business Suite):',
        { defaultValue: renter.messenger_url || 'https://www.facebook.com/messages/t/' }
      ).then(function (input) {
        if (input === null) return;
        supabase.from('renters').update({ messenger_url: input.trim() || null }).eq('id', id).then(function (res) {
          if (res.error) { showAlert(res.error.message); return; }
          loadAll();
        });
      });
      return;
    }
    var mergeBtn = e.target.closest('button[data-action="merge"]');
    if (mergeBtn) {
      var renterId = Number(mergeBtn.getAttribute('data-id'));
      var renterToMerge = state.renters.filter(function (r) { return r.id === renterId; })[0];
      if (renterToMerge) openMergeModal(renterToMerge);
    }
  });

  // ---- merge renters (see supabase/migration_11_renter_claiming.sql for
  // merge_renters()'s server-side semantics and why it's structured this
  // way) ----
  function mergeTargetLabel(r) {
    var count = renterRentals(r.id).length;
    return r.name + (r.auth_user_id ? ' (linked account)' : '') + ' -- ' + count + ' rental' + (count === 1 ? '' : 's');
  }
  function openMergeModal(renter) {
    state.mergeRemoveId = renter.id;
    $('mergeRemoveName').value = renter.name;
    var options = state.renters
      .filter(function (r) { return r.id !== renter.id; })
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (r) { return '<option value="' + r.id + '">' + esc(mergeTargetLabel(r)) + '</option>'; })
      .join('');
    $('mergeKeepSelect').innerHTML = options || '<option value="">No other renters exist</option>';
    $('mergeError').textContent = '';
    updateMergePreview();
    $('mergeBackdrop').hidden = false;
    $('mergeModal').hidden = false;
  }
  function closeMergeModal() {
    state.mergeRemoveId = null;
    $('mergeBackdrop').hidden = true;
    $('mergeModal').hidden = true;
  }
  function updateMergePreview() {
    var removeId = state.mergeRemoveId;
    var keepId = Number($('mergeKeepSelect').value);
    var preview = $('mergePreview');
    var removeRenter = state.renters.filter(function (r) { return r.id === removeId; })[0];
    var keepRenter = state.renters.filter(function (r) { return r.id === keepId; })[0];
    if (!removeRenter || !keepRenter) { preview.textContent = ''; return; }
    var movedCount = renterRentals(removeId).length;
    var lines = [];
    if (movedCount > 0) lines.push(movedCount + ' rental' + (movedCount === 1 ? '' : 's') + ' will move to ' + keepRenter.name + '.');
    if (removeRenter.auth_user_id && !keepRenter.auth_user_id) {
      lines.push(keepRenter.name + ' will gain the linked customer-portal account; "' + removeRenter.name + '" is deleted.');
    } else if (removeRenter.auth_user_id && keepRenter.auth_user_id && removeRenter.auth_user_id !== keepRenter.auth_user_id) {
      lines.push('Both renters have a different linked account -- this merge will be refused. Resolve manually.');
    } else {
      lines.push('"' + removeRenter.name + '" will be deleted after the merge.');
    }
    preview.textContent = lines.join(' ');
  }
  $('mergeKeepSelect').addEventListener('change', updateMergePreview);
  $('closeMergeModalBtn').addEventListener('click', closeMergeModal);
  $('mergeBackdrop').addEventListener('click', closeMergeModal);
  $('mergeConfirmBtn').addEventListener('click', function () {
    var removeId = state.mergeRemoveId;
    var keepId = Number($('mergeKeepSelect').value);
    $('mergeError').textContent = '';
    if (!removeId || !keepId) { $('mergeError').textContent = 'Pick a renter to merge into.'; return; }
    var btn = $('mergeConfirmBtn');
    btn.disabled = true;
    supabase.rpc('merge_renters', { keep_id: keepId, remove_id: removeId }).then(function (res) {
      btn.disabled = false;
      if (res.error) { $('mergeError').textContent = res.error.message; return; }
      closeMergeModal();
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
      closeAddRenterModal();
      loadAll();
    });
  });

  // ---- games tab ----
  // Display label for a reservation-status/available enum value -- the
  // underlying value (stored + compared elsewhere) stays the DB's
  // upper/underscored form (e.g. "PRIORITY_LIST"); only what's shown in the
  // <option> text is turned into a normal-case label ("Priority list").
  function enumLabel(o) {
    var s = String(o).toLowerCase().replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function slotControlHtml(g, slot) {
    if (g.status === 'upcoming') {
      var val = g[slot + '_reservation_status'];
      var opts = ['OPEN', 'LIMITED', 'PRIORITY_LIST', 'CLOSED'];
      return '<select class="a-inline-select" data-game="' + g.id + '" data-slot="' + slot + '" data-field="reservation">' +
        opts.map(function (o) { return '<option value="' + o + '"' + (o === val ? ' selected' : '') + '>' + enumLabel(o) + '</option>'; }).join('') +
        '</select>';
    }
    var avail = g[slot + '_available'];
    return '<select class="a-inline-select" data-game="' + g.id + '" data-slot="' + slot + '" data-field="available">' +
      '<option value="true"' + (avail ? ' selected' : '') + '>Available</option>' +
      '<option value="false"' + (!avail ? ' selected' : '') + '>Full</option>' +
      '</select>';
  }

  function renderGames() {
    var tbody = document.querySelector('#gamesTable tbody');
    var q = ($('gamesSearch') && $('gamesSearch').value || '').trim().toLowerCase();
    var games = q ? state.games.filter(function (g) { return g.title.toLowerCase().indexOf(q) !== -1; }) : state.games.slice();
    games = sortRows('gamesTable', games);
    tbody.innerHTML = '';
    games.forEach(function (g) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(g.title) + '</td><td>' + (g.status === 'upcoming' ? 'Pre-Reserve' : 'Available') + '</td>' +
        '<td>' + slotControlHtml(g, 'trophy') + '</td>' +
        '<td>' + slotControlHtml(g, 'nontrophy') + '</td>' +
        '<td>' + (g.times_rented || 0) + '</td>';
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
      if (res.error) showAlert(res.error.message);
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
        closeAddGameModal();
        loadAll();
      }).catch(function (err) {
        $('addGameError').textContent = err.message || 'Failed to add game.';
      }).then(function () { btn.disabled = false; });
    });
  }

  // ---- settings tab (migration_14 -- `settings` key/value table driving
  // the customer-facing payment screen). Table may not exist yet;
  // state.settingsAvailable is set in loadAll() from res.error, so a
  // missing table shows a plain hint instead of an empty/broken form. ----
  function renderSettings() {
    var hint = $('settingsMigrationHint');
    var form = $('settingsForm');
    if (!state.settingsAvailable) {
      hint.hidden = false;
      form.style.display = 'none';
      return;
    }
    hint.hidden = true;
    form.style.display = '';
    $('settingsSavedHint').hidden = true;
    $('setGcashNumber').value = state.settings.gcash_number || '';
    $('setGcashName').value = state.settings.gcash_name || '';
    $('setMessengerUrl').value = state.settings.messenger_url || '';
    $('setHoldMinutes').value = state.settings.hold_minutes || '';
    $('setSwapLimit').value = state.settings.swap_limit || '';
    $('setSwapLimitWeekly').value = state.settings.swap_limit_weekly || '';
    $('setSwapLimitMonthly').value = state.settings.swap_limit_monthly || '';
  }
  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('settingsError').textContent = '';
    $('settingsSavedHint').hidden = true;
    // gcash_number/gcash_name here are exactly what get_public_settings()
    // hands the public site to show every customer on the payment screen
    // -- a typo here is a typo on every rental until the next save.
    var rows = [
      { key: 'gcash_number', value: $('setGcashNumber').value.trim() },
      { key: 'gcash_name', value: $('setGcashName').value.trim() },
      { key: 'messenger_url', value: $('setMessengerUrl').value.trim() },
      { key: 'hold_minutes', value: String(Number($('setHoldMinutes').value) || 30) },
      { key: 'swap_limit', value: String(Number($('setSwapLimit').value) || 2) },
      { key: 'swap_limit_weekly', value: String(Number($('setSwapLimitWeekly').value) || 1) },
      { key: 'swap_limit_monthly', value: String(Number($('setSwapLimitMonthly').value) || 3) }
    ];
    var btn = $('saveSettingsBtn');
    btn.disabled = true;
    supabase.from('settings').upsert(rows, { onConflict: 'key' }).then(function (res) {
      btn.disabled = false;
      if (res.error) { $('settingsError').textContent = res.error.message; return; }
      $('settingsSavedHint').hidden = false;
      loadAll();
    });
  });

  // ---- generic table chrome: column resize + click-to-sort, shared by all
  // nine .a-table tables (see the owner's request: "you can adjust column
  // widths of tables and click table headers to sort"). One mechanism for
  // both, wired once per table at boot in initTableEnhancements() below,
  // instead of a bespoke implementation per table. ----

  // getSortValue supports a dot-path (e.g. "games.title", "renters.name")
  // for the tables built from state.rentals -- those rows come back
  // embedded as `{...rental, games: {...}, renters: {...}}` from
  // loadAll()'s `select('*, games(*), renters(*))` -- as well as a plain
  // top-level property. One getter covers every table instead of a
  // one-off lookup per column.
  function getSortValue(row, key) {
    var parts = key.split('.');
    var v = row;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return null;
      v = v[parts[i]];
    }
    return v;
  }
  // One comparator for every column type actually present across these
  // tables: numbers (amount, queue_position, times_rented -- already
  // numbers coming back from Supabase), ISO date/timestamp strings
  // (start_date/end_date/created_at/hold_expires_at -- sort correctly as
  // plain strings since they're fixed-format and big-endian), plain text
  // (titles/names/ref codes), and the odd boolean-ish column (e.g.
  // renters.auth_user_id is either a uuid string or null -- the null
  // handling below just puts "not linked" rows first ascending, which
  // reads fine for a linked/unlinked column).
  function compareSortValues(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      return (a ? 1 : 0) - (b ? 1 : 0);
    }
    var na = typeof a === 'number' ? a : (a !== '' && !isNaN(Number(a)) ? Number(a) : null);
    var nb = typeof b === 'number' ? b : (b !== '' && !isNaN(Number(b)) ? Number(b) : null);
    if (na != null && nb != null) return na - nb;
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }
  // Sorts a fresh copy of `rows` per state.tableSort[tableId] (set by
  // wireTableSort's click handler below) -- called from inside each
  // table's own render*() function, right before it turns the filtered/
  // searched array into <tr> markup. Returns `rows` untouched when nothing
  // has been clicked yet, so the existing default ordering (newest-first,
  // queue order, etc.) is unaffected until the admin actually clicks a
  // header -- and since every render*() calls this every time it runs
  // (including from the 5s poll and from search/filter changes), the sort
  // survives a re-render instead of being a one-time DOM reorder.
  function sortRows(tableId, rows) {
    var sort = state.tableSort[tableId];
    if (!sort) return rows;
    return rows.slice().sort(function (a, b) {
      var cmp = compareSortValues(getSortValue(a, sort.key), getSortValue(b, sort.key));
      return sort.dir === 'desc' ? -cmp : cmp;
    });
  }

  // Adds one small draggable handle to the right edge of every <th> in
  // `table`, then locks the table into table-layout:fixed with each
  // column's current rendered width applied via an explicit <colgroup>
  // (one <col> per header cell), so dragging a handle resizes just that
  // column instead of fighting the browser's content-based auto layout.
  // A <colgroup> is used rather than a width on the <th>/<td> cells
  // themselves -- with table.a-table's own `width:100%`, a fixed layout
  // that only widens ONE column's cells still gets rescaled by the browser
  // to keep the table at exactly 100%, visibly squeezing every other
  // column.
  //
  // Letting the *table* fall back to `width:auto` (see .a-table-resizable
  // in admin.css) is NOT enough to stop that on its own: a <table> is a
  // block-level box, and `width:auto` in normal flow resolves via
  // shrink-to-fit, i.e. min(content-width, *available* width) -- and
  // "available width" here is .a-table-wrap's own box, not "however wide
  // the content wants to scroll to", so the table still gets clamped back
  // to the wrapper's width and every column gets rescaled right back to
  // fit, even with .a-table-wrap{overflow-x:auto} allowed to scroll.
  // Explicitly setting the table's own `width` (in updateTableWidth()
  // below) to the sum of its column widths sidesteps shrink-to-fit
  // entirely, so growing one column past the wrapper's width correctly
  // spills into that existing scroll area instead of squeezing its
  // neighbors. Per-session only (no localStorage) -- a fresh page load
  // goes back to the CSS defaults.
  function updateTableWidth(table, cols) {
    var total = 0;
    Array.prototype.forEach.call(cols, function (col) { total += parseFloat(col.style.width) || 0; });
    table.style.width = total + 'px';
  }
  function makeTableResizable(table) {
    if (!table || table._resizableInit) return;
    table._resizableInit = true;
    // initTableEnhancements() wires up all nine tables at boot, but only
    // one tab's .a-panel is .is-active (display:block) at a time -- every
    // other table's th.offsetWidth would read 0 (a hidden ancestor gives
    // every descendant zero layout size), locking in unusably-collapsed
    // columns forever. Briefly force this table's panel visible to
    // measure its real auto-layout widths, then put visibility back
    // exactly as it was -- synchronous, so nothing actually paints in
    // between and the admin never sees the flash.
    var panel = table.closest('.a-panel');
    var wasActive = panel && panel.classList.contains('is-active');
    if (panel && !wasActive) panel.classList.add('is-active');
    var ths = table.querySelectorAll('thead th');
    var colgroup = document.createElement('colgroup');
    var cols = [];
    Array.prototype.forEach.call(ths, function (th) {
      // Lock in today's rendered (auto-layout) width as each column's
      // starting point *before* switching to table-layout:fixed below, so
      // columns don't all jump to some other distribution the instant
      // this runs. BUT: auto-layout only widens a column to fit whatever
      // rows exist *right now* -- if this table's very first load happens
      // to have zero rows (e.g. no pending payments yet), an empty header
      // like the actions column's measures near-zero and that width gets
      // baked in forever (_resizableInit below means this only ever runs
      // once). data-min-width on a <th> (set in dashboard.html for the 5
      // actions columns, sized to what their real buttons/menu need) is a
      // floor under that measurement so a table that starts empty doesn't
      // end up with an unusably-squeezed actions column the first time a
      // real row actually appears in it.
      var col = document.createElement('col');
      var minWidth = parseInt(th.getAttribute('data-min-width'), 10) || 0;
      col.style.width = Math.max(th.offsetWidth, minWidth) + 'px';
      colgroup.appendChild(col);
      cols.push(col);
    });
    table.insertBefore(colgroup, table.firstChild);
    table.classList.add('a-table-resizable');
    updateTableWidth(table, cols);
    if (panel && !wasActive) panel.classList.remove('is-active');
    Array.prototype.forEach.call(ths, function (th, i) {
      var col = cols[i];
      var handle = document.createElement('span');
      handle.className = 'a-col-resize-handle';
      handle.addEventListener('mousedown', function (e) {
        var startX = e.clientX;
        var startWidth = th.offsetWidth;
        document.body.classList.add('a-col-resizing');
        function onMove(ev) {
          var next = startWidth + (ev.clientX - startX);
          if (next < 40) next = 40; // never let a column collapse to zero/negative
          col.style.width = next + 'px';
          updateTableWidth(table, cols);
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('a-col-resizing');
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        // Never let a mousedown/click that starts on the handle bubble up
        // to the th's own click listener (wired by wireTableSort below) --
        // resizing must never also trigger a sort, even for a plain click
        // on the handle with no drag.
        e.preventDefault();
        e.stopPropagation();
      });
      handle.addEventListener('click', function (e) { e.stopPropagation(); });
      th.appendChild(handle);
    });
  }

  // Wires click-to-sort onto every `th[data-sort-key]` in `table` -- the
  // key names the exact property (or "a.b" dot-path) on that table's row
  // objects to sort by, set in the markup (dashboard.html), since header
  // text alone doesn't say which field it maps to. Ascending on first
  // click, descending on a second click of the same header, ascending
  // again after clicking a different header. `renderFn` is that table's
  // own existing render*() function -- re-invoking it is what actually
  // re-sorts the visible rows, since render*() reads state.tableSort via
  // sortRows() every time it runs.
  function wireTableSort(table, tableId, renderFn) {
    if (!table || table._sortInit) return;
    table._sortInit = true;
    var ths = table.querySelectorAll('thead th[data-sort-key]');
    Array.prototype.forEach.call(ths, function (th) {
      th.classList.add('a-sortable-th');
      th.setAttribute('title', 'Click to sort');
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort-key');
        var current = state.tableSort[tableId];
        var dir = (current && current.key === key && current.dir === 'asc') ? 'desc' : 'asc';
        state.tableSort[tableId] = { key: key, dir: dir };
        Array.prototype.forEach.call(ths, function (other) { other.classList.remove('a-sort-asc', 'a-sort-desc'); });
        th.classList.add(dir === 'asc' ? 'a-sort-asc' : 'a-sort-desc');
        renderFn();
      });
    });
  }

  // Table ids paired with their own existing render*() function --
  // "Trophy"/"Non-Trophy" on #gamesTable are deliberately left out of
  // their <th> (no data-sort-key in dashboard.html) since they render an
  // interactive <select> whose meaning flips between an availability
  // boolean and a reservation-status enum depending on the game's status,
  // so there's no single consistent value to sort by; every purely
  // actions-only trailing column (the blank <th></th> on several tables)
  // is skipped the same way, automatically, since wireTableSort() only
  // looks at th[data-sort-key].
  var SORTABLE_TABLES = [
    { id: 'pendingTable', render: renderPending },
    { id: 'swapsTable', render: renderSwaps },
    { id: 'endingSoonTable', render: renderOverview },
    { id: 'mostRentedTable', render: renderOverview },
    { id: 'rentalsTable', render: renderRentals },
    { id: 'reservationsTable', render: renderReservations },
    { id: 'historyTable', render: renderHistory },
    { id: 'rentersTable', render: renderRenters },
    { id: 'gamesTable', render: renderGames }
  ];
  function initTableEnhancements() {
    SORTABLE_TABLES.forEach(function (t) {
      var table = document.getElementById(t.id);
      if (!table) return;
      makeTableResizable(table);
      wireTableSort(table, t.id, t.render);
    });
  }

  // ---- boot ----
  // Ticks every live-updating on-screen clock: the topbar's "Updated Xs
  // ago" text, plus the Pending Payments / Swap Requests "waiting" and
  // "hold" countdown cells -- same setInterval(_, 1000) pattern the
  // topbar already used, just driving more cells now.
  function tickLiveClocks() {
    updateLiveText();
    updateLiveCountdownCells('#pendingTable');
    updateLiveCountdownCells('#swapsTable');
  }
  window.rcRequireAuth().then(function (session) {
    if (!session) return;
    $('whoami').textContent = session.user.email;
    $('userAvatar').textContent = session.user.email.charAt(0).toUpperCase();
    // setTopbarSection() was previously only ever called from the tab-click
    // listener, so the topbar title/help sat on their static HTML defaults
    // ("Overview") until the admin clicked *something*, even though Pending
    // Payments (not Overview) is the actually-visible panel on first load.
    // Sync it once here to whatever tab starts .is-active instead.
    setTopbarSection(document.querySelector('.a-tab.is-active').getAttribute('data-tab'));
    // Wire up column resize + click-to-sort only after the first load has
    // populated every table with real rows -- capturing each column's
    // starting width (see makeTableResizable()) off an empty <tbody> would
    // lock in widths based on header text alone.
    loadAll().then(initTableEnhancements);
    // Incoming requests (and everything else) come from customers using the
    // public site in real time -- poll instead of requiring a manual refresh
    // to notice a new one.
    setInterval(loadAll, 5000);
    setInterval(tickLiveClocks, 1000);
  });
})();
