(function () {
  'use strict';

  if (!window.RC_ADMIN_CONFIG || !window.RC_ADMIN_CONFIG.SUPABASE_URL) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML = '<div style="padding:3rem;font-family:sans-serif;color:#fff;background:#0a0a0f;min-height:100vh;">' +
        '<h1>Admin not configured yet</h1><p>Fill in SUPABASE_URL and SUPABASE_ANON_KEY in /admin/config.js.</p></div>';
    });
    return;
  }

  var supabase = window.supabase.createClient(
    window.RC_ADMIN_CONFIG.SUPABASE_URL,
    window.RC_ADMIN_CONFIG.SUPABASE_ANON_KEY
  );
  window.rcSupabase = supabase;

  window.rcRequireAuth = function () {
    return supabase.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (!session) {
        window.location.href = '/admin/login.html';
        return null;
      }
      return session;
    });
  };

  window.rcSignOut = function () {
    return supabase.auth.signOut().then(function () {
      window.location.href = '/admin/login.html';
    });
  };
})();
