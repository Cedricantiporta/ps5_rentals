(function () {
  'use strict';

  var DATA_URL = '/data/games.json';
  var MESSENGER_URL = 'https://m.me/junedigitalaccess';
  var POPULAR_MIN = 5;
  var HIGH_DEMAND_MIN = 10;
  var PAGE_SIZE = 20;

  var state = { games: [], query: '', quickFilter: 'all', genre: '', sort: 'default', modalGame: null, plan: 'weekly', slot: null, page: 1 };

  var ICON_PATHS = {
    trophy: '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>'
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
    state.slot = slotEnabled(g, 'trophy') ? 'trophy' : (slotEnabled(g, 'nontrophy') ? 'nontrophy' : 'trophy');
    renderModal();
    document.getElementById('rcModalOverlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    document.getElementById('rcModalOverlay').classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function renderModal() {
    var g = state.modalGame;
    if (!g) return;
    var body = document.getElementById('rcModalBody');
    var upcoming = g.status === 'upcoming';
    var trophyOn = slotEnabled(g, 'trophy');
    var nontrophyOn = slotEnabled(g, 'nontrophy');
    var priceOf = function (slotKey) { return g[slotKey][state.plan]; };

    body.innerHTML = '' +
      '<h2 class="rc-modal-title">' + g.title + '</h2>' +
      platformBadge(g.platform) +
      '<p class="rc-modal-genre">' + g.genre.join(' · ') + (g.releaseDate ? ' · Release ' + releaseDateLabel(g.releaseDate) : '') + '</p>' +
      '<div class="rc-plan-tabs">' +
        '<button type="button" class="rc-plan-tab" data-plan="weekly">Weekly</button>' +
        '<button type="button" class="rc-plan-tab" data-plan="monthly">Monthly</button>' +
      '</div>' +
      '<div class="rc-slot-options">' +
        '<button type="button" class="rc-slot-option' + (!trophyOn ? ' is-disabled' : '') + '" data-slot="trophy">' +
          '<div class="rc-slot-option-top"><span class="rc-slot-option-name">' + icon('trophy') + ' Trophy</span></div>' +
          '<div class="rc-slot-option-price">Own account · <span class="rc-slot-option-amount">' + peso(priceOf('trophy')) + '</span></div>' +
        '</button>' +
        '<button type="button" class="rc-slot-option' + (!nontrophyOn ? ' is-disabled' : '') + '" data-slot="nontrophy">' +
          '<div class="rc-slot-option-top"><span class="rc-slot-option-name">' + icon('user') + ' Non-Trophy</span></div>' +
          '<div class="rc-slot-option-price">Shared account · <span class="rc-slot-option-amount">' + peso(priceOf('nontrophy')) + '</span></div>' +
        '</button>' +
      '</div>' +
      '<a class="rc-modal-cta" id="rcModalCta" href="' + MESSENGER_URL + '" target="_blank" rel="noopener">' +
        icon('gamepad-2') + ' ' + (upcoming ? 'Pre-Reserve via Messenger' : 'Rent This Game') +
      '</a>' +
      '<p class="rc-modal-note">You’ll be connected on Messenger to confirm your ' + (upcoming ? 'pre-reservation' : 'rental') + ' — mention the game, plan and slot shown above.</p>';

    Array.prototype.forEach.call(body.querySelectorAll('.rc-plan-tab'), function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-plan') === state.plan);
      btn.addEventListener('click', function () { state.plan = btn.getAttribute('data-plan'); renderModal(); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('.rc-slot-option'), function (btn) {
      var key = btn.getAttribute('data-slot');
      btn.classList.toggle('is-active', key === state.slot);
      if (!btn.classList.contains('is-disabled')) {
        btn.addEventListener('click', function () { state.slot = key; renderModal(); });
      }
    });

    var cover = document.getElementById('rcModalCover');
    cover.src = g.cover || '';
    cover.alt = g.title;
  }

  function wireToolbar() {
    document.getElementById('rcSearch').addEventListener('input', function (e) {
      state.query = e.target.value; state.page = 1; renderGrid();
    });
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

  function init() {
    wireNavSolidOnScroll();
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
