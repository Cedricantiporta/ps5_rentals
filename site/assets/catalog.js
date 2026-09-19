(function () {
  'use strict';

  var DATA_URL = '/data/games.json';
  var MESSENGER_URL = 'https://m.me/junedigitalaccess';
  var POPULAR_MIN = 5;
  var HIGH_DEMAND_MIN = 10;
  var PAGE_SIZE = 20;

  var state = { games: [], query: '', quickFilter: 'available', genre: '', sort: 'default', modalGame: null, plan: 'weekly', slot: null, page: 1, step: 'intent', intent: 'new', overlayStack: [], modalStepDepth: 0, hold: null, holdError: null };

  var THEME_KEY = 'rc-theme';
  function getSavedTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; }
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    var btn = document.getElementById('rcThemeToggle');
    if (btn) btn.classList.toggle('is-light', theme === 'light');
  }
  applyTheme(getSavedTheme());

  var OVERLAY_CLOSERS = {};

  // Every overlay (rental modal, share card, rental rules, mobile drawer)
  // registers itself here so the browser Back button closes whichever one
  // is on top instead of leaving the page -- each open pushes a history
  // entry, and popping it (Back, or our own requestCloseOverlay) closes it.
  function openOverlay(name, closeFn, url, extraState) {
    OVERLAY_CLOSERS[name] = closeFn;
    state.overlayStack.push(name);
    var st = { rcOverlay: name };
    if (extraState) for (var k in extraState) st[k] = extraState[k];
    try { window.history.pushState(st, '', url); } catch (e) {}
  }

  function closeOverlayByName(name) {
    var idx = state.overlayStack.lastIndexOf(name);
    if (idx !== -1) state.overlayStack.splice(idx, 1);
    var fn = OVERLAY_CLOSERS[name];
    if (fn) fn();
  }

  function requestCloseOverlay(name) {
    if (window.history.state && window.history.state.rcOverlay === name) {
      window.history.back();
    } else {
      closeOverlayByName(name);
    }
  }

  function pushStepState() {
    state.modalStepDepth++;
    try { window.history.pushState({ rcOverlay: 'modal', rcStep: state.step }, ''); } catch (e) {}
  }

  // Explicit close (X button, backdrop click, Escape) should always fully
  // close the wizard, never just step back one screen -- but each step
  // change also pushes a history entry tagged rcOverlay:'modal', so a
  // plain history.back() (requestCloseOverlay's normal behavior) would
  // only undo the most recent step instead of leaving the modal. Jump back
  // past every step pushed this session in one go instead.
  function hardCloseOverlay(name) {
    if (name === 'modal' && window.history.state && window.history.state.rcOverlay === 'modal') {
      window.history.go(-(1 + state.modalStepDepth));
    } else {
      requestCloseOverlay(name);
    }
  }

  function wireOverlayHistory() {
    window.addEventListener('popstate', function (e) {
      var s = e.state;
      var top = state.overlayStack[state.overlayStack.length - 1];
      if (top === 'modal' && s && s.rcOverlay === 'modal' && s.rcStep) {
        state.step = s.rcStep;
        renderModal();
        return;
      }
      if (top) closeOverlayByName(top);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var top = state.overlayStack[state.overlayStack.length - 1];
      if (top === 'modal') hardCloseOverlay(top);
      else if (top) requestCloseOverlay(top);
    });
  }

  var ICON_PATHS = {
    trophy: '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'
  };
  function icon(name, cls) {
    var paths = ICON_PATHS[name] || '';
    return '<svg class="rc-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  function peso(n) { return (n === null || n === undefined || isNaN(n)) ? '—' : '₱' + Number(n).toLocaleString('en-PH'); }

  function platformBadge(platform) {
    var parts = String(platform || 'PS5').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 2) {
      return '<span class="rc-plat-badge"><span class="rc-plat-seg rc-plat-primary rc-plat-solo">' + parts[0] + '</span></span>';
    }
    return '<span class="rc-plat-badge">' +
      '<span class="rc-plat-seg rc-plat-primary">' + parts[0] + '</span>' +
      '<span class="rc-plat-seg rc-plat-secondary">' + parts[1] + '</span>' +
    '</span>';
  }

  function normalize(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function badgeFor(g) {
    if (g.status === 'upcoming') return { label: 'PRE-RESERVE', cls: 'rc-badge-upcoming' };
    var t = g.trophy.available, n = g.nontrophy.available;
    if (!t && !n) return { label: 'FULLY RENTED', cls: 'rc-badge-waitlist' };
    // Exactly one slot full used to show a "RENTED" pill on the grid card --
    // removed per owner request (card real estate); FULLY RENTED/HIGH
    // DEMAND/POPULAR/PRE-RESERVE below are unaffected and still show.
    if (!t || !n) return null;
    if (g.activeRentals >= HIGH_DEMAND_MIN) return { label: 'HIGH DEMAND', cls: 'rc-badge-demand' };
    if (g.activeRentals >= POPULAR_MIN) return { label: 'POPULAR', cls: 'rc-badge-popular' };
    return null;
  }

  function reservationInfo(status) {
    switch (status) {
      case 'OPEN': return { label: 'OPEN', cls: 'rc-status-open' };
      case 'LIMITED': return { label: 'LIMITED', cls: 'rc-status-limited' };
      case 'PRIORITY_LIST': return { label: 'PRIORITY LIST', cls: 'rc-status-priority' };
      default: return { label: 'CLOSED', cls: 'rc-status-closed' };
    }
  }

  function daysUntilDate(iso) {
    if (!iso) return null;
    var target = new Date(iso + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  // Real hours remaining until the END of today (the next local midnight),
  // used only for the final day (daysUntilDate === 0, i.e. availableAt is
  // today) so the countdown can show "18H LEFT" instead of a static
  // "FREE SOON" for the whole last day regardless of what time it is right
  // now. availableAt being "today" means today is still the last unavailable
  // day, so the relevant deadline is midnight tonight, not midnight this
  // morning (which has already passed).
  function hoursUntilMidnight() {
    var next = new Date();
    next.setHours(24, 0, 0, 0);
    return (next - new Date()) / 3600000;
  }

  function availInfo(available, availableAt) {
    if (available) return { label: 'AVAILABLE', cls: 'rc-status-available' };
    var days = daysUntilDate(availableAt);
    if (days === null) return { label: 'FULL', cls: 'rc-status-full' };
    if (days < 0) return { label: 'FREE SOON', cls: 'rc-status-full' };
    if (days === 0) {
      var hours = Math.ceil(hoursUntilMidnight());
      if (hours <= 0) return { label: 'FREE SOON', cls: 'rc-status-full' };
      return { label: hours + 'H LEFT', cls: 'rc-status-full' };
    }
    return { label: days + 'D LEFT', cls: 'rc-status-full' };
  }

  function releaseDateLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function matchesQuery(g, q) {
    if (!q) return true;
    return normalize(g.title).indexOf(normalize(q)) !== -1;
  }

  function matchesQuickFilter(g, filter) {
    switch (filter) {
      case 'available': return g.status === 'available' && (g.trophy.available || g.nontrophy.available);
      case 'upcoming': return g.status === 'upcoming';
      case 'trophy': return g.status === 'available' && g.trophy.available;
      case 'nontrophy': return g.status === 'available' && g.nontrophy.available;
      case 'popular': return g.activeRentals >= POPULAR_MIN;
      default: return true;
    }
  }

  function filteredSortedGames() {
    var list = state.games.filter(function (g) {
      return matchesQuery(g, state.query) && matchesQuickFilter(g, state.quickFilter) &&
        (!state.genre || g.genre.indexOf(state.genre) !== -1);
    });
    list.sort(function (a, b) {
      switch (state.sort) {
        case 'title': return a.title.localeCompare(b.title);
        case 'price-low': return (a.trophy.weekly || 9e9) - (b.trophy.weekly || 9e9);
        case 'price-high': return (b.trophy.weekly || 0) - (a.trophy.weekly || 0);
        case 'rentals': return b.activeRentals - a.activeRentals;
        default: return a.id - b.id;
      }
    });
    return list;
  }

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function updateStripEdges() {
    var wrap = document.querySelector('.rc-strip-wrap');
    var track = document.getElementById('rcComingSoonTrack');
    if (!wrap || !track) return;
    var maxScroll = track.scrollWidth - track.clientWidth;
    var EDGE_BUFFER = 24;
    var atStart = track.scrollLeft <= EDGE_BUFFER;
    var atEnd = track.scrollLeft >= maxScroll - EDGE_BUFFER;
    wrap.classList.toggle('can-scroll-left', !atStart && maxScroll > 0);
    wrap.classList.toggle('can-scroll-right', !atEnd && maxScroll > 0);
  }

  function renderComingSoon() {
    var track = document.getElementById('rcComingSoonTrack');
    var section = document.getElementById('rcComingSoonSection');
    if (!track || !section) return; // no coming-soon strip on this page
    var upcoming = state.games.filter(function (g) { return g.status === 'upcoming'; })
      .sort(function (a, b) { return a.upcomingOrder - b.upcomingOrder; });
    if (!upcoming.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    track.innerHTML = upcoming.map(function (g) {
      var t = reservationInfo(g.trophy.reservationStatus);
      var n = reservationInfo(g.nontrophy.reservationStatus);
      return '' +
        '<div class="rc-soon-card" data-slug="' + g.slug + '">' +
          '<div class="rc-card-cover-wrap">' +
            '<span class="rc-badge rc-badge-upcoming">Pre-Reserve</span>' +
            '<img class="rc-soon-cover" loading="lazy" src="' + (g.cover || '') + '" alt="' + g.title + '"/>' +
          '</div>' +
          '<div class="rc-soon-body">' +
            '<div class="rc-card-top">' +
              '<p class="rc-soon-title">' + g.title + '</p>' +
              platformBadge(g.platform) +
              '<p class="rc-soon-date">Release: ' + releaseDateLabel(g.releaseDate) + '</p>' +
            '</div>' +
            '<div class="rc-card-bottom">' +
              '<div class="rc-slot-row"><span class="rc-slot-label">Trophy</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
              '<div class="rc-slot-row"><span class="rc-slot-label">Non-Trophy</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
              '<div class="rc-soon-prices"><span>Wk <b>' + peso(g.trophy.weekly) + '</b></span><span>Mo <b>' + peso(g.trophy.monthly) + '</b></span></div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(track.children, function (card) {
      card.addEventListener('click', function () { openModal(card.getAttribute('data-slug')); });
    });
    track.scrollLeft = 0;
    updateStripEdges();
  }

  function renderGrid() {
    var grid = document.getElementById('rcGrid');
    var empty = document.getElementById('rcEmpty');
    var countEl = document.getElementById('rcCount');
    if (!grid || !empty || !countEl) return; // no catalog grid on this page
    var allGames = filteredSortedGames();
    countEl.textContent = allGames.length;
    if (!allGames.length) {
      grid.innerHTML = '';
      empty.style.display = '';
      renderPagination(0);
      return;
    }
    empty.style.display = 'none';

    var totalPages = Math.max(1, Math.ceil(allGames.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    var start = (state.page - 1) * PAGE_SIZE;
    var games = allGames.slice(start, start + PAGE_SIZE);

    grid.innerHTML = games.map(function (g) {
      var badge = badgeFor(g);
      var t = availInfo(g.trophy.available, g.trophy.availableAt);
      var n = availInfo(g.nontrophy.available, g.nontrophy.availableAt);
      return '' +
        '<div class="rc-card" data-slug="' + g.slug + '">' +
          '<div class="rc-card-cover-wrap">' +
            (badge ? '<span class="rc-badge ' + badge.cls + '">' + badge.label + '</span>' : '') +
            '<img class="rc-card-cover" loading="lazy" src="' + (g.cover || '') + '" alt="' + g.title + '"/>' +
            (g.genre[0] ? '<span class="rc-card-cover-genre">' + g.genre[0] + '</span>' : '') +
            '<span class="rc-card-cover-plat">' + platformBadge(g.platform) + '</span>' +
          '</div>' +
          '<div class="rc-card-body">' +
            '<div class="rc-card-top">' +
              '<p class="rc-card-title">' + g.title + '</p>' +
            '</div>' +
            '<div class="rc-card-bottom">' +
              '<div class="rc-slot-row"><span class="rc-slot-label">' + icon('trophy') + ' Trophy</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
              '<div class="rc-slot-row"><span class="rc-slot-label">' + icon('user') + ' Non-Trophy</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
              '<div class="rc-price-row">' +
                '<div class="rc-price-box"><span class="rc-price-label">Weekly</span><span class="rc-price-value">' + peso(g.trophy.weekly) + '</span></div>' +
                '<div class="rc-price-box"><span class="rc-price-label">Monthly</span><span class="rc-price-value">' + peso(g.trophy.monthly) + '</span></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(grid.children, function (card) {
      card.addEventListener('click', function () { openModal(card.getAttribute('data-slug')); });
    });
    renderPagination(totalPages);
  }

  function goToPage(p) {
    state.page = p;
    renderGrid();
    var grid = document.getElementById('rcGrid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderPagination(totalPages) {
    var el = document.getElementById('rcPagination');
    if (!el) return;
    if (totalPages <= 1) { el.innerHTML = ''; return; }
    var page = state.page;
    var buttons = [];
    buttons.push('<button type="button" class="rc-page-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">' + icon('chevron-left') + '</button>');

    var windowSize = 5;
    var startPage = Math.max(1, page - Math.floor(windowSize / 2));
    var endPage = Math.min(totalPages, startPage + windowSize - 1);
    startPage = Math.max(1, endPage - windowSize + 1);

    if (startPage > 1) {
      buttons.push('<button type="button" class="rc-page-btn" data-page="1">1</button>');
      if (startPage > 2) buttons.push('<span class="rc-page-ellipsis">…</span>');
    }
    for (var p = startPage; p <= endPage; p++) {
      buttons.push('<button type="button" class="rc-page-btn' + (p === page ? ' is-active' : '') + '" data-page="' + p + '">' + p + '</button>');
    }
    if (endPage < totalPages) {
      if (endPage < totalPages - 1) buttons.push('<span class="rc-page-ellipsis">…</span>');
      buttons.push('<button type="button" class="rc-page-btn" data-page="' + totalPages + '">' + totalPages + '</button>');
    }
    buttons.push('<button type="button" class="rc-page-btn" data-page="' + (page + 1) + '"' + (page >= totalPages ? ' disabled' : '') + ' aria-label="Next page">' + icon('chevron-right') + '</button>');

    el.innerHTML = buttons.join('');
    Array.prototype.forEach.call(el.querySelectorAll('.rc-page-btn:not([disabled])'), function (btn) {
      btn.addEventListener('click', function () { goToPage(Number(btn.getAttribute('data-page'))); });
    });
  }

  function populateGenres() {
    var select = document.getElementById('rcGenre');
    if (!select) return; // no catalog toolbar on this page (e.g. how-it-works, account, game detail)
    var set = {};
    state.games.forEach(function (g) { g.genre.forEach(function (x) { set[x] = true; }); });
    Object.keys(set).sort().forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g; opt.textContent = g;
      select.appendChild(opt);
    });
  }

  function findGame(slug) {
    return state.games.filter(function (g) { return g.slug === slug; })[0];
  }

  function slotEnabled(g, slotKey) {
    var slot = g[slotKey];
    if (g.status === 'upcoming') return slot.reservationStatus !== 'CLOSED';
    return slot.available;
  }

  function openModal(slug, pushHistory) {
    var g = findGame(slug);
    if (!g) return;
    loadPublicSettings();
    state.modalGame = g;
    state.plan = 'weekly';
    state.slot = null;
    state.hold = null;
    state.holdError = null;
    state.intent = 'new';
    state.step = (g.status === 'upcoming') ? 'plan' : 'intent';
    renderModal();
    document.getElementById('rcModalOverlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
    state.modalStepDepth = 0;
    if (pushHistory !== false) {
      openOverlay('modal', closeModal, window.location.pathname + '?game=' + slug, { rcStep: state.step });
    } else {
      OVERLAY_CLOSERS.modal = closeModal;
      state.overlayStack.push('modal');
    }
  }

  function closeModal() {
    document.getElementById('rcModalOverlay').classList.remove('is-open');
    document.body.style.overflow = '';
    clearHoldCountdown();
  }

  function slotLabel(g, slotKey) {
    return g.status === 'upcoming' ? reservationInfo(g[slotKey].reservationStatus) : availInfo(g[slotKey].available, g[slotKey].availableAt);
  }

  function messengerLink(g, text) {
    return MESSENGER_URL + '?text=' + encodeURIComponent(text);
  }

  var publicSupabase = null;
  function getPublicSupabase() {
    if (publicSupabase) return publicSupabase;
    if (!window.supabase || !window.RC_PUBLIC_CONFIG || !window.RC_PUBLIC_CONFIG.SUPABASE_URL) return null;
    publicSupabase = window.supabase.createClient(window.RC_PUBLIC_CONFIG.SUPABASE_URL, window.RC_PUBLIC_CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return publicSupabase;
  }
  function mapGameRow(row) {
    return {
      id: row.id, slug: row.slug, title: row.title, genre: row.genre || [],
      cover: row.cover, releaseDate: row.release_date, activeRentals: row.times_rented || 0,
      status: row.status, upcomingOrder: row.upcoming_order,
      trophy: { available: row.trophy_available, availableAt: row.trophy_available_at, weekly: row.trophy_weekly, monthly: row.trophy_monthly, reservationStatus: row.trophy_reservation_status },
      nontrophy: { available: row.nontrophy_available, availableAt: row.nontrophy_available_at, weekly: row.nontrophy_weekly, monthly: row.nontrophy_monthly, reservationStatus: row.nontrophy_reservation_status },
      platform: row.platform
    };
  }
  // Live catalog data comes straight from Supabase so admin overrides
  // (activate/end a rental, manual slot toggle) show up immediately --
  // falls back to the static JSON snapshot if Supabase is unreachable.
  function loadGames() {
    var sb = getPublicSupabase();
    if (!sb) return fetch(DATA_URL).then(function (r) { return r.json(); });
    return sb.from('games').select('*').then(function (res) {
      if (res.error) throw res.error;
      // Filtered client-side (not `.eq('is_test', false)` server-side) so
      // this keeps working before migration_10_customer_accounts.sql (which
      // adds `games.is_test`) has been run -- an unknown column in a
      // server-side filter would error the whole query and take down the
      // live catalog. `row.is_test !== true` also treats missing/null the
      // same as false, so pre-migration rows are unaffected.
      return res.data.filter(function (row) { return row.is_test !== true; }).map(mapGameRow);
    });
  }
  // Resolves to the signed-in customer's renters.id, or null if they're
  // signed out, RCAccount isn't on the page, or the customer has no renter
  // row yet and ensure_my_renter() can't be reached (e.g. migration_12
  // hasn't been applied) -- every one of those falls back to null (submit
  // anonymously) rather than failing the rent flow. Reads the session
  // through window.RCAccount (site/account/shared.js -- loaded on every
  // page that loads this file, see site/index.html etc.) so this checks the
  // customer's own session under its own storageKey instead of standing up
  // a second, ad-hoc Supabase client that might see a stale/other session.
  function getSignedInRenterId() {
    if (!window.RCAccount) return Promise.resolve(null);
    return window.RCAccount.getSession().then(function (session) {
      if (!session) return null;
      // ensure_my_renter() creates the renters row on first call for a
      // fresh signup -- idempotent, safe to call every time (see
      // migration_12_renter_claiming_rpc.sql). Already fails soft to null
      // internally if the RPC doesn't exist yet.
      return window.RCAccount.ensureRenter().then(function (row) {
        return (row && row.renter_id) || null;
      });
    }, function () { return null; });
  }

  // Drops a note in the admin app's "Incoming Requests" inbox with the
  // game/slot/plan the customer already picked, so the admin doesn't have
  // to re-enter it by hand after reading the Messenger message. Best-effort
  // only -- never blocks or delays opening Messenger. When the customer is
  // signed in, tags the request with their renter_id (migration_13) so it
  // lands in their account once the admin approves it, instead of needing
  // manual linking.
  function submitRentalRequest(g, slotKey) {
    var sb = getPublicSupabase();
    if (!sb) return;
    var payload = {
      game_slug: g.slug, game_title: g.title, slot: slotKey,
      plan: state.plan || null, amount: g[slotKey] ? (g[slotKey][state.plan] || null) : null
    };
    getSignedInRenterId().then(function (renterId) {
      if (renterId) payload.renter_id = renterId;
      return sb.from('rental_requests').insert(payload);
    }).then(function (res) {
      // migration_13 not applied yet -> renter_id is an unknown column and
      // this insert errors. Retry once without it so the customer's rent
      // request still goes through anonymously rather than silently
      // failing -- completing the rental matters more than the identity tag.
      if (res && res.error && payload.renter_id) {
        delete payload.renter_id;
        return sb.from('rental_requests').insert(payload);
      }
    }).then(function () {}, function () {});
  }

  // ---- self-serve payment step (create_rental_hold) ----
  // Pre-migration (RPCs not deployed yet) or any Supabase failure must fail
  // soft back to the exact old behaviour -- submitRentalRequest() + open
  // Messenger -- so the live site never breaks for a real customer while
  // the SQL agent's migration hasn't landed. See RENT-FLOW-CONTRACT.md.
  var holdCountdownTimer = null;

  function clearHoldCountdown() {
    if (holdCountdownTimer) { clearInterval(holdCountdownTimer); holdCountdownTimer = null; }
  }

  function startHoldCountdown(expiresAtIso) {
    clearHoldCountdown();
    var tick = function () {
      var el = document.getElementById('rcHoldCountdown');
      if (!el) { clearHoldCountdown(); return; }
      var remain = new Date(expiresAtIso).getTime() - Date.now();
      if (isNaN(remain) || remain <= 0) {
        el.textContent = 'Expired';
        el.classList.add('rc-hold-expired');
        clearHoldCountdown();
        return;
      }
      var totalSec = Math.floor(remain / 1000);
      var m = Math.floor(totalSec / 60);
      var s = totalSec % 60;
      el.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    };
    tick();
    holdCountdownTimer = setInterval(tick, 1000);
  }

  // navigator.clipboard is unavailable/rejects on older browsers and on
  // non-HTTPS -- always fall back to the hidden-textarea execCommand trick,
  // wrapped in try/catch since execCommand itself can throw or just return
  // false depending on the browser.
  function fallbackCopyToClipboard(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function copyToClipboard(text, cb) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { cb(true); }, function () { cb(fallbackCopyToClipboard(text)); });
        return;
      }
    } catch (e) {}
    cb(fallbackCopyToClipboard(text));
  }

  function slotDisplayName(slotKey) { return slotKey === 'trophy' ? 'Trophy' : 'Non-Trophy'; }

  // Auto-login for the customer portal (site/account/): the moment a hold
  // is created we stash the renter's public_code on this device under this
  // exact key so /account/ can pick it up with no typing and no password.
  // Never clobber an existing code -- a different code already present
  // means a different person on a shared device, and overwriting it would
  // log the first person out of their own rentals. localStorage throws in
  // private-browsing modes, so this must never break the payment screen.
  var TRACK_CODE_KEY = 'rc-track-code';
  function loadTrackCode() {
    try { return localStorage.getItem(TRACK_CODE_KEY) || null; } catch (e) { return null; }
  }
  // Always store the code the server just handed back for THIS rental. The
  // earlier "don't overwrite" rule protected a shared device but broke the
  // common case: a guest renting a second time kept their first code and
  // their new rental was invisible on the tracking page. Since the stored
  // code is now sent to create_rental_hold (migration_18), the server
  // normally returns the SAME code back, so this rewrites like for like --
  // and when it genuinely differs, the person who just paid on this device
  // is the one whose code should win.
  function saveTrackCode(code) {
    if (!code) return;
    try { localStorage.setItem(TRACK_CODE_KEY, code); } catch (e) {}
  }

  function buildModalHeader(g) {
    return '<h2 class="rc-modal-title">' + g.title + '</h2>' +
      platformBadge(g.platform) +
      '<p class="rc-modal-genre">' + g.genre.join(' · ') + (g.releaseDate ? ' · Release ' + releaseDateLabel(g.releaseDate) : '') + '</p>';
  }

  // Shown in place while create_rental_hold is in flight -- writes straight
  // to the modal body rather than going through state.step/history, since
  // this is a transient state: on failure we fall all the way back to the
  // pre-payment-step behaviour and this spinner just disappears again.
  function renderHoldSpinner(g) {
    var body = document.getElementById('rcModalBody');
    if (!body) return;
    body.innerHTML = buildModalHeader(g) +
      '<div class="rc-pay-loading">' +
        '<span class="rc-pay-spinner" aria-hidden="true"></span>' +
        '<p class="rc-pay-loading-text">Reserving your slot…</p>' +
      '</div>';
  }

  function holdErrorMessage(code) {
    switch (code) {
      case 'slot_unavailable': return 'Someone just took this slot. Try the other access type or another game.';
      case 'game_not_found': return 'We couldn\'t find this game anymore. Please close this and refresh the page.';
      case 'no_price': return 'This game doesn\'t have a price set for that plan yet. Please message us on Messenger instead.';
      case 'bad_plan': return 'Something went wrong with the selected plan. Please go back and choose again.';
      case 'bad_slot': return 'Something went wrong with the selected access type. Please go back and choose again.';
      default: return 'Something went wrong reserving your slot. Please go back and try again, or message us on Messenger.';
    }
  }

  function renderPaymentFailure(code) {
    return '' +
      '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Back</button>' +
      '<div class="rc-wizard-heading">Couldn\'t reserve that slot</div>' +
      '<p class="rc-wizard-sub">' + holdErrorMessage(code) + '</p>';
  }

  function renderPaymentSuccess(g, hold) {
    var planName = state.plan === 'weekly' ? 'Weekly' : 'Monthly';
    var amount = peso(hold.amount);
    return '' +
      '<div class="rc-wizard-heading">Reserve your slot with GCash</div>' +
      '<p class="rc-wizard-sub">Your slot is held for a limited time. Send the exact amount below to confirm.</p>' +
      '<div class="rc-pay-summary">' +
        '<div class="rc-pay-row"><span>Game</span><b>' + g.title + '</b></div>' +
        '<div class="rc-pay-row"><span>Access</span><b>' + slotDisplayName(state.slot) + '</b></div>' +
        '<div class="rc-pay-row"><span>Plan</span><b>' + planName + '</b></div>' +
        '<div class="rc-pay-row rc-pay-row-amount"><span>Amount Due</span><b>' + amount + '</b></div>' +
      '</div>' +
      '<div class="rc-pay-hold">' +
        '<span class="rc-pay-hold-label">Slot held for</span>' +
        '<span class="rc-pay-hold-timer" id="rcHoldCountdown">--:--</span>' +
      '</div>' +
      '<div class="rc-pay-gcash">' +
        '<div class="rc-pay-field">' +
          '<span class="rc-pay-field-label">GCash Number</span>' +
          '<div class="rc-pay-field-row">' +
            '<span class="rc-pay-field-value">' + hold.gcash_number + '</span>' +
            '<button type="button" class="rc-pay-copy" id="rcCopyGcash" data-copy="' + hold.gcash_number + '">Copy</button>' +
          '</div>' +
        '</div>' +
        '<div class="rc-pay-field">' +
          '<span class="rc-pay-field-label">GCash Name</span>' +
          '<div class="rc-pay-field-row"><span class="rc-pay-field-value">' + hold.gcash_name + '</span></div>' +
        '</div>' +
        '<div class="rc-pay-field">' +
          '<span class="rc-pay-field-label">Reference Code</span>' +
          '<div class="rc-pay-field-row">' +
            '<span class="rc-pay-field-value rc-pay-refcode">' + hold.ref_code + '</span>' +
            '<button type="button" class="rc-pay-copy" id="rcCopyRef" data-copy="' + hold.ref_code + '">Copy</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p class="rc-pay-instruction">Send exactly <b>' + amount + '</b> to this GCash number, then put <b>' + hold.ref_code + '</b> in the message/note.</p>' +
      '<button type="button" class="rc-modal-cta rc-pay-cta" id="rcPaySentBtn">' + icon('message-circle') + ' I\'ve paid — send screenshot</button>' +
      '<div class="rc-pay-code-box">' +
        '<span class="rc-pay-code-label">Saved on this device</span>' +
        '<p class="rc-pay-code-intro">This phone will remember your rentals automatically. <a href="/account/">View my rentals</a> anytime — no sign-in needed.</p>' +
        '<div class="rc-pay-code-row">' +
          '<span class="rc-pay-code-value">' + hold.public_code + '</span>' +
          '<button type="button" class="rc-pay-copy" id="rcCopyTrackCode" data-copy="' + hold.public_code + '">Copy</button>' +
        '</div>' +
        '<p class="rc-pay-code-note">Backup: write this down for another device, or in case you clear your browser.</p>' +
      '</div>';
  }

  function renderPaymentStep(g) {
    return state.hold ? renderPaymentSuccess(g, state.hold) : renderPaymentFailure(state.holdError);
  }

  function wirePaymentStep(body) {
    var back = document.getElementById('rcWizardBack');
    if (back) back.addEventListener('click', function () { window.history.back(); });

    var flashCopied = function (btn) {
      var original = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('is-copied');
      setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove('is-copied');
      }, 1800);
    };
    Array.prototype.forEach.call(body.querySelectorAll('.rc-pay-copy'), function (btn) {
      btn.addEventListener('click', function () {
        copyToClipboard(btn.getAttribute('data-copy'), function (ok) {
          if (ok) flashCopied(btn);
        });
      });
    });

    var sendBtn = document.getElementById('rcPaySentBtn');
    if (sendBtn) sendBtn.addEventListener('click', function () {
      var game = state.modalGame, hold = state.hold;
      if (!game || !hold) return;
      var planName = state.plan === 'weekly' ? 'Weekly' : 'Monthly';
      var text = 'Hi! I\'ve paid for "' + game.title + '" — ' + slotDisplayName(state.slot) + ' access, ' +
        planName + ' plan (' + peso(hold.amount) + '). Ref: ' + hold.ref_code + '. Attaching my GCash screenshot.';
      window.open(messengerLink(game, text), '_blank', 'noopener');
    });
  }

  // Called when a customer picks an access slot for a brand-new rental
  // (never for swaps -- see wireAccessStep). Tries to soft-hold the
  // slot server-side and show a GCash payment screen; falls all the way
  // back to the pre-existing Messenger-only flow (submitRentalRequest +
  // messengerLink, via finalizeRental) on any error, including the RPC not
  // existing yet pre-migration. Never leaves the customer stuck on a
  // spinner.
  function chooseNewRentalSlot(slotKey) {
    var g = state.modalGame;
    if (!g) return;
    state.slot = slotKey;
    state.hold = null;
    state.holdError = null;
    renderHoldSpinner(g);

    var sb = getPublicSupabase();
    if (!sb) { renderModal(); finalizeRental(slotKey); return; }

    getSignedInRenterId().then(function (renterId) {
      var args = {
        p_game_slug: g.slug, p_slot: slotKey, p_plan: state.plan,
        p_renter_id: renterId || null
      };
      // p_public_code lets a returning guest keep one renter row and one
      // tracking code across rentals (migration_18). Harmless when absent or
      // stale -- the server falls back to creating a renter. Ignored for a
      // signed-in customer, whose p_renter_id takes priority.
      var code = loadTrackCode();
      if (!code) return sb.rpc('create_rental_hold', args);
      args.p_public_code = code;
      return sb.rpc('create_rental_hold', args).then(function (res) {
        // Before migration_18 the function has six arguments, so passing a
        // seventh means PostgREST can't resolve it at all. Retry without the
        // code rather than dropping the customer back to Messenger -- losing
        // the renter-reuse nicety beats losing the rental.
        if (res && res.error) {
          delete args.p_public_code;
          return sb.rpc('create_rental_hold', args);
        }
        return res;
      });
    }).then(function (res) {
      if (state.modalGame !== g) return; // stale response -- customer moved on
      if (!res || res.error) { renderModal(); finalizeRental(slotKey); return; }
      var row = res.data && res.data[0];
      if (!row) { renderModal(); finalizeRental(slotKey); return; }
      if (!row.ok) {
        state.holdError = row.error || null;
        state.hold = null;
        state.step = 'payment';
        renderModal();
        pushStepState();
        return;
      }
      state.hold = row;
      state.holdError = null;
      saveTrackCode(row.public_code);
      state.step = 'payment';
      renderModal();
      pushStepState();
    }, function () {
      if (state.modalGame !== g) return;
      renderModal();
      finalizeRental(slotKey);
    });
  }

  function finalizeRental(slotKey) {
    var g = state.modalGame;
    state.slot = slotKey;
    var slotName = slotKey === 'trophy' ? 'Trophy' : 'Non-Trophy';
    var text;
    if (state.intent === 'swap') {
      text = 'Hi! I\'m an active renter and I\'d like to swap my current rental to "' + g.title + '" — ' + slotName + ' access.';
    } else {
      var upcoming = g.status === 'upcoming';
      var planName = state.plan === 'weekly' ? 'Weekly' : 'Monthly';
      var price = peso(g[slotKey][state.plan]);
      text = 'Hi! I\'d like to ' + (upcoming ? 'pre-reserve' : 'rent') + ' "' + g.title + '" — ' + slotName + ' access, ' + planName + ' plan (' + price + ').';
      submitRentalRequest(g, slotKey);
    }
    window.open(messengerLink(g, text), '_blank', 'noopener');
  }

  function renderModal() {
    var g = state.modalGame;
    if (!g) return;
    clearHoldCountdown();
    var body = document.getElementById('rcModalBody');
    var header = buildModalHeader(g);

    if (state.step === 'intent') { body.innerHTML = header + renderIntentStep(g); wireIntentStep(body); }
    else if (state.step === 'plan') { body.innerHTML = header + renderPlanStep(g); wirePlanStep(body); }
    else if (state.step === 'payment') {
      body.innerHTML = header + renderPaymentStep(g);
      wirePaymentStep(body);
      if (state.hold) startHoldCountdown(state.hold.hold_expires_at);
    }
    else { body.innerHTML = header + renderAccessStep(g); wireAccessStep(body); }

    var cover = document.getElementById('rcModalCover');
    cover.src = g.cover || '';
    cover.alt = g.title;

    var modalEl = document.querySelector('.rc-modal');
    modalEl.classList.toggle('rc-modal-compact', state.step !== 'intent');
  }

  function renderIntentStep(g) {
    return '' +
      '<div class="rc-wizard-heading">What do you want to do with this game?</div>' +
      '<p class="rc-wizard-sub">Choose one: start a new rental or swap an active rental.</p>' +
      '<div class="rc-choice-grid">' +
        '<button type="button" class="rc-choice-card rc-choice-new" data-intent="new">' +
          '<span class="rc-choice-icon">' + icon('gamepad-2') + '</span>' +
          '<span class="rc-choice-name">New Rental</span>' +
          '<span class="rc-choice-desc">Rent this game as a new or additional subscription.</span>' +
        '</button>' +
        '<button type="button" class="rc-choice-card rc-choice-swap" data-intent="swap">' +
          '<span class="rc-choice-icon">' + icon('refresh-cw') + '</span>' +
          '<span class="rc-choice-name">Swap Current Rental</span>' +
          '<span class="rc-choice-desc">Active renters: request this game as your replacement title.</span>' +
        '</button>' +
      '</div>';
  }

  function wireIntentStep(body) {
    Array.prototype.forEach.call(body.querySelectorAll('.rc-choice-card'), function (btn) {
      btn.addEventListener('click', function () {
        state.intent = btn.getAttribute('data-intent');
        state.step = (state.intent === 'swap') ? 'access' : 'plan';
        renderModal();
        pushStepState();
      });
    });
  }

  // Swap allowance is configurable per plan in the admin Settings tab, so
  // the wizard must not hardcode it -- the owner changing the number would
  // silently make this copy a lie. publicSettings is filled in by a single
  // get_public_settings() call the first time a game modal opens; until it
  // resolves (or if the RPC isn't deployed yet) we fall back to the wording
  // the site shipped with, which matches the seeded defaults.
  var publicSettings = null;
  var publicSettingsLoading = false;
  function loadPublicSettings() {
    if (publicSettings || publicSettingsLoading) return;
    var sb = getPublicSupabase();
    if (!sb) return;
    publicSettingsLoading = true;
    sb.rpc('get_public_settings').then(function (res) {
      publicSettingsLoading = false;
      if (!res || res.error || !res.data || !res.data[0]) return;
      publicSettings = res.data[0];
      // The plan step may already be on screen with the fallback copy.
      if (state.step === 'plan') renderModal();
    }, function () { publicSettingsLoading = false; });
  }
  function swapsCopy(plan) {
    var n = publicSettings && publicSettings['swap_limit_' + plan];
    if (n === undefined || n === null || n === '') {
      return plan === 'weekly' ? '1 swap' : 'multiple swaps';
    }
    n = Number(n);
    if (!n) return 'no swaps';
    return n + ' swap' + (n === 1 ? '' : 's');
  }

  function renderPlanStep(g) {
    var upcoming = g.status === 'upcoming';
    return '' +
      (upcoming ? '' : '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Change Action</button>') +
      '<div class="rc-wizard-heading">Weekly or Monthly?</div>' +
      '<p class="rc-wizard-sub">Choose your rental period first.</p>' +
      '<div class="rc-plan-grid">' +
        '<button type="button" class="rc-plan-card rc-plan-weekly" data-plan="weekly">' +
          '<span class="rc-plan-name">Weekly</span>' +
          '<span class="rc-plan-price">' + peso(g.trophy.weekly) + '</span>' +
          '<span class="rc-plan-desc">7 days · ' + swapsCopy('weekly') + ' · 24h cooldown after completed swap</span>' +
          '<span class="rc-plan-tap">Tap to choose</span>' +
        '</button>' +
        '<button type="button" class="rc-plan-card rc-plan-monthly" data-plan="monthly">' +
          '<span class="rc-plan-name">Monthly</span>' +
          '<span class="rc-plan-price">' + peso(g.trophy.monthly) + '</span>' +
          '<span class="rc-plan-desc">30 days · ' + swapsCopy('monthly') + ' · 24h cooldown after completed swap</span>' +
          '<span class="rc-plan-tap">Tap to choose</span>' +
        '</button>' +
      '</div>';
  }

  function wirePlanStep(body) {
    var back = document.getElementById('rcWizardBack');
    if (back) back.addEventListener('click', function () { window.history.back(); });
    Array.prototype.forEach.call(body.querySelectorAll('.rc-plan-card'), function (btn) {
      btn.addEventListener('click', function () {
        state.plan = btn.getAttribute('data-plan');
        state.step = 'access';
        renderModal();
        pushStepState();
      });
    });
  }

  function renderAccessStep(g) {
    return state.intent === 'swap' ? renderSwapAccessStep(g) : renderSimpleAccessStep(g);
  }

  function renderSimpleAccessStep(g) {
    var upcoming = g.status === 'upcoming';
    var trophyOn = slotEnabled(g, 'trophy');
    var nontrophyOn = slotEnabled(g, 'nontrophy');
    var t = slotLabel(g, 'trophy');
    var n = slotLabel(g, 'nontrophy');
    var actionWord = upcoming ? 'PRE-RESERVE' : 'RENT ' + state.plan.toUpperCase();
    return '' +
      '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Change Plan</button>' +
      '<div class="rc-wizard-heading">Trophy or Non-Trophy?</div>' +
      '<p class="rc-wizard-sub">Trophy: play on your own PSN profile, trophies and saves stay yours. Non-Trophy: play on the rented game profile with full game access either way.</p>' +
      '<div class="rc-access-grid rc-access-grid-simple">' +
        '<div class="rc-access-card' + (!trophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('trophy') + ' Trophy</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
          '<p class="rc-access-desc">Play on your own PSN profile. Trophies and saves stay yours.</p>' +
          '<button type="button" class="rc-access-choose" data-slot="trophy"' + (!trophyOn ? ' disabled' : '') + '>' + actionWord + ' — Trophy</button>' +
        '</div>' +
        '<div class="rc-access-card' + (!nontrophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('user') + ' Non-Trophy</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
          '<p class="rc-access-desc">Play on the rented game profile with the same full game access.</p>' +
          '<button type="button" class="rc-access-choose" data-slot="nontrophy"' + (!nontrophyOn ? ' disabled' : '') + '>' + actionWord + ' — Non-Trophy</button>' +
        '</div>' +
      '</div>';
  }

  function renderSwapAccessStep(g) {
    var trophyOn = slotEnabled(g, 'trophy');
    var nontrophyOn = slotEnabled(g, 'nontrophy');
    var t = slotLabel(g, 'trophy');
    var n = slotLabel(g, 'nontrophy');
    var firstKey = trophyOn ? 'trophy' : (nontrophyOn ? 'nontrophy' : null);
    var firstName = firstKey === 'trophy' ? 'Trophy' : (firstKey === 'nontrophy' ? 'Non-Trophy' : null);

    return '' +
      '<span class="rc-wizard-eyebrow">CURRENT RENTER SWAP</span>' +
      '<div class="rc-wizard-heading">Ready when you are.</div>' +
      '<p class="rc-wizard-sub">Choose an open access type. We\'ll check your active rental, plan and cooldown on Messenger.</p>' +
      '<div class="rc-wizard-steps">' +
        '<span class="rc-wizard-step-chip"><span class="rc-wizard-step-num">1</span>Choose slot</span>' +
        '<span class="rc-wizard-step-chip"><span class="rc-wizard-step-num">2</span>Send I\'m ready</span>' +
        '<span class="rc-wizard-step-chip"><span class="rc-wizard-step-num">3</span>Get next step</span>' +
      '</div>' +
      '<div class="rc-wizard-heading rc-wizard-heading-sm">Choose your preferred access</div>' +
      '<p class="rc-wizard-sub">Trophy: play on your own PSN profile; trophies and saves stay yours. Non-Trophy: play on the rented game profile. Both give full game access.</p>' +
      '<div class="rc-access-grid">' +
        '<div class="rc-access-card' + (!trophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('trophy') + ' Trophy</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
          '<p class="rc-access-desc">Play on your own PSN profile. Trophies and saves stay yours.</p>' +
          '<p class="rc-access-note">' + (trophyOn ? 'Available now, subject to your rental and cooldown check.' : 'Not open right now.') + '</p>' +
          '<button type="button" class="rc-access-choose" data-slot="trophy"' + (!trophyOn ? ' disabled' : '') + '>Choose Trophy</button>' +
        '</div>' +
        '<div class="rc-access-card' + (!nontrophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('user') + ' Non-Trophy</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
          '<p class="rc-access-desc">Play on the rented game profile with the same full game access.</p>' +
          '<p class="rc-access-note">' + (nontrophyOn ? 'Available now, subject to your rental and cooldown check.' : 'Not open right now.') + '</p>' +
          '<button type="button" class="rc-access-choose" data-slot="nontrophy"' + (!nontrophyOn ? ' disabled' : '') + '>Choose Non-Trophy</button>' +
        '</div>' +
        '<div class="rc-access-card rc-access-first' + (!firstKey ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('zap') + ' First Available</span>' + (firstKey ? '<span class="rc-slot-status rc-status-open"><span class="rc-dot"></span>FASTEST</span>' : '') + '</div>' +
          '<p class="rc-access-desc">Choose whichever access opens first for the fastest possible option.</p>' +
          '<p class="rc-access-note">' + (firstKey ? firstName + ' is open now, so there\'s no need to wait.' : 'Nothing open right now — check back soon.') + '</p>' +
          '<button type="button" class="rc-access-choose" data-slot="' + (firstKey || '') + '"' + (!firstKey ? ' disabled' : '') + '>Use ' + (firstName || 'Access') + ' Now</button>' +
        '</div>' +
      '</div>' +
      '<div class="rc-access-checklist">' +
        '<span>✓ Open slot prioritized</span><span>✓ Plan and cooldown checked</span><span>✓ Exact payment only if needed</span>' +
      '</div>' +
      '<p class="rc-modal-note">Choose Trophy, Non-Trophy, or First Available. If an access type is open now, we\'ll prioritize that faster path. Keep your current game active until June Digitals confirms the next step.</p>';
  }

  function wireAccessStep(body) {
    var back = document.getElementById('rcWizardBack');
    if (back) back.addEventListener('click', function () { window.history.back(); });
    Array.prototype.forEach.call(body.querySelectorAll('.rc-access-choose'), function (btn) {
      if (btn.hasAttribute('disabled')) return;
      btn.addEventListener('click', function () {
        var slotKey = btn.getAttribute('data-slot');
        // Swaps keep their existing Messenger-only behaviour untouched --
        // only a brand-new rental goes through the self-serve hold/payment
        // step (see chooseNewRentalSlot).
        if (state.intent === 'swap') finalizeRental(slotKey);
        else chooseNewRentalSlot(slotKey);
      });
    });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCoverFit(ctx, img, x, y, w, h) {
    var ir = img.naturalWidth / img.naturalHeight;
    var dr = w / h;
    var sx, sy, sw, sh;
    if (ir > dr) { sh = img.naturalHeight; sw = sh * dr; sx = (img.naturalWidth - sw) / 2; sy = 0; }
    else { sw = img.naturalWidth; sh = sw / dr; sx = 0; sy = (img.naturalHeight - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  function shareLink(g) { return window.location.origin + '/?game=' + g.slug; }

  function drawShareCard(g, onReady) {
    var canvas = document.getElementById('rcShareCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height, coverH = 620;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    var img = new Image();
    img.onload = function () {
      drawCoverFit(ctx, img, 0, 0, W, coverH);

      var grad = ctx.createLinearGradient(0, coverH - 260, 0, coverH);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,.88)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, coverH - 260, W, 260);

      roundRectPath(ctx, 22, 22, 232, 58, 14);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.fillStyle = '#0a0a0a';
      ctx.font = '800 18px Arial, sans-serif';
      ctx.fillText('June Digitals', 38, 50);
      ctx.fillStyle = '#6b6b6b';
      ctx.font = '700 10px Arial, sans-serif';
      ctx.fillText('PS5 DIGITAL GAME RENTAL', 38, 68);

      ctx.fillStyle = '#fff';
      ctx.font = '800 38px Arial, sans-serif';
      wrapFillText(ctx, g.title, 26, coverH - 34, W - 52, 42);

      ctx.fillStyle = '#111218';
      ctx.fillRect(0, coverH, W, H - coverH);

      var boxY = coverH + 28, boxH = 100, gap = 18, boxW = (W - 52 - gap) / 2;
      drawPriceBox(ctx, 26, boxY, boxW, boxH, 'WEEKLY', peso(g.trophy.weekly));
      drawPriceBox(ctx, 26 + boxW + gap, boxY, boxW, boxH, 'MONTHLY', peso(g.trophy.monthly));

      ctx.fillStyle = '#2f6bff';
      ctx.font = '800 15px Arial, sans-serif';
      ctx.fillText('CHECK LIVE SLOT AVAILABILITY', 26, boxY + boxH + 38);
      ctx.fillStyle = '#fff';
      ctx.font = '700 17px Arial, sans-serif';
      ctx.fillText('junedigitals.net', 26, boxY + boxH + 62);

      if (onReady) onReady();
    };
    img.onerror = function () { if (onReady) onReady(); };
    img.src = g.cover || '';
  }

  function wrapFillText(ctx, text, x, y, maxWidth, lineHeight) {
    var words = text.split(' ');
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = words[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    lines = lines.slice(-2);
    var startY = y - (lines.length - 1) * lineHeight;
    lines.forEach(function (l, i) { ctx.fillText(l, x, startY + i * lineHeight); });
  }

  function drawPriceBox(ctx, x, y, w, h, label, value) {
    roundRectPath(ctx, x, y, w, h, 14);
    ctx.fillStyle = '#1c1d20';
    ctx.fill();
    ctx.fillStyle = '#9a9aa2';
    ctx.font = '800 12px Arial, sans-serif';
    ctx.fillText(label, x + 18, y + 30);
    ctx.fillStyle = '#fff';
    ctx.font = '800 26px Arial, sans-serif';
    ctx.fillText(value, x + 18, y + 66);
  }

  function openShareModal(g) {
    if (!g) return;
    var overlay = document.getElementById('rcShareOverlay');
    var body = document.getElementById('rcShareBody');
    if (!overlay || !body) return;

    var link = shareLink(g);
    var text = 'Hi! I\'d like to check "' + g.title + '" — Weekly ' + peso(g.trophy.weekly) + ' / Monthly ' + peso(g.trophy.monthly) + '.';
    var summaryText = g.title + '\nWeekly: ' + peso(g.trophy.weekly) + '\nMonthly: ' + peso(g.trophy.monthly) +
      '\n\nCheck live Trophy and Non-Trophy availability on June Digitals:\n' + link;

    body.innerHTML = '' +
      '<h2 class="rc-modal-title">Share this game</h2>' +
      '<p class="rc-share-sub">A ready-to-post June Digitals game card with the cover, title, prices, and direct game link.</p>' +
      '<div class="rc-share-preview"><canvas id="rcShareCanvas" width="640" height="820"></canvas></div>' +
      '<div class="rc-share-summary">' + icon('gamepad-2') + ' <strong>' + g.title + '</strong><br>' +
        'Weekly: ' + peso(g.trophy.weekly) + '<br>Monthly: ' + peso(g.trophy.monthly) +
        '<p>Check live Trophy and Non-Trophy availability on June Digitals:<br><a href="' + link + '" target="_blank" rel="noopener">' + link + '</a></p>' +
      '</div>' +
      '<button type="button" class="rc-modal-cta rc-share-main-btn" id="rcShareGameBtn" disabled>' + icon('gamepad-2') + ' Share Game</button>' +
      '<div class="rc-share-btn-row">' +
        '<button type="button" class="rc-share-btn" id="rcShareCopyBtn">Copy Link</button>' +
        '<button type="button" class="rc-share-btn" id="rcShareDownloadBtn" disabled>Download Card</button>' +
      '</div>' +
      '<p class="rc-share-status" id="rcShareStatus"></p>' +
      '<p class="rc-modal-note">Supported phones will open the native share menu with the image and game details. If an app removes the clickable link, use Copy Link and paste it with the post.</p>';

    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    drawShareCard(g, function () {
      var shareBtn = document.getElementById('rcShareGameBtn');
      var downloadBtn = document.getElementById('rcShareDownloadBtn');
      if (shareBtn) shareBtn.removeAttribute('disabled');
      if (downloadBtn) downloadBtn.removeAttribute('disabled');
    });

    var statusEl = document.getElementById('rcShareStatus');
    var flash = function (msg) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      setTimeout(function () { statusEl.textContent = ''; }, 2400);
    };

    var copyBtn = document.getElementById('rcShareCopyBtn');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(link).then(function () { flash('Link copied!'); }, function () { flash('Could not copy — copy the link above manually.'); });
    });

    var downloadBtn2 = document.getElementById('rcShareDownloadBtn');
    if (downloadBtn2) downloadBtn2.addEventListener('click', function () {
      var canvas = document.getElementById('rcShareCanvas');
      canvas.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = g.slug + '-june-digitals.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, 'image/png');
    });

    var shareBtn2 = document.getElementById('rcShareGameBtn');
    if (shareBtn2) shareBtn2.addEventListener('click', function () {
      var canvas = document.getElementById('rcShareCanvas');
      canvas.toBlob(function (blob) {
        var shareData = { title: g.title, text: summaryText, url: link };
        var file = blob ? new File([blob], g.slug + '-june-digitals.png', { type: 'image/png' }) : null;
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) shareData.files = [file];
        if (navigator.share) {
          navigator.share(shareData).catch(function () {});
        } else {
          navigator.clipboard.writeText(summaryText);
          flash('Share not supported here — details copied instead.');
        }
      }, 'image/png');
    });
  }

  function closeShareModal() {
    var overlay = document.getElementById('rcShareOverlay');
    if (overlay) overlay.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function wireShareModal() {
    var openBtn = document.getElementById('rcModalShare');
    var closeBtn = document.getElementById('rcShareClose');
    var overlay = document.getElementById('rcShareOverlay');
    if (openBtn) openBtn.addEventListener('click', function () {
      openShareModal(state.modalGame);
      openOverlay('share', closeShareModal);
    });
    if (closeBtn) closeBtn.addEventListener('click', function () { requestCloseOverlay('share'); });
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) requestCloseOverlay('share'); });
  }

  function wireToolbar() {
    var searchInput = document.getElementById('rcSearch');
    if (!searchInput) return; // no catalog toolbar on this page
    var searchWrap = searchInput.closest('.rc-search');
    var clearBtn = document.getElementById('rcSearchClear');
    var updateClearVisibility = function () {
      if (searchWrap) searchWrap.classList.toggle('has-value', !!searchInput.value);
    };
    searchInput.addEventListener('input', function (e) {
      state.query = e.target.value; state.page = 1; renderGrid();
      updateClearVisibility();
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        searchInput.value = '';
        state.query = ''; state.page = 1; renderGrid();
        updateClearVisibility();
        searchInput.focus();
      });
    }
    updateClearVisibility();
    document.getElementById('rcGenre').addEventListener('change', function (e) {
      state.genre = e.target.value; state.page = 1; renderGrid();
    });
    document.getElementById('rcSort').addEventListener('change', function (e) {
      state.sort = e.target.value; state.page = 1; renderGrid();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.rc-chip'), function (chip) {
      chip.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rc-chip'), function (c) { c.classList.remove('is-active'); });
        chip.classList.add('is-active');
        state.quickFilter = chip.getAttribute('data-filter');
        state.page = 1;
        renderGrid();
      });
    });
    document.getElementById('rcModalOverlay').addEventListener('click', function (e) {
      if (e.target.id === 'rcModalOverlay') hardCloseOverlay('modal');
    });
    document.getElementById('rcModalClose').addEventListener('click', function () { hardCloseOverlay('modal'); });

    var track = document.getElementById('rcComingSoonTrack');
    var prevBtn = document.getElementById('rcSoonPrev');
    var nextBtn = document.getElementById('rcSoonNext');
    if (track && prevBtn && nextBtn) {
      var scrollByAmount = function (dir) {
        var cardWidth = track.firstElementChild ? track.firstElementChild.getBoundingClientRect().width + 16 : 220;
        track.scrollBy({ left: dir * cardWidth, behavior: 'smooth' });
      };
      prevBtn.addEventListener('click', function () { scrollByAmount(-1); });
      nextBtn.addEventListener('click', function () { scrollByAmount(1); });
      track.addEventListener('scroll', updateStripEdges, { passive: true });
      window.addEventListener('resize', updateStripEdges);

      // mouse users have no touch/trackpad gesture to scroll a horizontal
      // strip with -- let them click-and-drag it like a native carousel.
      var isDown = false, dragged = false, startX = 0, startScroll = 0;
      track.addEventListener('mousedown', function (e) {
        isDown = true; dragged = false;
        startX = e.pageX; startScroll = track.scrollLeft;
        track.classList.add('is-dragging');
      });
      window.addEventListener('mouseup', function () {
        isDown = false;
        track.classList.remove('is-dragging');
      });
      window.addEventListener('mousemove', function (e) {
        if (!isDown) return;
        var delta = e.pageX - startX;
        if (Math.abs(delta) > 4) dragged = true;
        track.scrollLeft = startScroll - delta;
      });
      track.addEventListener('click', function (e) {
        if (dragged) { e.preventDefault(); e.stopPropagation(); }
      }, true);
    }
  }

  function wireNavSolidOnScroll() {
    var nav = document.querySelector('.navbar');
    if (!nav) return;
    var update = function () { nav.classList.toggle('rc-nav-solid', window.scrollY > 12); };
    document.addEventListener('scroll', update, { passive: true });
    update();
  }

  function wireNavCurrentPage() {
    var path = window.location.pathname;
    var links = document.querySelectorAll('.navbar_list a.link, .rc-drawer-link');
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      var isCurrent = href === '/' ? path === '/' : path.indexOf(href) === 0;
      a.classList.toggle('is-current-page', isCurrent);
    });
  }

  function wireDrawer() {
    var btn = document.getElementById('rcMenuBtn');
    var overlay = document.getElementById('rcDrawerOverlay');
    var closeBtn = document.getElementById('rcDrawerClose');
    if (!btn || !overlay) return;

    var open = function () {
      overlay.classList.add('is-open');
      btn.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    };
    var close = function () {
      overlay.classList.remove('is-open');
      btn.classList.remove('is-open');
      document.body.style.overflow = '';
    };

    btn.addEventListener('click', function () {
      if (overlay.classList.contains('is-open')) requestCloseOverlay('drawer');
      else { open(); openOverlay('drawer', close); }
    });
    if (closeBtn) closeBtn.addEventListener('click', function () { requestCloseOverlay('drawer'); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) requestCloseOverlay('drawer'); });
    Array.prototype.forEach.call(overlay.querySelectorAll('.rc-drawer-link'), function (a) {
      a.addEventListener('click', function () { closeOverlayByName('drawer'); });
    });
  }

  function wireThemeToggle() {
    var btn = document.getElementById('rcThemeToggle');
    if (!btn) return;
    btn.classList.toggle('is-light', getSavedTheme() === 'light');
    btn.addEventListener('click', function () {
      applyTheme(getSavedTheme() === 'light' ? 'dark' : 'light');
    });
  }

  // ---- chat widget (bottom-left button -> FAQ + live catalog assistant) ----
  function getChatClientId() {
    var key = 'rc-chat-client-id';
    try {
      var id = localStorage.getItem(key);
      if (!id) {
        id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('anon-' + Date.now() + '-' + Math.random().toString(36).slice(2));
        localStorage.setItem(key, id);
      }
      return id;
    } catch (e) { return 'anon-' + Date.now(); }
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Bot replies may include "[Game Title](https://.../?game=slug)" links --
  // turn those into real clickable links, everything else stays plain text.
  // Tagged with data-game-slug so the click handler below can open the
  // game's popup in place instead of a full page navigation (which would
  // reset the chat panel).
  function renderChatText(text) {
    return escapeHtml(text).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) {
      var slugMatch = /[?&]game=([^&]+)/.exec(url);
      var slugAttr = slugMatch ? ' data-game-slug="' + slugMatch[1] + '"' : '';
      return '<a href="' + url + '"' + slugAttr + '>' + label + '</a>';
    });
  }
  function appendChatMessage(text, who) {
    var wrap = document.getElementById('rcChatMessages');
    if (!wrap) return;
    var div = document.createElement('div');
    div.className = 'rc-chat-msg rc-chat-msg-' + who;
    if (who === 'bot') div.innerHTML = renderChatText(text);
    else div.textContent = text;
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  }
  // Thinking indicator shown while the reply is in flight. Not a real
  // message: no text content for renderChatText/selection to touch, and
  // always removed before the next appendChatMessage call for the reply.
  function showChatTyping() {
    var wrap = document.getElementById('rcChatMessages');
    if (!wrap) return null;
    var div = document.createElement('div');
    div.className = 'rc-chat-msg rc-chat-msg-bot rc-chat-typing';
    div.setAttribute('aria-hidden', 'true');
    div.innerHTML = '<span class="rc-chat-typing-dot"></span><span class="rc-chat-typing-dot"></span><span class="rc-chat-typing-dot"></span>';
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
    return div;
  }
  function hideChatTyping(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function wireChatWidget() {
    var widget = document.createElement('div');
    widget.className = 'rc-chat-widget';
    widget.innerHTML =
      '<button type="button" class="rc-chat-toggle" id="rcChatToggle" aria-label="Chat with us">' + icon('message-circle', 'rc-chat-icon') + '</button>' +
      '<div class="rc-chat-panel" id="rcChatPanel" hidden>' +
        '<div class="rc-chat-header"><span>June Digitals Assistant</span><button type="button" class="rc-chat-close" id="rcChatClose" aria-label="Close chat">&times;</button></div>' +
        '<div class="rc-chat-messages" id="rcChatMessages"><div class="rc-chat-msg rc-chat-msg-bot">Hi! Ask me about game availability, prices, or how rentals work.</div></div>' +
        '<form class="rc-chat-input-row" id="rcChatForm"><input type="text" id="rcChatInput" placeholder="Ask a question..." maxlength="500" autocomplete="off"><button type="submit" id="rcChatSend">Send</button></form>' +
        '<p class="rc-chat-hint" id="rcChatHint"></p>' +
      '</div>';
    document.body.appendChild(widget);

    var toggle = document.getElementById('rcChatToggle');
    var panel = document.getElementById('rcChatPanel');
    var closeBtn = document.getElementById('rcChatClose');
    var form = document.getElementById('rcChatForm');
    var input = document.getElementById('rcChatInput');
    var sendBtn = document.getElementById('rcChatSend');
    var hint = document.getElementById('rcChatHint');

    toggle.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) input.focus();
    });
    closeBtn.addEventListener('click', function () { panel.hidden = true; });

    // Game links inside bot replies open the popup in place instead of
    // navigating (a real navigation would reload the page and lose the
    // chat history).
    document.getElementById('rcChatMessages').addEventListener('click', function (e) {
      var link = e.target.closest('a[data-game-slug]');
      if (!link) return;
      e.preventDefault();
      openModal(link.getAttribute('data-game-slug'), true);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      var sb = getPublicSupabase();
      if (!sb) { appendChatMessage('Chat is unavailable right now -- please message us on Messenger.', 'bot'); return; }
      appendChatMessage(text, 'user');
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;
      var typingEl = showChatTyping();
      sb.functions.invoke('chat', { body: { clientId: getChatClientId(), message: text } }).then(function (res) {
        hideChatTyping(typingEl);
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
        var data = res.data;
        if (res.error || !data) {
          appendChatMessage('Sorry, something went wrong. Please try again or message us on Messenger.', 'bot');
          return;
        }
        appendChatMessage(data.reply, 'bot');
        hint.textContent = data.limited ? '' : (typeof data.remaining === 'number' ? data.remaining + ' message' + (data.remaining === 1 ? '' : 's') + ' left today.' : '');
      }).catch(function () {
        hideChatTyping(typingEl);
        input.disabled = false;
        sendBtn.disabled = false;
        appendChatMessage('Sorry, something went wrong. Please try again or message us on Messenger.', 'bot');
      });
    });
  }

  function init() {
    wireNavSolidOnScroll();
    wireOverlayHistory();
    wireShareModal();
    wireDrawer();
    wireThemeToggle();
    wireNavCurrentPage();
    wireChatWidget();
    loadGames().then(function (games) {
      state.games = games;
      populateGenres();
      wireToolbar();
      renderComingSoon();
      renderGrid();

      var params = new URLSearchParams(window.location.search);
      var wanted = params.get('game');
      if (wanted) openModal(wanted, false);
    }).catch(function (err) { console.error('Catalog load failed', err); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
