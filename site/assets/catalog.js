(function () {
  'use strict';

  var DATA_URL = '/data/games.json';
  var MESSENGER_URL = 'https://m.me/junedigitalaccess';
  var POPULAR_MIN = 5;
  var HIGH_DEMAND_MIN = 10;
  var PAGE_SIZE = 20;

  var state = { games: [], query: '', quickFilter: 'available', genre: '', sort: 'default', modalGame: null, plan: 'weekly', slot: null, page: 1, step: 'intent', intent: 'new', overlayStack: [], modalStepDepth: 0, hold: null, holdError: null, reserving: false, hasActiveRental: null };

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
    'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    share: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>'
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

  // Trophy/Non-Trophy explainer copy for the "?" help badges -- reuses the
  // exact customer-facing wording already used by the per-slot descriptions
  // in renderSimpleAccessStep/renderSwapAccessStep (which matches the
  // chatbot FAQ's "played on your own PSN profile" / "same full game
  // access either way" wording), rather than inventing new copy.
  var TROPHY_HELP_TEXT = 'Play on your own PSN profile. Trophies and saves stay yours.';
  var NONTROPHY_HELP_TEXT = 'Play on the rented game profile with the same full game access.';
  function helpBadge(text) {
    var esc = String(text).replace(/"/g, '&quot;');
    return '<span class="rc-help" tabindex="0" role="button" aria-label="More info" data-help="' + esc + '" title="' + esc + '">?</span>';
  }

  // A single shared bubble (not a per-badge popover) that opens on click/tap
  // next to whichever "?" badge was activated -- works for mouse click and
  // touch tap alike, on top of the native `title` tooltip for mouse hover.
  var helpBubbleEl = null;
  var helpOpenBadge = null;
  function closeHelpBubble() {
    if (helpBubbleEl && helpBubbleEl.parentNode) helpBubbleEl.parentNode.removeChild(helpBubbleEl);
    helpBubbleEl = null;
    helpOpenBadge = null;
  }
  function openHelpBubble(badge) {
    var text = badge.getAttribute('data-help');
    if (!text) return;
    closeHelpBubble();
    var bubble = document.createElement('div');
    bubble.className = 'rc-help-bubble';
    bubble.textContent = text;
    document.body.appendChild(bubble);
    var rect = badge.getBoundingClientRect();
    var top = rect.bottom + window.scrollY + 6;
    var left = rect.left + window.scrollX;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - bubble.offsetWidth - 10;
    if (left > maxLeft) left = Math.max(10, maxLeft);
    bubble.style.top = top + 'px';
    bubble.style.left = left + 'px';
    helpBubbleEl = bubble;
    helpOpenBadge = badge;
  }
  function wireHelpBadges() {
    // Capture phase, not bubble -- a "?" badge sits inside clickable grid
    // cards/coming-soon cards, whose own click-to-open-modal listeners are
    // bound directly on the card element. Stopping propagation from a
    // bubble-phase document listener would run too late (the card's own
    // listener, being closer to the target, already fired); capture runs
    // top-down, before that, so it can actually intercept the click.
    document.addEventListener('click', function (e) {
      var badge = e.target.closest && e.target.closest('.rc-help');
      if (badge) {
        e.preventDefault();
        e.stopPropagation();
        if (helpOpenBadge === badge) closeHelpBubble();
        else openHelpBubble(badge);
        return;
      }
      if (helpBubbleEl) closeHelpBubble();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeHelpBubble(); });
    window.addEventListener('resize', closeHelpBubble);
    document.addEventListener('scroll', closeHelpBubble, true);
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

  // Infinite strip: the prev/next arrows never dead-end at a real boundary
  // any more -- clone padding (see renderComingSoon) means there's always a
  // next/prev card to scroll to, so "can this strip scroll" no longer
  // depends on scrollLeft/maxScroll or even the (now tripled) DOM child
  // count, just on how many REAL cards there are to loop between. Looping a
  // single card would be meaningless, so 0/1 real cards still hide/disable
  // the arrows exactly like before. data-real-count is set by
  // renderComingSoon; the child-count fallback only matters before that's
  // ever run.
  function updateStripEdges() {
    var wrap = document.querySelector('.rc-strip-wrap');
    var track = document.getElementById('rcComingSoonTrack');
    if (!wrap || !track) return;
    var realCount = Number(track.getAttribute('data-real-count')) || track.children.length;
    var canScroll = realCount > 1;
    wrap.classList.toggle('can-scroll-left', canScroll);
    wrap.classList.toggle('can-scroll-right', canScroll);
  }

  // Dot pagination lives in a plain sibling <div> after .rc-strip-wrap,
  // created on demand -- there is no static markup for it in index.html
  // (this file owns catalog.js/.css only, not the page HTML), so the first
  // renderComingSoon() call builds it once and every later call just
  // refreshes its contents.
  function ensureStripDotsEl() {
    var dots = document.getElementById('rcComingSoonDots');
    if (dots) return dots;
    var wrap = document.querySelector('.rc-strip-wrap');
    if (!wrap || !wrap.parentNode) return null;
    dots = document.createElement('div');
    dots.className = 'rc-strip-dots';
    dots.id = 'rcComingSoonDots';
    wrap.parentNode.insertBefore(dots, wrap.nextSibling);
    return dots;
  }

  // Highlights whichever REAL card's center is nearest the CENTER of the
  // currently visible viewport (not whichever card's left edge is nearest
  // the viewport's left edge -- that made the dots track the leftmost
  // visible card, not the one actually centered/focal in the strip). Called
  // after every programmatic scroll (arrows, dot clicks) and on the track's
  // own native scroll event (drag, trackpad, touch), so the indicator
  // tracks the strip regardless of how it was moved. With clone padding
  // (see renderComingSoon) several DOM cards can represent the same real
  // game -- data-real-index maps whichever one wins back to its one dot, so
  // a clone and its real counterpart always light up the same dot.
  function updateStripDots() {
    var track = document.getElementById('rcComingSoonTrack');
    var dots = document.getElementById('rcComingSoonDots');
    if (!track || !dots || !track.children.length) return;
    var viewportCenter = track.scrollLeft + track.clientWidth / 2;
    var best = 0, bestDist = Infinity;
    Array.prototype.forEach.call(track.children, function (card) {
      var center = card.offsetLeft + card.getBoundingClientRect().width / 2;
      var dist = Math.abs(center - viewportCenter);
      if (dist < bestDist) { bestDist = dist; best = Number(card.getAttribute('data-real-index')) || 0; }
    });
    Array.prototype.forEach.call(dots.children, function (dot, i) {
      dot.classList.toggle('is-active', i === best);
    });
  }

  // Scrolls to a REAL card index, but picks whichever clone (or the
  // original) of that index sits closest to the current scroll position --
  // there are up to three DOM cards sharing this real index (one per clone
  // copy, see renderComingSoon), and always jumping to a fixed copy could
  // mean an unnecessarily long scroll across the whole strip when a nearer
  // copy of the same card is right there.
  function scrollToStripCard(index) {
    var track = document.getElementById('rcComingSoonTrack');
    if (!track) return;
    var candidates = Array.prototype.filter.call(track.children, function (card) {
      return Number(card.getAttribute('data-real-index')) === index;
    });
    if (!candidates.length) return;
    var pos = track.scrollLeft, best = candidates[0], bestDist = Infinity;
    candidates.forEach(function (card) {
      var dist = Math.abs(card.offsetLeft - pos);
      if (dist < bestDist) { bestDist = dist; best = card; }
    });
    track.scrollTo({ left: best.offsetLeft, behavior: 'smooth' });
  }

  // A resting "peek" -- the first card sits with ~20% of its left edge
  // already scrolled out of view, rather than flush against the viewport
  // edge, as a carousel affordance that there's more to scroll (per owner
  // feedback). Applied both on initial render and whenever the infinite
  // loop wraps back around to the start (see scrollByAmount) so it's a
  // stable resting look, not a one-off load state that disappears the first
  // time someone loops back to card 1.
  function stripPeekOffset(track) {
    var first = track.children[0];
    if (!first) return 0;
    return first.getBoundingClientRect().width * 0.2;
  }

  // One card's full horizontal step (its own width plus the track's gap) --
  // shared by the arrow-click scroll amount and the silent re-centering
  // check below, both of which need to move/measure in exact card-width
  // increments.
  function stripCardStep(track) {
    var first = track.children[0];
    if (!first) return 0;
    var trackStyle = window.getComputedStyle(track);
    var gap = parseFloat(trackStyle.columnGap || trackStyle.gap) || 0;
    return first.getBoundingClientRect().width + gap;
  }

  // ---- seamless infinite loop via clone padding ----
  // Debounced "settle" check: rather than a mid-scroll (still-animating)
  // jump, which would itself be visible, this waits until scrolling has
  // genuinely stopped -- 140ms with no further scroll event -- before
  // silently repositioning. Covers native scroll (drag/trackpad/touch) and
  // the tail end of a programmatic smooth scrollBy alike, since both fire
  // ordinary 'scroll' events the whole way through and this only acts once
  // those events stop arriving.
  var stripSettleTimer = null;
  function scheduleStripSettle() {
    clearTimeout(stripSettleTimer);
    stripSettleTimer = setTimeout(stripSettleCheck, 140);
  }
  // If scrollLeft has drifted a full card-width past the middle (real) copy's
  // start or end -- i.e. genuinely into the first or third clone copy, not
  // just near the seam -- jump by exactly one copy-width to land on the
  // pixel-identical equivalent spot in the middle copy. The clone is an exact
  // visual duplicate of the real card it copies, so this repositioning is
  // imperceptible; it only ever runs after scrolling has settled (see
  // scheduleStripSettle), never mid-animation.
  function stripSettleCheck() {
    var track = document.getElementById('rcComingSoonTrack');
    if (!track) return;
    var realCount = Number(track.getAttribute('data-real-count')) || 0;
    var copies = Number(track.getAttribute('data-copies')) || 1;
    if (realCount < 2 || copies < 3) return; // nothing to loop between
    var first = track.children[0];
    var midFirst = track.children[realCount];
    if (!first || !midFirst) return;
    var midStart = midFirst.offsetLeft;
    var setWidth = midStart - first.offsetLeft; // exact width of one full copy
    if (!setWidth) return;
    var midEnd = midStart + setWidth;
    var cardStep = stripCardStep(track);
    if (track.scrollLeft < midStart - cardStep) {
      track.scrollLeft += setWidth;
    } else if (track.scrollLeft > midEnd + cardStep) {
      track.scrollLeft -= setWidth;
    }
  }

  // Builds the markup for one real card. realIndex is baked into
  // data-real-index so every clone of this card (see renderComingSoon) can
  // be mapped back to the one dot/real game it represents.
  function buildSoonCardHtml(g, realIndex) {
    var t = reservationInfo(g.trophy.reservationStatus);
    var n = reservationInfo(g.nontrophy.reservationStatus);
    return '' +
      '<div class="rc-soon-card" data-slug="' + g.slug + '" data-real-index="' + realIndex + '">' +
        '<div class="rc-soon-cover-wrap">' +
          '<span class="rc-badge rc-badge-upcoming">Pre-Reserve</span>' +
          '<img class="rc-soon-cover" loading="lazy" src="' + (g.cover || '') + '" alt="' + g.title + '"/>' +
        '</div>' +
        '<div class="rc-soon-body">' +
          (g.genre[0] ? '<span class="rc-soon-genre">' + g.genre[0] + '</span>' : '') +
          '<p class="rc-soon-title">' + g.title + '</p>' +
          '<p class="rc-soon-desc">' + platformBadge(g.platform) + ' Releases ' + releaseDateLabel(g.releaseDate) + '</p>' +
          '<div class="rc-soon-status">' +
            '<div class="rc-slot-row"><span class="rc-slot-label">' + icon('trophy') + ' Trophy' + helpBadge(TROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
            '<div class="rc-slot-row"><span class="rc-slot-label">' + icon('user') + ' Non-Trophy' + helpBadge(NONTROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
          '</div>' +
          '<div class="rc-soon-price-row">' +
            '<div class="rc-soon-price-box"><span class="rc-price-label">Weekly</span><span class="rc-price-value">' + peso(g.trophy.weekly) + '</span></div>' +
            '<div class="rc-soon-price-box"><span class="rc-price-label">Monthly</span><span class="rc-price-value">' + peso(g.trophy.monthly) + '</span></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renderComingSoon() {
    var track = document.getElementById('rcComingSoonTrack');
    var section = document.getElementById('rcComingSoonSection');
    if (!track || !section) return; // no coming-soon strip on this page
    var upcoming = state.games.filter(function (g) { return g.status === 'upcoming'; })
      .sort(function (a, b) { return a.upcomingOrder - b.upcomingOrder; });
    if (!upcoming.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    var realCount = upcoming.length;
    // Clone padding: with more than one real card, render 3 full copies of
    // the list back-to-back ([...copy1 (tail clone), ...copy2 (the "real"
    // middle copy we rest/settle in), ...copy3 (head clone)...]) so there is
    // always a full screen's worth of real-looking content to scroll into in
    // either direction -- scrolling never reaches an actual DOM edge inside
    // normal usage, only the silent settle check (stripSettleCheck) ever
    // "wraps" the position, and it does so invisibly. A single card can't be
    // looped meaningfully, so it gets one copy, same as before.
    var copies = realCount > 1 ? 3 : 1;
    var cardsHtml = upcoming.map(function (g, i) { return buildSoonCardHtml(g, i); });
    var allHtml = [];
    for (var c = 0; c < copies; c++) { allHtml = allHtml.concat(cardsHtml); }
    track.innerHTML = allHtml.join('');
    track.setAttribute('data-real-count', String(realCount));
    track.setAttribute('data-copies', String(copies));

    // Every card, real or cloned, represents the same underlying game --
    // wire the exact same click-to-open-modal behavior on all of them.
    Array.prototype.forEach.call(track.children, function (card) {
      card.addEventListener('click', function () { openModal(card.getAttribute('data-slug')); });
    });

    // Rest at the START of the MIDDLE copy (plus the usual peek offset) so
    // there's a full copy's worth of scrollable room in both directions
    // immediately, rather than resting at the literal start of the DOM
    // where "prev" would have nowhere real-looking to go.
    var peek = stripPeekOffset(track);
    if (copies > 1) {
      var midFirst = track.children[realCount];
      track.scrollLeft = (midFirst ? midFirst.offsetLeft : 0) + peek;
    } else {
      track.scrollLeft = peek;
    }
    updateStripEdges();

    var dotsEl = ensureStripDotsEl();
    if (dotsEl) {
      if (upcoming.length > 1) {
        dotsEl.style.display = '';
        dotsEl.innerHTML = upcoming.map(function (g, i) {
          return '<button type="button" class="rc-strip-dot' + (i === 0 ? ' is-active' : '') + '" data-index="' + i + '" aria-label="Go to ' + String(g.title).replace(/"/g, '&quot;') + '"></button>';
        }).join('');
        Array.prototype.forEach.call(dotsEl.children, function (dot) {
          dot.addEventListener('click', function () { scrollToStripCard(Number(dot.getAttribute('data-index'))); });
        });
      } else {
        dotsEl.style.display = 'none';
        dotsEl.innerHTML = '';
      }
    }
    updateStripDots();
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
              '<div class="rc-slot-row"><span class="rc-slot-label">' + icon('trophy') + ' Trophy' + helpBadge(TROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
              '<div class="rc-slot-row"><span class="rc-slot-label">' + icon('user') + ' Non-Trophy' + helpBadge(NONTROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
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
    state.reserving = false;
    state.intent = 'new';
    state.hasActiveRental = null;
    state.step = (g.status === 'upcoming') ? 'plan' : 'intent';
    renderModal();
    if (state.step === 'intent') checkHasActiveRental();
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

  // Swap only makes sense for someone who already has SOME active rental
  // (elsewhere) to swap out -- otherwise "Swap Current Rental" is a lie the
  // old Messenger-text flow let anyone claim regardless. Sets
  // state.hasActiveRental (true/false) and re-renders the intent step if
  // it's still showing for the same game once the check resolves; defaults
  // to false (disabled) until then, and on any failure, so the button never
  // sits enabled without a confirmed active rental behind it.
  function checkHasActiveRental() {
    var g = state.modalGame;
    function resolve(val) {
      state.hasActiveRental = val;
      if (state.modalGame === g && state.step === 'intent') renderModal();
    }
    if (!window.RCAccount) { resolve(false); return; }
    window.RCAccount.getSession().then(function (session) {
      if (session) {
        var sb = window.RCAccount.getClient();
        return window.RCAccount.ensureRenter().then(function (row) {
          var renterId = row && row.renter_id;
          if (!renterId || !sb) return false;
          return sb.from('rentals').select('id').eq('renter_id', renterId).eq('status', 'active').limit(1)
            .then(function (res) { return !res.error && (res.data || []).length > 0; });
        });
      }
      var code = window.RCAccount.loadGuestCode();
      if (!code) return false;
      var sb2 = window.RCAccount.getClient();
      if (!sb2) return false;
      return sb2.rpc('lookup_rentals_by_code', { p_code: code }).then(function (res) {
        if (res.error) return false;
        return (res.data || []).some(function (r) { return r.status === 'active'; });
      });
    }).then(resolve, function () { resolve(false); });
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
  // Registration is deferred to the "I've Paid" click (see
  // confirmPaymentSent) -- picking a slot (chooseNewRentalSlot) only shows
  // payment instructions computed client-side, with NO RPC call and NO
  // database write, so a customer who looks at the price and closes the tab
  // never leaves behind a renter/rental row. create_rental_hold() only runs
  // once the customer claims to have paid. Pre-migration (RPCs not deployed
  // yet) or any Supabase failure at THAT point must fail soft back to the
  // exact old pure-Messenger behaviour -- submitRentalRequest() + open
  // Messenger -- so the live site never breaks for a real customer while a
  // migration hasn't landed or the Supabase client itself is unavailable.
  // See RENT-FLOW-CONTRACT.md. Because nothing is held before the click,
  // there is no "slot held for X minutes" countdown to show on the pending
  // screen -- see renderPaymentPending.

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

  // Rent-count now lives here (modal header) instead of the grid card's
  // cover -- see badgeFor/renderGrid, which no longer render rc-count-badge.
  // g.activeRentals (mapGameRow: row.times_rented) is a persisted, all-time
  // lifetime counter, not a live "currently renting" count -- the label
  // reflects that (past tense, no "person"/"people" occupancy wording) so it
  // doesn't imply present-tense activity that isn't true.
  function rentedNote(g) {
    if (!g.activeRentals) return '';
    var n = g.activeRentals > 99 ? '99+' : g.activeRentals;
    var label = g.activeRentals === 1 ? 'Rented once' : 'Rented ' + n + ' times';
    return '<p class="rc-modal-rented">' + icon('refresh-cw') + ' ' + label + '</p>';
  }

  function buildModalHeader(g) {
    return '<h2 class="rc-modal-title">' + g.title + '</h2>' +
      '<div class="rc-modal-meta-row">' + platformBadge(g.platform) + rentedNote(g) + '</div>' +
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
      // migration_20 only -- a full pre-release reservation queue. Absent/
      // impossible pre-migration since the queue itself doesn't exist yet.
      case 'reservation_full': return 'This reservation is full for now — check back later or message us.';
      default: return 'Something went wrong reserving your slot. Please go back and try again, or message us on Messenger.';
    }
  }

  function renderPaymentFailure(code) {
    return '' +
      '<div class="rc-wizard-header-row">' +
        '<div class="rc-wizard-heading">Couldn\'t reserve that slot</div>' +
        '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Back</button>' +
      '</div>' +
      '<p class="rc-wizard-sub">' + holdErrorMessage(code) + '</p>';
  }

  // Shown the instant a slot is picked (see chooseNewRentalSlot) -- no RPC
  // has run yet and nothing is held, so deliberately no reference code and
  // no "slot held for X minutes" countdown here. Amount is computed straight
  // from state.games (already loaded client-side for the catalog grid, no
  // RPC needed); the GCash number/name come from the read-only
  // get_public_settings() cache (loadPublicSettings/publicSettings -- see
  // openModal, which already fetches it) rather than a fresh call, since
  // that call creates nothing and was already being made for the plan step's
  // swap-limit copy.
  function renderPaymentPending(g) {
    var slotKey = state.slot;
    var planName = state.plan === 'weekly' ? 'Weekly' : 'Monthly';
    var amount = peso(slotKey && g[slotKey] ? g[slotKey][state.plan] : null);
    var gcashNumber = publicSettings && publicSettings.gcash_number;
    var gcashName = publicSettings && publicSettings.gcash_name;
    var settingsReady = !!(gcashNumber || gcashName);
    return '' +
      '<div class="rc-wizard-header-row">' +
        '<div class="rc-wizard-heading">Send Payment via GCash</div>' +
        '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Back</button>' +
      '</div>' +
      '<p class="rc-wizard-sub">Nothing is reserved yet. Send the exact amount below, then tap the button once you\'ve paid to lock in your slot.</p>' +
      '<div class="rc-pay-summary">' +
        '<div class="rc-pay-row"><span>Game</span><b>' + g.title + '</b></div>' +
        '<div class="rc-pay-row"><span>Access</span><b>' + slotDisplayName(slotKey) + '</b></div>' +
        '<div class="rc-pay-row"><span>Plan</span><b>' + planName + '</b></div>' +
        '<div class="rc-pay-row rc-pay-row-amount"><span>Amount Due</span><b>' + amount + '</b></div>' +
      '</div>' +
      '<div class="rc-pay-gcash">' +
        (settingsReady ? '' +
          '<div class="rc-pay-field">' +
            '<span class="rc-pay-field-label">GCash Number</span>' +
            '<div class="rc-pay-field-row">' +
              '<span class="rc-pay-field-value">' + (gcashNumber || '—') + '</span>' +
              (gcashNumber ? '<button type="button" class="rc-pay-copy" id="rcCopyGcash" data-copy="' + gcashNumber + '">Copy</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="rc-pay-field">' +
            '<span class="rc-pay-field-label">GCash Name</span>' +
            '<div class="rc-pay-field-row"><span class="rc-pay-field-value">' + (gcashName || '—') + '</span></div>' +
          '</div>'
        : '<p class="rc-pay-loading-text">Loading payment details…</p>') +
      '</div>' +
      '<p class="rc-pay-instruction">Send ' + amount + ' to this number, then tap the button below once you\'ve sent it.</p>' +
      '<button type="button" class="rc-modal-cta rc-pay-cta" id="rcPaySentBtn">' + icon('message-circle') + ' I\'ve paid — send screenshot</button>';
  }

  function paymentConfirmedMessengerText(g, hold) {
    var planName = state.plan === 'weekly' ? 'Weekly' : 'Monthly';
    return 'Hi! I\'ve paid for "' + g.title + '" — ' + slotDisplayName(state.slot) + ' access, ' +
      planName + ' plan (' + peso(hold.amount) + '). Ref: ' + hold.ref_code + '. Attaching my GCash screenshot.';
  }

  // Shown once create_rental_hold() has actually succeeded (see
  // confirmPaymentSent) -- the first moment a real ref_code and tracking
  // code exist. Messenger opens shortly after this renders (see
  // openMessengerAfterHold), so the customer sees their ref code -- and
  // queue position, if this was a pre-release reservation -- before/while
  // being sent there, instead of losing it entirely.
  function renderPaymentConfirmed(g, hold) {
    var planName = state.plan === 'weekly' ? 'Weekly' : 'Monthly';
    var amount = peso(hold.amount);
    var queueBlock = '';
    // queue_position only exists post-migration_20, and only for a
    // reservation on an upcoming/not-yet-released game -- undefined/null
    // here just means "not a queued reservation", not an error.
    if (hold.queue_position !== undefined && hold.queue_position !== null) {
      var limit = publicSettings && publicSettings.reservation_queue_limit;
      queueBlock = '<div class="rc-pay-queue">You\'re <b>#' + hold.queue_position + '</b>' +
        (limit ? ' of ' + limit : '') + ' in line for this reservation.</div>';
    }
    return '' +
      '<div class="rc-wizard-heading">You\'re confirmed — opening Messenger…</div>' +
      '<p class="rc-wizard-sub">Send your GCash payment screenshot on Messenger to finish confirming your rental.</p>' +
      queueBlock +
      '<div class="rc-pay-summary">' +
        '<div class="rc-pay-row"><span>Game</span><b>' + g.title + '</b></div>' +
        '<div class="rc-pay-row"><span>Access</span><b>' + slotDisplayName(state.slot) + '</b></div>' +
        '<div class="rc-pay-row"><span>Plan</span><b>' + planName + '</b></div>' +
        '<div class="rc-pay-row rc-pay-row-amount"><span>Amount Due</span><b>' + amount + '</b></div>' +
      '</div>' +
      '<div class="rc-pay-gcash">' +
        '<div class="rc-pay-field">' +
          '<span class="rc-pay-field-label">Reference Code</span>' +
          '<div class="rc-pay-field-row">' +
            '<span class="rc-pay-field-value rc-pay-refcode">' + hold.ref_code + '</span>' +
            '<button type="button" class="rc-pay-copy" id="rcCopyRef" data-copy="' + hold.ref_code + '">Copy</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p class="rc-pay-instruction">Put <b>' + hold.ref_code + '</b> in the Messenger message/note along with your screenshot. Redirecting you now — <a href="' + messengerLink(g, paymentConfirmedMessengerText(g, hold)) + '">tap here</a> if it doesn\'t open.</p>' +
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
    if (state.holdError) return renderPaymentFailure(state.holdError);
    if (state.hold) return renderPaymentConfirmed(g, state.hold);
    return renderPaymentPending(g);
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

    // Only present on the pending screen (no hold yet, no error) -- this is
    // now the actual trigger for create_rental_hold(), not a static
    // already-reserved confirmation button. See confirmPaymentSent.
    var sendBtn = document.getElementById('rcPaySentBtn');
    if (sendBtn) sendBtn.addEventListener('click', confirmPaymentSent);
  }

  // Called when a customer picks an access slot for a brand-new rental
  // (never for swaps -- see wireAccessStep). Per owner instruction ("only if
  // you click i've paid... then it will be on the renters list and on the
  // admin app"), picking a slot no longer calls create_rental_hold() -- it
  // only shows the payment instructions (amount computed client-side, GCash
  // info from the cached get_public_settings() call). No RPC, no database
  // write, so a customer who looks at the price and leaves never creates a
  // renter/rental row. Registration happens on the "I've Paid" click --
  // see confirmPaymentSent.
  function chooseNewRentalSlot(slotKey) {
    var g = state.modalGame;
    if (!g) return;
    state.slot = slotKey;
    state.hold = null;
    state.holdError = null;
    state.reserving = false;
    state.step = 'payment';
    renderModal();
    pushStepState();
  }

  // Fires on the "I've paid — send screenshot" click -- THE moment a renter
  // row (if new) and a pending rentals row actually get created. On success,
  // opens Messenger with the real ref code. A structural failure (Supabase
  // client missing entirely, or the RPC promise itself rejecting instead of
  // resolving) falls all the way back to the pre-existing Messenger-only
  // flow (submitRentalRequest + messengerLink, via finalizeRental) so the
  // customer is never left stuck -- same safety net the old eager-hold flow
  // relied on. A response that actually came back from the server (res.error
  // as a resolved PostgREST error, or ok:false) is different: the
  // reservation attempt definitely ran, so this shows the plain-language
  // error inline and does NOT open Messenger, letting the customer go back
  // and pick a different slot/game instead of messaging in with no matching
  // rental on file.
  function confirmPaymentSent() {
    var g = state.modalGame;
    var slotKey = state.slot;
    if (!g || !slotKey || state.reserving) return;
    state.reserving = true;
    renderHoldSpinner(g);

    var sb = getPublicSupabase();
    if (!sb) { state.reserving = false; renderModal(); finalizeRental(slotKey); return; }

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
        // code rather than failing outright -- losing the renter-reuse
        // nicety beats losing the rental.
        if (res && res.error) {
          delete args.p_public_code;
          return sb.rpc('create_rental_hold', args);
        }
        return res;
      });
    }).then(function (res) {
      state.reserving = false;
      if (state.modalGame !== g || state.slot !== slotKey) return; // stale -- customer moved on
      if (!res || res.error) {
        state.holdError = null; // unrecognized/transport error -> generic message
        state.hold = null;
        renderModal();
        return;
      }
      var row = res.data && res.data[0];
      if (!row || !row.ok) {
        state.holdError = (row && row.error) || null;
        state.hold = null;
        renderModal();
        return;
      }
      state.hold = row;
      state.holdError = null;
      saveTrackCode(row.public_code);
      renderModal();
      openMessengerAfterHold(g, row);
    }, function () {
      state.reserving = false;
      if (state.modalGame !== g) return;
      renderModal();
      // Deferred, post-RPC-rejection -- not a direct click result, so this
      // must be same-tab (see finalizeRental's sameTab comment above).
      finalizeRental(slotKey, true);
    });
  }

  // Sends the customer to Messenger once create_rental_hold() has actually
  // succeeded. This can no longer be a synchronous window.open('_blank') in
  // the click handler -- by the time the RPC promise above resolves, the
  // click's "user gesture" window has often expired, and browsers commonly
  // (and silently) block a new-tab window.open() that isn't a direct,
  // synchronous result of user input. Same-tab navigation is never subject
  // to that popup-blocker check, so it's used here instead for this specific
  // deferred case -- verified working in a real browser test (see the
  // commit/report for how). Trade-off: this leaves the site instead of
  // opening Messenger in a new tab. finalizeRental's synchronous, same-click
  // window.open (swaps, and the structural-failure fallback above) is
  // untouched. The short delay lets the confirmation screen (ref code, and
  // queue position for a pre-release reservation) actually be seen before
  // the page navigates away.
  function openMessengerAfterHold(g, hold) {
    var url = messengerLink(g, paymentConfirmedMessengerText(g, hold));
    setTimeout(function () {
      if (state.modalGame !== g || state.hold !== hold) return; // customer already moved on
      window.location.href = url;
    }, 1400);
  }

  // sameTab: pass true when this isn't a direct, synchronous result of the
  // user's click (e.g. after an awaited RPC has already resolved/rejected)
  // -- same reasoning as openMessengerAfterHold above, window.open in that
  // deferred case risks a silent popup-block (or, if not blocked, a
  // needlessly surprising new tab). The swap path and confirmPaymentSent's
  // synchronous "!sb" fallback call this with no sameTab arg since they run
  // inside the click's own call stack, where window.open is safe.
  function finalizeRental(slotKey, sameTab) {
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
    var url = messengerLink(g, text);
    if (sameTab) window.location.href = url;
    else window.open(url, '_blank', 'noopener');
  }

  function renderModal() {
    var g = state.modalGame;
    if (!g) return;
    var body = document.getElementById('rcModalBody');
    var header = buildModalHeader(g);

    if (state.step === 'intent') { body.innerHTML = header + renderIntentStep(g); wireIntentStep(body); }
    else if (state.step === 'plan') { body.innerHTML = header + renderPlanStep(g); wirePlanStep(body); }
    else if (state.step === 'payment') {
      body.innerHTML = header + renderPaymentStep(g);
      wirePaymentStep(body);
    }
    else { body.innerHTML = header + renderAccessStep(g); wireAccessStep(body); }

    var cover = document.getElementById('rcModalCover');
    cover.src = g.cover || '';
    cover.alt = g.title;

    var modalEl = document.querySelector('.rc-modal');
    modalEl.classList.toggle('rc-modal-compact', state.step !== 'intent');
  }

  function renderIntentStep(g) {
    var swapEligible = state.hasActiveRental === true;
    var swapDesc = swapEligible
      ? 'Active renters: request this game as your replacement title.'
      : "You'll need an active rental first -- this is for swapping one you already have.";
    return '' +
      '<div class="rc-wizard-heading">What do you want to do with this game?</div>' +
      '<p class="rc-wizard-sub">Choose one: start a new rental or swap an active rental.</p>' +
      '<div class="rc-choice-grid">' +
        '<button type="button" class="rc-choice-card rc-choice-new" data-intent="new">' +
          '<span class="rc-choice-icon">' + icon('gamepad-2') + '</span>' +
          '<span class="rc-choice-name">New Rental</span>' +
          '<span class="rc-choice-desc">Rent this game as a new or additional subscription.</span>' +
        '</button>' +
        '<button type="button" class="rc-choice-card rc-choice-swap"' + (swapEligible ? '' : ' disabled') + ' data-intent="swap">' +
          '<span class="rc-choice-icon">' + icon('refresh-cw') + '</span>' +
          '<span class="rc-choice-name">Swap Current Rental</span>' +
          '<span class="rc-choice-desc">' + swapDesc + '</span>' +
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
      // The plan step, or the pending-payment step, may already be on
      // screen with the fallback copy -- refresh once real settings arrive.
      // Skipped while create_rental_hold() is actually in flight
      // (state.reserving) so this can't clobber the "Reserving your slot…"
      // spinner mid-request.
      if (state.step === 'plan' || (state.step === 'payment' && !state.reserving)) renderModal();
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
      '<div class="rc-wizard-header-row">' +
        '<div class="rc-wizard-heading">Weekly or Monthly?</div>' +
        (upcoming ? '' : '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Change Action</button>') +
      '</div>' +
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
      '<div class="rc-wizard-header-row">' +
        '<div class="rc-wizard-heading">Trophy or Non-Trophy?</div>' +
        '<button type="button" class="rc-wizard-back" id="rcWizardBack">' + icon('chevron-left') + ' Change Plan</button>' +
      '</div>' +
      '<p class="rc-wizard-sub">Trophy: play on your own PSN profile, trophies and saves stay yours. Non-Trophy: play on the rented game profile with full game access either way.</p>' +
      '<div class="rc-access-grid rc-access-grid-simple">' +
        '<div class="rc-access-card' + (!trophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('trophy') + ' Trophy' + helpBadge(TROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
          '<p class="rc-access-desc">Play on your own PSN profile. Trophies and saves stay yours.</p>' +
          '<button type="button" class="rc-access-choose" data-slot="trophy"' + (!trophyOn ? ' disabled' : '') + '>' + actionWord + ' — Trophy</button>' +
        '</div>' +
        '<div class="rc-access-card' + (!nontrophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('user') + ' Non-Trophy' + helpBadge(NONTROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
          '<p class="rc-access-desc">Play on the rented game profile with the same full game access.</p>' +
          '<button type="button" class="rc-access-choose" data-slot="nontrophy"' + (!nontrophyOn ? ' disabled' : '') + '>' + actionWord + ' — Non-Trophy</button>' +
        '</div>' +
      '</div>';
  }

  // Simplified per owner feedback (too busy): dropped the numbered 1-2-3
  // process chips (explains process, not a decision), the "First Available"
  // third option (redundant with just picking whichever slot shows OPEN),
  // and the trailing checklist + explainer paragraph -- collapsed to one
  // heading + one subtext line, matching renderSimpleAccessStep's shape.
  function renderSwapAccessStep(g) {
    var trophyOn = slotEnabled(g, 'trophy');
    var nontrophyOn = slotEnabled(g, 'nontrophy');
    var t = slotLabel(g, 'trophy');
    var n = slotLabel(g, 'nontrophy');

    return '' +
      '<span class="rc-wizard-eyebrow">CURRENT RENTER SWAP</span>' +
      '<div class="rc-wizard-heading">Trophy or Non-Trophy?</div>' +
      '<p class="rc-wizard-sub">We\'ll confirm your plan and cooldown on Messenger before finalizing.</p>' +
      '<div class="rc-access-grid rc-access-grid-simple">' +
        '<div class="rc-access-card' + (!trophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('trophy') + ' Trophy' + helpBadge(TROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + t.cls + '"><span class="rc-dot"></span>' + t.label + '</span></div>' +
          '<p class="rc-access-desc">Play on your own PSN profile. Trophies and saves stay yours.</p>' +
          '<button type="button" class="rc-access-choose" data-slot="trophy"' + (!trophyOn ? ' disabled' : '') + '>Choose Trophy</button>' +
        '</div>' +
        '<div class="rc-access-card' + (!nontrophyOn ? ' is-disabled' : '') + '">' +
          '<div class="rc-access-top"><span class="rc-access-name">' + icon('user') + ' Non-Trophy' + helpBadge(NONTROPHY_HELP_TEXT) + '</span><span class="rc-slot-status ' + n.cls + '"><span class="rc-dot"></span>' + n.label + '</span></div>' +
          '<p class="rc-access-desc">Play on the rented game profile with the same full game access.</p>' +
          '<button type="button" class="rc-access-choose" data-slot="nontrophy"' + (!nontrophyOn ? ' disabled' : '') + '>Choose Non-Trophy</button>' +
        '</div>' +
      '</div>';
  }

  function wireAccessStep(body) {
    var back = document.getElementById('rcWizardBack');
    if (back) back.addEventListener('click', function () { window.history.back(); });

    function chooseSlot(slotKey) {
      // Swaps keep their existing Messenger-only behaviour untouched --
      // only a brand-new rental goes through the self-serve hold/payment
      // step (see chooseNewRentalSlot).
      if (state.intent === 'swap') finalizeRental(slotKey);
      else chooseNewRentalSlot(slotKey);
    }

    // The whole card selects its slot, not just the pill button inside it --
    // per owner feedback, clicking anywhere on an enabled card (the cover
    // icon, the description text, the status pill) should work exactly like
    // clicking the button, not just the button itself. The "?" help badge
    // is exempted automatically: wireHelpBadges() intercepts it in the
    // capture phase before this bubble-phase listener ever runs.
    Array.prototype.forEach.call(body.querySelectorAll('.rc-access-card'), function (card) {
      if (card.classList.contains('is-disabled')) return;
      var btn = card.querySelector('.rc-access-choose');
      var slotKey = btn && btn.getAttribute('data-slot');
      if (!slotKey) return;
      card.classList.add('is-clickable');
      card.addEventListener('click', function () { chooseSlot(slotKey); });
    });

    // The button itself still works independently (keyboard/tab users who
    // land on the button via Tab, not a mouse click on the card) -- guard
    // against double-firing when a click on the button also bubbles up to
    // the card's own listener above by stopping it there.
    Array.prototype.forEach.call(body.querySelectorAll('.rc-access-choose'), function (btn) {
      if (btn.hasAttribute('disabled')) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        chooseSlot(btn.getAttribute('data-slot'));
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
      // Seamless infinite strip: clone padding (see renderComingSoon) means
      // there's always a next/prev card to scroll to in either direction
      // within normal usage, so this is now just a plain one-card scrollBy
      // with NO boundary-check/jump logic. The only thing that keeps the
      // real scroll position from eventually drifting into (and, with
      // extremely fast repeated clicking, potentially running out of) clone
      // room is the silent re-centering check scheduled on every 'scroll'
      // event below (scheduleStripSettle/stripSettleCheck).
      var scrollByAmount = function (dir) {
        var realCount = Number(track.getAttribute('data-real-count')) || track.children.length;
        if (realCount < 2) return; // nothing to loop between
        var cardStep = stripCardStep(track);
        track.scrollBy({ left: dir * cardStep, behavior: 'smooth' });
      };
      prevBtn.addEventListener('click', function () { scrollByAmount(-1); });
      nextBtn.addEventListener('click', function () { scrollByAmount(1); });
      track.addEventListener('scroll', function () {
        updateStripDots();
        scheduleStripSettle();
      }, { passive: true });
      window.addEventListener('resize', updateStripEdges);
      window.addEventListener('resize', updateStripDots);

      // mouse users have no touch/trackpad gesture to scroll a horizontal
      // strip with -- let them click-and-drag it like a native carousel.
      // Setting track.scrollLeft below fires native 'scroll' events just
      // like a real drag/trackpad/touch scroll would, so the listener
      // wired above (updateStripDots + scheduleStripSettle) already covers
      // this for free -- once the drag ends and scrollLeft stops changing,
      // the same debounced settle check silently re-centers if needed, no
      // extra wiring required here.
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
    wireHelpBadges();
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

  // ---- Portable "open game modal" hook (window.RCCatalog) ----
  // Lets a page other than index.html/the game-detail pages open this
  // site's rent/swap modal without duplicating its markup or wizard logic
  // (e.g. site/account/* opening a past rental's game so the customer can
  // rent again or swap).
  //
  // To use this from another page:
  //   1. Include, in this order, the same things any page with this modal
  //      already has:
  //        <link rel="stylesheet" href="/assets/catalog.css">
  //        <script>window.RC_PUBLIC_CONFIG = { SUPABASE_URL: '...', SUPABASE_ANON_KEY: '...' };</script>
  //        the supabase-js CDN <script> tag
  //        <script src="/assets/catalog.js"></script>
  //   2. Call: window.RCCatalog.openModal('some-game-slug')
  //
  // That's it -- the page does NOT need to already contain the modal's
  // static #rcModalOverlay/#rcModalBody markup (see ensureModalShell below),
  // and does NOT need to have rendered a catalog grid/coming-soon strip on
  // its own (loadGames() is called fresh here and state.games is filled in
  // before the modal opens, whether or not init()'s own load already ran).
  // This is purely additive: index.html and the game-detail pages, which
  // already have the static markup and already call init() -> loadGames()
  // on their own, behave exactly as before.

  // The modal markup is normally static HTML baked into index.html
  // (#rcModalOverlay > .rc-modal > share/close buttons, #rcModalCover,
  // #rcModalBody) that this file merely queries by id. A page that never
  // copied that boilerplate has none of it, so build the same structure by
  // hand and append it to <body> -- everything downstream (openModal,
  // renderModal, wirePaymentStep, etc.) only ever looks these ids up via
  // document.getElementById/querySelector, so it can't tell the difference.
  function ensureModalShell() {
    if (document.getElementById('rcModalOverlay')) return;
    var overlay = el(
      '<div id="rcModalOverlay" class="rc-modal-overlay">' +
        '<div class="rc-modal">' +
          '<button type="button" class="rc-modal-share" id="rcModalShare" aria-label="Share this game">' + icon('share') + '</button>' +
          '<button type="button" class="rc-modal-close" id="rcModalClose" aria-label="Close">' + icon('x') + '</button>' +
          '<img id="rcModalCover" class="rc-modal-cover" src="" alt=""/>' +
          '<div class="rc-modal-body" id="rcModalBody"></div>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(overlay);
    // wireToolbar() normally wires the overlay backdrop-click/close-button
    // handlers, but wireToolbar() bails out immediately on a page with no
    // #rcSearch (i.e. no catalog toolbar) -- exactly the kind of page this
    // hook targets -- so wire them here instead.
    overlay.addEventListener('click', function (e) {
      if (e.target.id === 'rcModalOverlay') hardCloseOverlay('modal');
    });
    document.getElementById('rcModalClose').addEventListener('click', function () { hardCloseOverlay('modal'); });
    // Share stays hidden (display:none in catalog.css) same as on the
    // pages that already ship this markup -- see wireShareModal's comment.
  }

  window.RCCatalog = {
    openModal: function (slug) {
      ensureModalShell();
      loadGames().then(function (games) {
        state.games = games;
        openModal(slug, true);
      }).catch(function (err) { console.error('RCCatalog.openModal failed', err); });
    }
  };
})();
