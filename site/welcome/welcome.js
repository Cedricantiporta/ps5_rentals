// Onboarding page a customer lands on from the link the owner sends after
// confirming their GCash payment: /welcome/?code=JD-XXXXXX
//
// It does three things, in this order of importance:
//   1. Saves the tracking code to this device, so the customer never has to
//      type it again anywhere on the site.
//   2. Hands them the code with a copy button and tells them to keep it.
//   3. Explains how renting, swapping and the rules work, then sends them to
//      their rentals with the code already in.
//
// Everything after step 1 is best-effort: if the lookup RPC isn't deployed
// yet, or the code is unknown, the page still renders and still saves the
// code. Nothing here is allowed to leave the customer on a blank screen.
(function () {
  'use strict';

  var RCAccount = window.RCAccount;

  function $(id) { return document.getElementById(id); }

  function getCodeFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('code') || '';
    } catch (e) { return ''; }
  }

  // Same clipboard approach as the rent wizard: the async API needs a secure
  // context, so fall back to the hidden-textarea trick, and never let either
  // one throw into the page.
  function copyText(text, cb) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { cb(true); }, function () { cb(fallback()); });
        return;
      }
    } catch (e) {}
    cb(fallback());
  }

  function selectCode() {
    try {
      var range = document.createRange();
      range.selectNodeContents($('jdCode'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function renderRentals(rows) {
    if (!rows || !rows.length) return;
    var list = $('jdRentalList');
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status !== 'active' && r.status !== 'pending') continue;
      var cover = r.game_cover
        ? '<img class="jd-rental-cover" src="' + RCAccount.esc(r.game_cover) + '" alt="">'
        : '<div class="jd-rental-cover jd-rental-cover-blank"></div>';
      html += '<div class="jd-rental">' + cover +
        '<div class="jd-rental-meta">' +
          '<div class="jd-rental-title">' + RCAccount.esc(r.game_title) + '</div>' +
          '<div class="jd-rental-sub">' + RCAccount.esc(RCAccount.slotName(r.slot)) + ' &middot; ' +
            RCAccount.esc(RCAccount.planName(r.plan)) + '</div>' +
          '<div class="jd-rental-days">' + RCAccount.esc(RCAccount.daysLeftLabel(r.end_date)) + '</div>' +
        '</div></div>';
    }
    if (!html) return;
    list.innerHTML = html;
    $('jdRentalCard').hidden = false;
    renumberSteps();
  }

  // The rentals card only appears once the lookup succeeds, so the step
  // numbers can't be baked into the markup -- otherwise a customer whose
  // lookup fails sees 1, 3, 4, 5. Number the visible cards on every change.
  function renumberSteps() {
    var cards = document.querySelectorAll('.jd-card');
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].hidden) continue;
      n += 1;
      var badge = cards[i].querySelector('.jd-step-num');
      if (badge) badge.textContent = String(n);
    }
  }

  function personalise(rows) {
    if (!rows || !rows.length) return;
    var name = rows[0].renter_name;
    if (name) {
      $('jdHeroTitle').textContent = "You're all set, " + String(name).split(' ')[0] + '!';
    }
  }

  function init() {
    var raw = getCodeFromUrl();
    var code = RCAccount.normalizeTrackingCode(raw) || RCAccount.loadGuestCode();

    if (!code) {
      // Landed here with no code at all -- nothing to onboard, so send them
      // to the place where they can type one in.
      window.location.replace('/account/track.html');
      return;
    }

    // Save first, before any network call: this is the one thing that must
    // happen even if everything else on the page fails.
    RCAccount.saveGuestCode(code);

    renumberSteps();
    $('jdCode').textContent = code;
    $('jdGoBtn').setAttribute('href', '/account/track.html?code=' + encodeURIComponent(code));

    $('jdCopyBtn').addEventListener('click', function () {
      var btn = this;
      copyText(code, function (ok) {
        if (ok) {
          btn.textContent = 'Copied';
          btn.classList.add('is-copied');
        } else {
          // Clipboard access can be refused outright (older browsers, some
          // in-app webviews). Select the code so the customer can copy it
          // with their own long-press / Ctrl+C instead of being stuck.
          btn.textContent = 'Hold to copy';
          selectCode();
        }
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('is-copied');
        }, 2200);
      });
    });

    // Personalisation only. A failure here is invisible to the customer.
    var sb = RCAccount.getClient();
    if (!sb) return;
    sb.rpc('lookup_rentals_by_code', { p_code: code }).then(function (res) {
      if (!res || res.error || !res.data) return;
      personalise(res.data);
      renderRentals(res.data);
    }, function () {});
  }

  init();
})();
