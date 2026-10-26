/* TML Cost Calculator — Supabase runtime shim (injected by tools/sb-build.mjs in place of the static shim).
   The calculator talks to window.claude ('db' and 'user'). Here that API is backed by Supabase:
   documents in public.documents, the activity log in public.activity_log, shipment history in public.hist,
   identity from Supabase Auth + public.profiles, and live updates through Realtime. Nothing is kept in
   localStorage any more except the auth session that supabase-js manages itself. */
(function () {
  'use strict';

  var VERSION = '__VERSION__';
  var BUILT_AT = '__BUILT_AT__';
  var CFG = window.__TML_SB || { url: '__SUPABASE_URL__', anon: '__SUPABASE_ANON_KEY__' };
  var ROLE_LABEL = { admin: 'Admin', costing: 'Costing', purchasing: 'Purchasing', vicegm: 'Vice GM', exim: 'Export Import', viewer: 'Viewer' };
  // mirrors public.can_write() in the database; the server decides, this only shapes the UI
  var WRITE = { admin: ['master', 'months', 'quotes', 'docs', 'deals'], costing: ['master', 'months', 'quotes', 'docs', 'deals'],
    purchasing: ['months', 'quotes', 'docs'], vicegm: ['quotes', 'docs'], exim: ['quotes', 'docs'], viewer: [] };
  var LOG_MAX = 2000;
  var PAGE = 1000;   // PostgREST returns at most 1000 rows per request

  function toShell(msg) {
    try { if (msg) sessionStorage.setItem('tmlcalc.sb.msg', msg); } catch (e) {}
    try { sessionStorage.removeItem('tmlcalc.log.sess'); } catch (e) {}
    location.replace(location.pathname + location.search);
  }
  function fail(msg) {
    var d = document.createElement('div');
    d.setAttribute('style', 'position:fixed;inset:0 0 auto 0;z-index:9999;background:#b02a20;color:#fff;padding:10px 16px;font:14px/1.4 Barlow,sans-serif');
    d.textContent = msg + ' ';
    var a = document.createElement('a'); a.href = location.pathname; a.textContent = 'Sign in again'; a.style.color = '#fff'; d.appendChild(a);
    (document.body || document.documentElement).appendChild(d);
  }
  if (!window.supabase || !window.supabase.createClient) { fail('The database client did not load. Check the connection and reload.'); return; }
  var sb = window.supabase.createClient(CFG.url, CFG.anon);

  var UID = null, NAME = '', ROLE = '', EMAIL = '', ROLE_CODE = '';
  var USERS = {};              // id and email -> { name, role }
  var docs = new Map();        // path -> data
  var log = [];                // activity entries, oldest first
  var logListeners = [];
  var listeners = [];

  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function colOf(path) { return path.slice(0, path.lastIndexOf('/')); }
  function idOf(path) { return path.slice(path.lastIndexOf('/') + 1); }
  function sameJson(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } }

  // ---- activity log: the same diff text as the static build, stored in public.activity_log ----
  var SKIP_KEYS = { updatedAt: 1, updatedBy: 1, createdAt: 1, createdBy: 1, id: 1 };
  function fmtVal(v) {
    if (v === undefined) return '(none)';
    if (v === null || v === '') return '(empty)';
    if (typeof v === 'object') { var s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + '…' : s; }
    var t = String(v); return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }
  function segLabel(arr, i) {
    var it = arr[i];
    if (it && typeof it === 'object') { var n = it.name || it.label || it.id || it.code; if (n != null && n !== '') return '[' + String(n) + ']'; }
    return '[' + (i + 1) + ']';
  }
  function leafDiff(a, b, prefix, out) {
    if (out.length > 400) return;
    var ao = a && typeof a === 'object', bo = b && typeof b === 'object';
    if (!ao && !bo) {
      if (a !== b && !(a == null && b == null) && !(a === '' && b == null) && !(a == null && b === '')) out.push({ p: (prefix || '').replace(/\.$/, '') || '(value)', from: a, to: b });
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      var aa = Array.isArray(a) ? a : [], bb = Array.isArray(b) ? b : [];
      var n = Math.max(aa.length, bb.length);
      for (var i = 0; i < n; i++) {
        var lab = i < bb.length ? segLabel(bb, i) : segLabel(aa, i);
        if (i >= aa.length) out.push({ p: prefix + lab, from: undefined, to: bb[i], added: true });
        else if (i >= bb.length) out.push({ p: prefix + lab, from: aa[i], to: undefined, removed: true });
        else leafDiff(aa[i], bb[i], prefix + lab + '.', out);
      }
      return;
    }
    var keys = {};
    Object.keys(ao ? a : {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(bo ? b : {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (!prefix && SKIP_KEYS[k]) return;
      leafDiff(ao ? a[k] : undefined, bo ? b[k] : undefined, (prefix || '') + k + '.', out);
    });
  }
  function diffLines(prev, next) {
    var out = [];
    try { leafDiff(prev, next, '', out); } catch (e) { out = [{ p: '(diff failed)', from: '', to: '' }]; }
    var lines = out.map(function (d) {
      var p = d.p.replace(/\.$/, '');
      if (d.added) return 'added ' + p + (d.to && typeof d.to === 'object' ? '' : ': ' + fmtVal(d.to));
      if (d.removed) return 'removed ' + p;
      return p + ': ' + fmtVal(d.from) + ' → ' + fmtVal(d.to);
    });
    return { n: lines.length, lines: lines.slice(0, 60) };
  }
  var MONTHS_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function whereOf(path) {
    var c = colOf(path), id = idOf(path);
    if (c === 'master') {
      var m = { settings: 'Costing rules', paints: 'Paint list', systems: 'Paint systems', sets: 'Matching paint sets', dealsync: 'Deal sync', docs: 'Document settings' };
      return { area: 'Master data', what: m[id] || id };
    }
    if (c === 'months') { var mm = /^(\d{4})-(\d{2})$/.exec(id); return { area: 'Monthly inputs', what: mm ? MONTHS_L[+mm[2] - 1] + ' ' + mm[1] : id }; }
    if (c === 'quotes') return { area: 'Saved quotes', what: 'Quote ' + id };
    if (c === 'docs') return { area: 'Order documents', what: 'Draft ' + id };
    if (c === 'deals') return { area: 'Deal history', what: id };
    return { area: c || path, what: id };
  }
  function quoteLine(d) {
    if (!d) return '';
    var s = d.summary || {}, bits = [];
    if (s.cust) bits.push(s.cust);
    if (s.item) bits.push(s.item);
    if (s.price != null && s.price !== '') bits.push(s.unit === 'Rp/kg' ? 'Rp ' + Math.round(s.price).toLocaleString('en-US') + '/kg' : 'USD ' + Math.round(s.price).toLocaleString('en-US') + '/MT');
    if (s.qty) bits.push(s.qty + ' MT');
    if (d.monthId) bits.push('month ' + d.monthId);
    return bits.join(' · ');
  }
  function draftLine(d) {
    if (!d) return '';
    var b = d.sc && d.sc.buyer && d.sc.buyer.name ? d.sc.buyer.name : '';
    return [b, d.sox || d.no || ''].filter(Boolean).join(' · ');
  }
  function buildEvent(op, path, prev, next) {
    var w = whereOf(path);
    var e = { at: new Date().toISOString(), uid: UID, name: NAME, role: ROLE, op: op, path: path, area: w.area, what: w.what, action: '', detail: '', n: 0, lines: [] };
    if (w.area === 'Saved quotes') {
      if (op === 'add') { e.action = 'Saved quote'; e.detail = quoteLine(next); }
      else if (op === 'delete') { e.action = 'Deleted quote'; e.detail = quoteLine(prev); }
      else {
        var wasWon = !!(prev && prev.won && prev.won.price > 0), isWon = !!(next && next.won && next.won.price > 0);
        if (wasWon !== isWon) { e.action = isWon ? 'Marked won' : 'Marked not won'; e.detail = quoteLine(next); }
        else { e.action = 'Changed quote'; e.detail = quoteLine(next); var dq = diffLines(prev, next); e.n = dq.n; e.lines = dq.lines; }
      }
    } else if (w.area === 'Order documents') {
      if (op === 'delete') { e.action = 'Deleted draft'; e.detail = draftLine(prev); }
      else if (!prev) { e.action = 'Created draft'; e.detail = draftLine(next); }
      else { e.action = 'Changed draft'; e.detail = draftLine(next); var dd = diffLines(prev, next); e.n = dd.n; e.lines = dd.lines; }
    } else if (op === 'delete') { e.action = 'Deleted'; }
    else {
      var d = diffLines(prev, next);
      e.n = d.n; e.lines = d.lines;
      if (!prev) e.action = 'Created';
      else if (w.area === 'Monthly inputs' && prev.status !== (next && next.status)) e.action = (next && next.status === 'verified') ? 'Marked verified' : 'Changed';
      else e.action = 'Changed';
      if (w.area === 'Monthly inputs' && next && next.status === 'verified' && prev && prev.status !== 'verified' && d.n > 0) e.action = 'Changed, marked verified';
      e.detail = d.n ? d.n + (d.n === 1 ? ' value changed' : ' values changed') : (op === 'set' && prev ? 'Saved with no value changes' : '');
    }
    return e;
  }
  function pushLog(e) {
    log.push(e);
    if (log.length > LOG_MAX) log = log.slice(log.length - LOG_MAX);
    logListeners.forEach(function (cb) { try { cb(); } catch (x) {} });
  }
  function logRow(e) {
    return { at: e.at, uid: e.uid, name: e.name, role: e.role, op: e.op, path: e.path, area: e.area, what: e.what, action: e.action, detail: e.detail, n: e.n, lines: e.lines };
  }
  function recordEvent(e) {
    pushLog(e);
    return sb.from('activity_log').insert(logRow(e)).then(function (r) { if (r.error && window.console) console.warn('activity log not saved', r.error.message); });
  }

  // ---- store ------------------------------------------------------------
  function docSnap(path) {
    var has = docs.has(path), d = has ? docs.get(path) : undefined;
    return { id: idOf(path), exists: has, data: function () { return clone(d); } };
  }
  function colSnap(l) {
    var rows = [];
    docs.forEach(function (v, p) { if (colOf(p) === l.key) rows.push({ id: idOf(p), d: v }); });
    if (l.orderBy) {
      rows.sort(function (a, b) {
        var x = a.d ? a.d[l.orderBy] : undefined, y = b.d ? b.d[l.orderBy] : undefined;
        if (x === y) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return x < y ? -1 : 1;
      });
      if (l.dir === 'desc') rows.reverse();
    } else rows.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    if (l.limit) rows = rows.slice(0, l.limit);
    return { docs: rows.map(function (r) { return { id: r.id, data: function () { return clone(r.d); } }; }) };
  }
  function fire(l) {
    try { l.cb(l.kind === 'doc' ? docSnap(l.key) : colSnap(l)); }
    catch (e) { if (window.console) console.error('listener error', e); }
  }
  function notify(path) {
    var c = colOf(path);
    listeners.forEach(function (l) { if ((l.kind === 'doc' && l.key === path) || (l.kind === 'col' && l.key === c)) fire(l); });
  }
  function denied(path, err) {
    var msg = /row-level security|permission|policy/i.test(err && err.message || '') ? 'Your role (' + ROLE + ') may not change ' + whereOf(path).area.toLowerCase() + '.' : 'Not saved: ' + (err && err.message || 'database error');
    if (window.console) console.error('write failed', path, err);
    try { window.alert(msg); } catch (e) {}
  }
  function write(path, data, op) {
    var d = clone(data);
    var prev = docs.has(path) ? clone(docs.get(path)) : null;
    docs.set(path, d); notify(path);
    var e = buildEvent(op || 'set', path, prev, d);
    return sb.from('documents').upsert({ path: path, data: d, updated_at: e.at, updated_by: UID }).then(function (r) {
      if (r.error) { if (prev) docs.set(path, prev); else docs.delete(path); notify(path); denied(path, r.error); throw r.error; }
      return recordEvent(e);
    });
  }
  function erase(path) {
    var prev = docs.has(path) ? clone(docs.get(path)) : null;
    docs.delete(path); notify(path);
    var e = buildEvent('delete', path, prev, null);
    return sb.from('documents').delete().eq('path', path).then(function (r) {
      if (r.error) { if (prev) { docs.set(path, prev); notify(path); } denied(path, r.error); throw r.error; }
      return recordEvent(e);
    });
  }

  // ---- db API (the subset the calculator uses) --------------------------
  function docRef(path) {
    return {
      onSnapshot: function (cb) {
        var l = { kind: 'doc', key: path, cb: cb }; listeners.push(l);
        setTimeout(function () { fire(l); }, 0);
        return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      },
      get: function () { return Promise.resolve(docSnap(path)); },
      set: function (data) { return write(path, data, 'set'); },
      update: function (patch) {
        var cur = docs.has(path) ? clone(docs.get(path)) : {};
        Object.keys(patch || {}).forEach(function (k) { cur[k] = clone(patch[k]); });
        return write(path, cur, 'update');
      },
      delete: function () { return erase(path); }
    };
  }
  function colRef(key, orderBy, dir, limit) {
    return {
      orderBy: function (f, d) { return colRef(key, f, d || 'asc', limit); },
      limit: function (n) { return colRef(key, orderBy, dir, n); },
      onSnapshot: function (cb) {
        var l = { kind: 'col', key: key, orderBy: orderBy, dir: dir, limit: limit, cb: cb }; listeners.push(l);
        setTimeout(function () { fire(l); }, 0);
        return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      },
      add: function (data) {
        var id = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        return write(key + '/' + id, data, 'add').then(function () { return { id: id }; });
      }
    };
  }
  var dbApi = { doc: function (p) { return docRef(p); }, collection: function (c) { return colRef(c, null, null, null); } };
  var userApi = {
    id: function () { return Promise.resolve(UID); },
    me: function () { return Promise.resolve({ id: UID, name: NAME, email: EMAIL, role: ROLE }); },
    canEdit: function () { return Promise.resolve(ROLE_CODE === 'admin' || ROLE_CODE === 'costing'); },   // master data
    can: function (what) { return Promise.resolve(what === 'data.write' ? (WRITE[ROLE_CODE] || []).length > 0 : ROLE_CODE === 'admin'); },
    canWrite: function (col) { return (WRITE[ROLE_CODE] || []).indexOf(col) >= 0; },
    profiles: function (ids) {
      var out = {};
      (ids || []).forEach(function (i) { out[i] = { name: USERS[i] ? USERS[i].name : (i === UID ? NAME : 'Someone') }; });
      return Promise.resolve(out);
    }
  };

  // ---- shipment history: hist/<key>.json requests are answered from public.hist ----
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var m = /(?:^|\/)hist\/([^\/?#]+)\.json(?:[?#].*)?$/.exec(url);
      if (!m) return origFetch(input, init);
      var key = decodeURIComponent(m[1]);
      return sb.from('hist').select('data').eq('key', key).maybeSingle().then(function (r) {
        if (r.error || !r.data) return new Response('not found', { status: 404, statusText: 'Not Found' });
        return new Response(JSON.stringify(r.data.data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    };
  }

  // ---- load everything once, then follow changes live --------------------
  async function pageAll(build) {
    var out = [], from = 0;
    for (;;) {
      var r = await build().range(from, from + PAGE - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < PAGE) return out;
      from += PAGE;
    }
  }
  function applyRemote(row) {
    if (!row || !row.path) return;
    if (docs.has(row.path) && sameJson(docs.get(row.path), row.data)) return;   // our own write echoed back
    docs.set(row.path, row.data); notify(row.path);
  }
  function applyRemoteDelete(row) {
    if (!row || !row.path || !docs.has(row.path)) return;
    docs.delete(row.path); notify(row.path);
  }
  function applyRemoteLog(row) {
    if (!row) return;
    if (log.some(function (e) { return e.at === row.at && e.uid === row.uid && e.path === row.path && e.op === row.op; })) return;
    pushLog(row);
  }
  var ready = (async function () {
    var s = (await sb.auth.getSession()).data.session;
    if (!s) { toShell(''); throw new Error('no session'); }
    UID = s.user.id; EMAIL = (s.user.email || '').toLowerCase();
    var pr = await sb.from('profiles').select('id,email,name,role,active').eq('id', UID).maybeSingle();
    if (pr.error) { fail('Could not read your profile: ' + pr.error.message); throw pr.error; }
    if (!pr.data || !pr.data.active) { await sb.auth.signOut(); toShell('This account is not active yet. Ask the administrator to enable it.'); throw new Error('inactive'); }
    ROLE_CODE = pr.data.role; ROLE = ROLE_LABEL[ROLE_CODE] || ROLE_CODE; NAME = pr.data.name || pr.data.email;
    var all = await sb.from('profiles').select('id,email,name,role').eq('active', true);
    (all.data || []).forEach(function (p) { var u = { name: p.name || p.email, role: ROLE_LABEL[p.role] || p.role }; USERS[p.id] = u; USERS[p.email] = u; });
    var rows = await pageAll(function () { return sb.from('documents').select('path,data').order('path'); });
    rows.forEach(function (r) { docs.set(r.path, r.data); });
    var lrows = await pageAll(function () { return sb.from('activity_log').select('*').order('at', { ascending: false }); });
    log = lrows.slice(0, LOG_MAX).reverse();
    sb.channel('tml-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'documents' }, function (p) { applyRemote(p.new); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'documents' }, function (p) { applyRemote(p.new); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'documents' }, function (p) { applyRemoteDelete(p.old); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, function (p) { applyRemoteLog(p.new); })
      .subscribe();
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') toShell(''); });
    // one sign-in entry per tab session
    var sid = null; try { sid = sessionStorage.getItem('tmlcalc.log.sess'); } catch (e) {}
    if (!sid) {
      try { sessionStorage.setItem('tmlcalc.log.sess', '1'); } catch (e) {}
      recordEvent({ at: new Date().toISOString(), uid: UID, name: NAME, role: ROLE, op: 'signin', path: '', area: 'Sign-in', what: '', action: 'Signed in', detail: '', n: 0, lines: [] });
    }
    return true;
  })();
  ready.catch(function (e) { if (window.console) console.error('database not ready', e); });

  window.TMLLog = {
    entries: function () { return clone(log); },
    onChange: function (cb) { logListeners.push(cb); return function () { var i = logListeners.indexOf(cb); if (i >= 0) logListeners.splice(i, 1); }; },
    get user() { return { id: UID, name: NAME, role: ROLE, email: EMAIL }; },
    get users() { return USERS; },
    signOut: function () { sb.auth.signOut().then(function () { toShell(''); }, function () { toShell(''); }); }
  };
  window.claude = {
    use: function (cap) {
      if (cap === 'db') return ready.then(function () { return dbApi; });
      if (cap === 'user') return ready.then(function () { return userApi; });
      var e = new Error('capability "' + cap + '" is not available in this build'); e.code = 'not_granted';
      return Promise.reject(e);
    }
  };
  window.__TML_STATIC_BUILD__ = { version: VERSION, builtAt: BUILT_AT, backend: 'supabase' };
  (function () {
    var el = document.getElementById('g-ver'); if (!el) return;
    var d = new Date(BUILT_AT);
    var stamp = isNaN(d) ? BUILT_AT : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    el.textContent = VERSION.toUpperCase() + ' · BUILD ' + stamp.toUpperCase();
    el.title = 'Built ' + BUILT_AT + '. Data: Supabase (shared, live).';
  })();
})();
