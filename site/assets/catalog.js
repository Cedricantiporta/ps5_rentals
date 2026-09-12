(function () {
  'use strict';

  var DATA_URL = '/data/games.json';
  var MESSENGER_URL = 'https://m.me/junedigitalaccess';
  var POPULAR_MIN = 5;
  var HIGH_DEMAND_MIN = 10;
  var PAGE_SIZE = 20;

  var state = { games: [], query: '', quickFilter: 'all', genre: '', sort: 'default', modalGame: null, plan: 'weekly', slot: null, page: 1, step: 'intent', intent: 'new' };

  var ICON_PATHS = {
    trophy: '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'
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
    if (!t && !n) return { label: 'WAITLIST', cls: 'rc-badge-waitlist' };
    if (!t && n) return { label: 'TROPHY FULL', cls: 'rc-badge-trophyfull' };
    if (t && !n) return { label: 'LIMITED', cls: 'rc-badge-limited' };
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

  function availInfo(available) {
    return available ? { label: 'AVAILABLE', cls: 'rc-status-available' } : { label: 'FULL', cls: 'rc-status-full' };
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
    // the track has its own left/right padding (for the circular nav buttons), and
    // scroll-snap rests there rather than at an exact 0 -- so use a generous edge buffer
    var EDGE_BUFFER = 48;
    var atStart = track.scrollLeft <= EDGE_BUFFER;
    var atEnd = track.scrollLeft >= maxScroll - EDGE_BUFFER;
    wrap.classList.toggle('can-scroll-left', !atStart && maxScroll > 0);
    wrap.classList.toggle('can-scroll-right', !atEnd && maxScroll > 0);
    var leftFade = atStart ? '0px' : '44px';
    var rightFade = atEnd ? '0px' : '60px';
    var mask = 'linear-gradient(to right, transparent 0, black ' + leftFade + ', black calc(100% - ' + rightFade + '), transparent 100%)';
    track.style.maskImage = mask;
    track.style.webkitMaskImage = mask;
  }

  function renderComingSoon() {
    var track = document.getElementById('rcComingSoonTrack');
    var section = document.getElementById('rcComingSoonSection');
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
    var allGames = filteredSortedGames();
    document.getElementById('rcCount').textContent = allGames.length;
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
      var t = availInfo(g.trophy.available);
      var n = availInfo(g.nontrophy.available);
      return '' +
        '<div class="rc-card" data-slug="' + g.slug + '">' +
          '<div class="rc-card-cover-wrap">' +
            (badge ? '<span class="rc-badge ' + badge.cls + '">' + badge.label + '</span>' : '') +
            (g.activeRentals > 0 ? '<span class="rc-count-badge">' + (g.activeRentals > 99 ? '99+' : g.activeRentals) + '</span>' : '') +
            '<img class="rc-card-cover" loading="lazy" src="' + (g.cover || '') + '" alt="' + g.title + '"/>' +
          '</div>' +
          '<div class="rc-card-body">' +
            '<div class="rc-card-top">' +
              '<p class="rc-card-title">' + g.title + '</p>' +
              '<p class="rc-card-genre">' + (g.genre[0] || '') + '</p>' +
              platformBadge(g.platform) +
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
    var set = {};
    state.games.forEach(function (g) { g.genre.forEach(function (x) { set[x] = true; }); });
    var select = document.getElementById('rcGenre');
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

  function openModal(slug) {
    var g = findGame(slug);
    if (!g) return;
    state.modalGame = g;
    state.plan = 'weekly';
    state.slot = null;
    state.intent = 'new';
    state.step = (g.status === 'upcoming') ? 'plan' : 'intent';
    renderModal();
    document.getElementById('rcModalOverlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    document.getElementById('rcModalOverlay').classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function slotLabel(g, slotKey) {
    return g.status === 'upcoming' ? reservationInfo(g[slotKey].reservationStatus) : availInfo(g[slotKey].available);
  }

  function messengerLink(g, text) {
    return MESSENGER_URL + '?text=' + encodeURIComponent(text);
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
    }
    window.open(messengerLink(g, text), '_blank', 'noopener');
  }

  function renderModal() {
    var g = state.modalGame;
    if (!g) return;
    var body = document.getElementById('rcModalBody');
    var header = '<h2 class="rc-modal-title">' + g.title + '</h2>' +
      platformBadge(g.platform) +
      '<p class="rc-modal-genre">' + g.genre.join(' · ') + (g.releaseDate ? ' · Release ' + releaseDateLabel(g.releaseDate) : '') + '</p>';

    if (state.step === 'intent') { body.innerHTML = header + renderIntentStep(g); wireIntentStep(body); }
    else if (state.step === 'plan') { body.innerHTML = header + renderPlanStep(g); wirePlanStep(body); }
    else { body.innerHTML = header + renderAccessStep(g); wireAccessStep(body); }

    var cover = document.getElementById('rcModalCover');
    cover.src = g.cover || '';
    cover.alt = g.title;
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
      });
    });
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
          '<span class="rc-plan-desc">7 days · 1 swap · 24h cooldown after completed swap</span>' +
          '<span class="rc-plan-tap">Tap to choose</span>' +
        '</button>' +
        '<button type="button" class="rc-plan-card rc-plan-monthly" data-plan="monthly">' +
          '<span class="rc-plan-name">Monthly</span>' +
          '<span class="rc-plan-price">' + peso(g.trophy.monthly) + '</span>' +
          '<span class="rc-plan-desc">30 days · multiple swaps · 24h cooldown after completed swap</span>' +
          '<span class="rc-plan-tap">Tap to choose</span>' +
        '</button>' +
      '</div>';
  }

  function wirePlanStep(body) {
    var back = document.getElementById('rcWizardBack');
    if (back) back.addEventListener('click', function () { state.step = 'intent'; renderModal(); });
    Array.prototype.forEach.call(body.querySelectorAll('.rc-plan-card'), function (btn) {
      btn.addEventListener('click', function () {
        state.plan = btn.getAttribute('data-plan');
        state.step = 'access';
        renderModal();
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
    if (back) back.addEventListener('click', function () { state.step = 'plan'; renderModal(); });
    Array.prototype.forEach.call(body.querySelectorAll('.rc-access-choose'), function (btn) {
      if (btn.hasAttribute('disabled')) return;
      btn.addEventListener('click', function () { finalizeRental(btn.getAttribute('data-slot')); });
    });
  }

  function wireToolbar() {
    var searchInput = document.getElementById('rcSearch');
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
      if (e.target.id === 'rcModalOverlay') closeModal();
    });
    document.getElementById('rcModalClose').addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    var track = document.getElementById('rcComingSoonTrack');
    var prevBtn = document.getElementById('rcSoonPrev');
    var nextBtn = document.getElementById('rcSoonNext');
    if (track && prevBtn && nextBtn) {
      var scrollByAmount = function (dir) {
        var cardWidth = track.firstElementChild ? track.firstElementChild.getBoundingClientRect().width + 16 : 220;
        track.scrollBy({ left: dir * cardWidth * 2, behavior: 'smooth' });
      };
      prevBtn.addEventListener('click', function () { scrollByAmount(-1); });
      nextBtn.addEventListener('click', function () { scrollByAmount(1); });
      track.addEventListener('scroll', updateStripEdges, { passive: true });
      window.addEventListener('resize', updateStripEdges);
    }
  }

  function wireNavSolidOnScroll() {
    var nav = document.querySelector('.navbar');
    if (!nav) return;
    var update = function () { nav.classList.toggle('rc-nav-solid', window.scrollY > 12); };
    document.addEventListener('scroll', update, { passive: true });
    update();
  }

  var RENTAL_RULES = [
    ['Use the correct profile', 'Trophy Slot is played on your personal PSN profile. Non-Trophy Slot is played on the rented game profile.'],
    ['Follow the provided instructions', 'Please follow all setup, game-sharing, return, disabling, and video-proof steps correctly.'],
    ['Rental and swap rules', 'Weekly is valid for 7 days with 1 game swap. Monthly is valid for 30 days with multiple swaps. Every completed swap has a 24-hour cooldown. All swaps are subject to availability. Higher-priced swaps require an add-on; lower-priced swaps have no refund or credit.'],
    ['Wait for confirmation before disabling', 'For swaps, do not disable or remove your current game until June Digitals confirms that your requested slot is ready.'],
    ['Security deposit', 'The ₱150 security deposit is refundable when the rental is returned correctly and on time by following the provided steps. Failure to follow the return instructions may affect the refund or rental access.'],
    ['Please allow us time to reply', 'Requests are handled in order, and we’ll assist you as soon as possible based on staff availability and current request volume.'],
    ['Final availability', 'Availability is rechecked before an available RENT request is handed to Messenger. Do not send payment for waitlist, pre-reserve, or unverified-availability requests unless June Digitals confirms payment is due.']
  ];

  function wireRulesModal() {
    var btn = document.getElementById('rcRulesBtn');
    if (!btn) return;

    var itemsHtml = RENTAL_RULES.map(function (r, i) {
      return '<div class="rc-rules-item">' +
        '<span class="rc-guide-step-num">' + (i + 1) + '</span>' +
        '<div class="rc-rules-item-body"><h4>' + r[0] + '</h4><p>' + r[1] + '</p></div>' +
      '</div>';
    }).join('');

    var overlay = document.createElement('div');
    overlay.className = 'rc-modal-overlay rc-rules-modal';
    overlay.id = 'rcRulesOverlay';
    overlay.innerHTML =
      '<div class="rc-modal">' +
        '<button type="button" class="rc-modal-close" id="rcRulesClose" aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
        '<div class="rc-popup-modal-body">' +
          '<h3 class="rc-modal-title">Rental Rules</h3>' +
          '<p class="rc-modal-genre">Please review these rules before requesting a rental on Messenger.</p>' +
          '<div class="rc-rules-list">' + itemsHtml + '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var closeBtn = document.getElementById('rcRulesClose');
    var open = function () { overlay.classList.add('is-open'); };
    var close = function () { overlay.classList.remove('is-open'); };
    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function wireNavCurrentPage() {
    var path = window.location.pathname;
    var links = document.querySelectorAll('.navbar_list a.link');
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      var isCurrent = href === '/' ? path === '/' : path.indexOf(href) === 0;
      a.classList.toggle('is-current-page', isCurrent);
    });
  }

  function init() {
    wireNavSolidOnScroll();
    wireRulesModal();
    wireNavCurrentPage();
    fetch(DATA_URL).then(function (r) { return r.json(); }).then(function (games) {
      state.games = games;
      populateGenres();
      wireToolbar();
      renderComingSoon();
      renderGrid();

      var params = new URLSearchParams(window.location.search);
      var wanted = params.get('game');
      if (wanted) openModal(wanted);
    }).catch(function (err) { console.error('Catalog load failed', err); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
