/* Sign-in shell for the Supabase build (inlined into index.html by tools/sb-build.mjs).
   The page holds no calculator code and no data: after Supabase sign-in it downloads app.html from the
   private "app" bucket (readable only by active profiles) and writes it into the document. */
(function () {
  'use strict';
  var CFG = { url: '__SUPABASE_URL__', anon: '__SUPABASE_ANON_KEY__' };
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#gate-form'), email = $('#email'), password = $('#password'), btn = $('#signin'), status = $('#gate-status');
  var npWrap = $('#np-wrap'), newpw = $('#newpw'), forgot = $('#forgot');
  var mode = 'signin';
  function say(msg, bad) { status.textContent = msg || ''; status.className = bad ? 'bad' : ''; }
  if (!window.supabase || !window.supabase.createClient) { say('The sign-in library did not load. Check the connection and reload.', true); return; }
  var sb = window.supabase.createClient(CFG.url, CFG.anon);

  async function loadApp() {
    say('Loading the calculator…');
    btn.disabled = true;
    var r = await sb.storage.from('app').download('app.html');
    if (r.error) {
      var m = /not found|404/i.test(r.error.message || '') ? 'The calculator has not been published yet.' : /row-level|policy|403|unauthori/i.test(r.error.message || '') ? 'This account is not active yet. Ask the administrator to enable it.' : 'Could not load the calculator: ' + r.error.message;
      say(m, true); btn.disabled = false;
      if (/not active/.test(m)) await sb.auth.signOut();
      return false;
    }
    var html = await r.data.text();
    window.__TML_SB = CFG;
    document.open(); document.write(html); document.close();
    return true;
  }
  function setMode(m) {
    mode = m;
    var recovery = m === 'recovery';
    npWrap.hidden = !recovery; password.closest('label') && (password.closest('label').hidden = recovery);
    password.hidden = recovery; password.required = !recovery; newpw.required = recovery;
    email.disabled = recovery; btn.textContent = recovery ? 'Set new password' : 'Sign in';
  }
  var pending = null;
  try { pending = sessionStorage.getItem('tmlcalc.sb.msg'); sessionStorage.removeItem('tmlcalc.sb.msg'); } catch (e) {}
  if (pending) say(pending, true);

  sb.auth.onAuthStateChange(function (ev, session) {
    if (ev === 'PASSWORD_RECOVERY') { if (session && session.user) email.value = session.user.email || ''; setMode('recovery'); say('Choose a new password.'); }
  });
  sb.auth.getSession().then(function (r) {
    var s = r.data && r.data.session;
    if (s && !/type=recovery/.test(location.hash)) loadApp();
  });

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    btn.disabled = true;
    if (mode === 'recovery') {
      say('Saving the new password…');
      var u = await sb.auth.updateUser({ password: newpw.value });
      if (u.error) { say(u.error.message, true); btn.disabled = false; return; }
      history.replaceState(null, '', location.pathname);
      setMode('signin'); await loadApp(); return;
    }
    say('Signing in…');
    var r = await sb.auth.signInWithPassword({ email: email.value.trim().toLowerCase(), password: password.value });
    if (r.error) { say(/invalid/i.test(r.error.message) ? 'Email or password is not right.' : r.error.message, true); btn.disabled = false; return; }
    await loadApp();
  });
  forgot.addEventListener('click', async function (ev) {
    ev.preventDefault();
    var em = email.value.trim().toLowerCase();
    if (!em) { say('Type your email first, then click "Forgot password".', true); email.focus(); return; }
    var r = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
    say(r.error ? r.error.message : 'If that address has an account, a reset link is on its way. Open it on this device.', !!r.error);
  });
})();
