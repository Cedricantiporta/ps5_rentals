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
    'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'
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

  function wireNavLink() {
    var links = document.querySelectorAll('[data-rc-account-link]');
    var controls = document.querySelectorAll('[data-rc-account-control]');
    if (!links.length && !controls.length) return;
    getSession().then(function (session) {
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
    signOut: signOut,
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
