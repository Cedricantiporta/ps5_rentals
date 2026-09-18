// Shared helpers for the customer account pages (login.html, index.html).
// Vanilla JS, ES5-ish (var, .then chains) to match catalog.js/admin.js style.
//
// IMPORTANT: this client is deliberately isolated from the admin client in
// site/admin/admin.js. Both point at the same Supabase project, and
// supabase-js's default storageKey is derived from the project URL alone
// ("sb-<ref>-auth-token") -- so two default-configured clients in the same
// browser would silently overwrite each other's session. We give the
// customer client its own storageKey so an admin and a customer session can
// coexist in the same browser without stomping each other.
(function () {
  'use strict';

  var CUSTOMER_STORAGE_KEY = 'rc-customer-auth-token';

  // Tracking-code guest portal (track.html) behaves like an auto-login:
  // once a customer has a code, it's remembered across tabs/restarts so
  // they never have to type it again. This exact key/plain-string shape is
  // a cross-agent contract -- site/assets/catalog.js (owned by another
  // agent) writes this same key the instant a rent request succeeds, so a
  // customer who just rented lands in the portal already tracked. Do not
  // rename the key or wrap the value (e.g. JSON) without updating that
  // agent's code too. Kept separate from CUSTOMER_STORAGE_KEY -- a guest
  // code and a signed-in session are unrelated, independent ways into the
  // portal (see RENT-FLOW-CONTRACT.md). localStorage throws in
  // private-browsing / storage-blocked modes, so every read and write here
  // is wrapped -- a guest who can't persist the code just has to retype
  // it; the page must never break because of it.
  var GUEST_CODE_KEY = 'rc-track-code';
  function saveGuestCode(code) {
    try { window.localStorage.setItem(GUEST_CODE_KEY, code); } catch (e) {}
  }
  function loadGuestCode() {
    try { return window.localStorage.getItem(GUEST_CODE_KEY) || ''; } catch (e) { return ''; }
  }
  function clearGuestCode() {
    try { window.localStorage.removeItem(GUEST_CODE_KEY); } catch (e) {}
  }

  // Accepts a renters.public_code ("JD-XXXXXX") or a rentals.ref_code
  // ("R-XXXXXX") per RENT-FLOW-CONTRACT.md, case-insensitively and tolerant
  // of surrounding whitespace and a missing prefix. When a recognizable
  // JD/R prefix is present (with or without its dash) it's normalized to
  // "PREFIX-REST"; otherwise the trimmed/uppercased/whitespace-stripped
  // value is sent as-is and left to the RPC to match.
  function normalizeTrackingCode(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
    var m = /^(JD|R)-?(.+)$/.exec(s);
    if (m && m[2]) return m[1] + '-' + m[2];
    return s;
  }

  var client = null;
  function getClient() {
    if (client) return client;
    if (!window.supabase || !window.RC_PUBLIC_CONFIG || !window.RC_PUBLIC_CONFIG.SUPABASE_URL) return null;
    client = window.supabase.createClient(
      window.RC_PUBLIC_CONFIG.SUPABASE_URL,
      window.RC_PUBLIC_CONFIG.SUPABASE_ANON_KEY,
      { auth: { persistSession: true, storageKey: CUSTOMER_STORAGE_KEY, storage: window.localStorage } }
    );
    return client;
  }

  function getSession() {
    var sb = getClient();
    if (!sb) return Promise.resolve(null);
    return sb.auth.getSession().then(function (res) {
      return (res.data && res.data.session) || null;
    }, function () { return null; });
  }

  // Redirects to the login page when signed out; resolves with the session
  // otherwise. Used by index.html (the portal) as its gate.
  function requireAuth() {
    return getSession().then(function (session) {
      if (!session) {
        window.location.href = '/account/login.html';
        return null;
      }
      return session;
    });
  }

  // Calls the ensure_my_renter() RPC (see supabase/migration_12_renter_claiming_rpc.sql)
  // so a signed-in customer with no renters row yet (fresh signup, or an
  // orphaned account from before the migration shipped) gets one created
  // right now, before we query rentals. Deliberately fails silently: if the
  // migration hasn't been applied yet the RPC won't exist (PostgREST answers
  // with a 404/PGRST202), and the portal must still load and fall back to
  // its existing "no rental history linked yet" state rather than breaking.
  function ensureRenter() {
    var sb = getClient();
    if (!sb) return Promise.resolve(null);
    return sb.rpc('ensure_my_renter').then(function (res) {
      if (res.error) {
        console.warn('June Digitals: ensure_my_renter RPC unavailable (migration not applied yet?)', res.error);
        return null;
      }
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      return row || null;
    }, function (err) {
      console.warn('June Digitals: ensure_my_renter call failed', err);
      return null;
    });
  }

  function signOut() {
    var sb = getClient();
    if (!sb) return Promise.resolve();
    return sb.auth.signOut().then(function () {
      window.location.href = '/account/login.html';
    });
  }

  // ---- formatting helpers, matching the conventions in assets/catalog.js
  // and admin/dashboard.js so the portal reads like the same site. ----

  function peso(n) { return (n === null || n === undefined || isNaN(n)) ? '—' : '₱' + Number(n).toLocaleString('en-PH'); }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function daysLeft(endIso) {
    if (!endIso) return null;
    var end = new Date(endIso + 'T00:00:00');
    if (isNaN(end.getTime())) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((end - today) / 86400000);
  }

  function daysLeftLabel(endIso) {
    var n = daysLeft(endIso);
    if (n === null) return '—';
    if (n < 0) return 'Ended ' + Math.abs(n) + 'd ago';
    if (n === 0) return 'Ends today';
    return n + 'd left';
  }

  function slotName(slot) { return slot === 'trophy' ? 'Trophy' : 'Non-Trophy'; }
  function planName(plan) { return plan === 'weekly' ? 'Weekly' : 'Monthly'; }

  function statusInfo(status) {
    switch (status) {
      case 'active': return { label: 'ACTIVE', cls: 'rc-status-available' };
      case 'pending': return { label: 'PENDING', cls: 'rc-status-limited' };
      case 'ended': return { label: 'ENDED', cls: 'rc-status-closed' };
      case 'cancelled': return { label: 'CANCELLED', cls: 'rc-status-closed' };
      default: return { label: String(status || '').toUpperCase(), cls: 'rc-status-closed' };
    }
  }

  function paymentInfo(paymentStatus) {
    return paymentStatus === 'paid'
      ? { label: 'PAID', cls: 'rc-status-available' }
      : { label: 'PAYMENT PENDING', cls: 'rc-status-full' };
  }

  var ICON_PATHS = {
    trophy: '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'
  };
  function icon(name, cls) {
    var paths = ICON_PATHS[name] || '';
    return '<svg class="rc-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Walks swapped_from_rental_id backward, oldest first -- same convention
  // as admin/dashboard.js's swapChain(), so a swap chain reads the same way
  // in the portal as it does in the admin dashboard.
  function swapChain(rental, allRentals) {
    var chain = [rental];
    var cur = rental;
    while (cur.swapped_from_rental_id != null) {
      var prev = allRentals.filter(function (r) { return r.id === cur.swapped_from_rental_id; })[0];
      if (!prev) break;
      chain.unshift(prev);
      cur = prev;
    }
    return chain;
  }

  // Nav link ("Sign in" <-> "My Account"). Any element in the page tagged
  // data-rc-account-link gets its text/href updated once we know whether a
  // customer session exists. Fails silently (leaves the signed-out default
  // in place) if Supabase isn't reachable/configured -- a broken nav link
  // check should never break the rest of the page.
  function setLinkText(a, label) {
    // Desktop nav links are Webflow's hover-reveal pattern: two nested
    // ".text-sm" divs positioned/clipped by CSS, with the <a> itself never
    // meant to hold a bare text node. Overwriting a.textContent would wipe
    // that structure and silently render nothing visible. Update the inner
    // text nodes when present (desktop nav); fall back to plain textContent
    // for simple links that have none (the mobile drawer's <a>).
    var textEls = a.querySelectorAll('.text-sm');
    if (textEls.length) {
      Array.prototype.forEach.call(textEls, function (el) { el.textContent = label; });
    } else {
      a.textContent = label;
    }
  }

  // "Track rental" nav entry. A customer who rented without signing up has
  // a tracking code and nowhere to type it from the homepage -- "Sign in"
  // is the only account entry in the nav, and it doesn't apply to them.
  // Injected here rather than into 173 exported HTML files, all of which
  // already load this script. Idempotent, and skipped entirely for a
  // signed-in customer, whose account link already covers it.
  function injectTrackLink(session) {
    if (session) return;
    if (document.querySelector('[data-rc-track-link]')) return;

    var code = loadGuestCode();
    var label = code ? 'My Rentals' : 'Track Rental';
    var href = '/account/track.html';

    // Mobile drawer: plain <a>, simple text node.
    var drawer = document.querySelector('.rc-drawer-nav');
    if (drawer) {
      var d = document.createElement('a');
      d.setAttribute('href', href);
      d.setAttribute('data-rc-track-link', '');
      d.className = 'rc-drawer-link';
      d.textContent = label;
      drawer.appendChild(d);
    }

    // Desktop nav: Webflow's hover-reveal pattern needs the two nested
    // .text-sm divs, so clone an existing sibling link and retarget it
    // rather than hand-building markup that would drift from the export.
    var list = document.querySelector('.navbar_list');
    if (list) {
      var sibling = list.querySelector('a.link');
      if (sibling) {
        var a = sibling.cloneNode(true);
        a.removeAttribute('data-rc-account-link');
        a.removeAttribute('id');
        a.setAttribute('href', href);
        a.setAttribute('data-rc-track-link', '');
        a.classList.remove('is-current-page');
        setLinkText(a, label);
        var accountLink = list.querySelector('[data-rc-account-link]');
        if (accountLink) list.insertBefore(a, accountLink);
        else list.appendChild(a);
      }
    }
  }

  function wireNavLink() {
    var links = document.querySelectorAll('[data-rc-account-link]');
    var controls = document.querySelectorAll('[data-rc-account-control]');
    getSession().then(function (session) {
      try { injectTrackLink(session); } catch (e) { /* nav is cosmetic */ }
      if (!links.length && !controls.length) return;
      Array.prototype.forEach.call(links, function (a) {
        if (session) {
          setLinkText(a, 'My Account');
          a.setAttribute('href', '/account/');
        } else {
          setLinkText(a, 'Sign in');
          a.setAttribute('href', '/account/login.html');
        }
      });

      // Desktop nav profile control: a "Sign in" pill when signed out, an
      // avatar (first letter of the customer's email) linking to /account/
      // when signed in. Structure is ours (not Webflow markup), so no
      // textContent trap here -- just toggle the .is-signed-in class and
      // fill the avatar initial.
      Array.prototype.forEach.call(controls, function (a) {
        var avatar = a.querySelector('.rc-account-avatar');
        if (session) {
          a.classList.add('is-signed-in');
          a.setAttribute('href', '/account/');
          a.setAttribute('aria-label', 'My Account');
          if (avatar) {
            var email = (session.user && session.user.email) || '';
            avatar.textContent = email ? email.charAt(0).toUpperCase() : 'A';
          }
        } else {
          a.classList.remove('is-signed-in');
          a.setAttribute('href', '/account/login.html');
          a.setAttribute('aria-label', 'Sign in');
        }
      });
    });
  }

  window.RCAccount = {
    getClient: getClient,
    getSession: getSession,
    requireAuth: requireAuth,
    ensureRenter: ensureRenter,
    signOut: signOut,
    saveGuestCode: saveGuestCode,
    loadGuestCode: loadGuestCode,
    clearGuestCode: clearGuestCode,
    normalizeTrackingCode: normalizeTrackingCode,
    peso: peso,
    fmtDate: fmtDate,
    daysLeft: daysLeft,
    daysLeftLabel: daysLeftLabel,
    slotName: slotName,
    planName: planName,
    statusInfo: statusInfo,
    paymentInfo: paymentInfo,
    icon: icon,
    esc: esc,
    swapChain: swapChain
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireNavLink);
  } else {
    wireNavLink();
  }
})();
