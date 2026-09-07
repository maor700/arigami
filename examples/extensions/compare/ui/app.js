// compare — the vs-baseline slider, as an Arigami extension tab.
//
// Two panes, both embedded through the HOST PROXY (`/?__target=<href>`): each
// iframe becomes its own service-worker client pinned to its own target, which
// makes it same-origin with the cockpit — iframable, logged in, and with its
// DOM reachable, which is what the click/scroll mirroring needs.
//
// That is also why this extension is `"trusted": true` in its manifest: a
// sandboxed extension page has an opaque origin, and an opaque origin can
// neither register/see the proxy's service worker nor carry the session cookie,
// so both panes would come back 401. Trusted means the tab is served without
// the CSP sandbox, exactly like the cockpit's own pages.
//
// Where the two URLs come from, in order:
//   ?a=<url>&b=<url>          both explicit (open_tab params, or a link)
//   ?a=<url> + settings       b = settings.baselineUrl, with a's path+query
//                             applied to it when settings.autoPath is on
//   nothing                   the setup form asks for them
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var setup = $('setup'), view = $('view');
  var fA = $('fA'), fB = $('fB'), awrap = $('awrap'), dv = $('dv');
  var settings = {};
  var A = null, B = null;

  var proxied = function (u) { return '/?__target=' + encodeURIComponent(u); };
  var label = function (u) { return u.replace(/^https?:\/\//, ''); };
  var parse = function (s) { try { return new URL(String(s || '')); } catch (e) { return null; } };

  /** b, given a: an explicit value wins; else the baseline, optionally at a's path. */
  function baselineFor(aUrl, explicitB) {
    if (explicitB) return explicitB;
    var base = String(settings.baselineUrl || '').trim();
    if (!base) return '';
    var a = parse(aUrl);
    if (!a || settings.autoPath === false) return base;
    var joined = null;
    try { joined = new URL(a.pathname + a.search, base).href; } catch (e) { joined = null; }
    return joined || base;
  }

  // ---- setup form ---------------------------------------------------------
  function showSetup(a, b, msg) {
    $('ua').value = a || '';
    $('ub').value = b || '';
    $('hint').textContent = msg || '';
    view.hidden = true;
    setup.hidden = false;
    $('ua').focus();
  }

  setup.addEventListener('submit', function (e) {
    e.preventDefault();
    var a = $('ua').value.trim();
    var b = baselineFor(a, $('ub').value.trim());
    if (!parse(a)) { $('hint').textContent = 'The left URL is not a full URL (include the scheme).'; return; }
    if (!parse(b)) { $('hint').textContent = 'The baseline is not a full URL — type one, or set a default in Settings › Extensions.'; return; }
    start(a, b);
  });

  // ---- the slider ---------------------------------------------------------
  var setX = function (x) {
    x = Math.max(0, Math.min(100, x));
    awrap.style.clipPath = 'inset(0 0 0 ' + x + '%)';
    dv.style.left = x + '%';
  };
  var down = false;
  // pointer capture on the divider keeps move events flowing over the iframes
  dv.addEventListener('pointerdown', function (e) { down = true; dv.setPointerCapture(e.pointerId); e.preventDefault(); });
  dv.addEventListener('pointermove', function (e) { if (down) setX((e.clientX / document.body.clientWidth) * 100); });
  dv.addEventListener('pointerup', function (e) { down = false; try { dv.releasePointerCapture(e.pointerId); } catch (_) {} });

  var sync = true;
  var syncBtn = $('syncbtn');
  var renderSyncBtn = function () {
    syncBtn.textContent = sync ? '🔗 sync: on' : '🔗 sync: off';
    syncBtn.style.background = sync ? '#1f6feb' : '#30363d';
  };
  syncBtn.addEventListener('click', function () { sync = !sync; renderSyncBtn(); });

  // ---- interaction mirroring ----------------------------------------------
  // Both panes are same-origin (they are proxied through the host), so the DOM
  // of each is reachable. Locate the "same" element in the other pane by stable
  // hooks and replay the event there, so that pane's own router and handlers run
  // natively. Best-effort across structurally different versions; one global
  // guard prevents an A→B→A loop.
  var replaying = false;
  var cssEsc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); };
  var cssPath = function (el) {
    var parts = [];
    while (el && el.nodeType === 1 && el.tagName !== 'BODY' && parts.length < 8) {
      var p = el.tagName.toLowerCase(), par = el.parentNode;
      if (par) {
        var sib = [].filter.call(par.children, function (c) { return c.tagName === el.tagName; });
        if (sib.length > 1) p += ':nth-of-type(' + ([].indexOf.call(sib, el) + 1) + ')';
      }
      parts.unshift(p);
      el = el.parentNode;
    }
    return parts.join('>');
  };
  var locator = function (el) {
    var act = (el.closest && el.closest('a[href],button,[role="button"],[role="tab"],[role="menuitem"],[data-testid],input,select,textarea,label')) || el;
    var sel = null, g = function (n) { return act.getAttribute && act.getAttribute(n); };
    if (g('data-testid')) sel = '[data-testid="' + cssEsc(g('data-testid')) + '"]';
    else if (act.id && !/[0-9]{4,}|:r[0-9a-z]/i.test(act.id)) sel = '#' + cssEsc(act.id);
    else if (act.tagName === 'A' && g('href')) sel = 'a[href="' + cssEsc(g('href')) + '"]';
    else if (g('aria-label')) sel = act.tagName.toLowerCase() + '[aria-label="' + cssEsc(g('aria-label')) + '"]';
    else if ((act.tagName === 'INPUT' || act.tagName === 'SELECT' || act.tagName === 'TEXTAREA') && act.name)
      sel = act.tagName.toLowerCase() + '[name="' + cssEsc(act.name) + '"]';
    return { sel: sel, path: cssPath(act), text: (act.textContent || '').trim().slice(0, 40) };
  };
  var resolve = function (doc, loc) {
    var list = [];
    if (loc.sel) { try { list = [].slice.call(doc.querySelectorAll(loc.sel)); } catch (e) {} }
    if (!list.length && loc.path) { try { list = [].slice.call(doc.querySelectorAll(loc.path)); } catch (e) {} }
    if (list.length > 1 && loc.text) {
      var t = list.filter(function (n) { return (n.textContent || '').trim().slice(0, 40) === loc.text; });
      if (t.length) return t[0];
    }
    return list[0] || null;
  };
  var fire = function (dest, type, srcTarget) {
    replaying = true;
    try {
      if (type === 'input' || type === 'change') {
        if (dest.type === 'checkbox' || dest.type === 'radio') dest.checked = srcTarget.checked;
        else if ('value' in dest) dest.value = srcTarget.value;
        dest.dispatchEvent(new Event(type, { bubbles: true }));
      } else {
        dest.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: dest.ownerDocument.defaultView }));
      }
    } catch (e) {}
    setTimeout(function () { replaying = false; }, 0);
  };
  var attach = function (fromF, toF) {
    var d;
    try { d = fromF.contentDocument; } catch (e) { return; }
    if (!d) return;
    ['click', 'input', 'change'].forEach(function (type) {
      d.addEventListener(type, function (ev) {
        if (replaying || !sync) return;
        var dest;
        try { dest = resolve(toF.contentDocument, locator(ev.target)); } catch (e) { return; }
        if (dest) fire(dest, type, ev.target);
      }, true);
    });
    try {
      fromF.contentWindow.addEventListener('scroll', function () {
        if (replaying || !sync) return;
        replaying = true;
        try { toF.contentWindow.scrollTo(fromF.contentWindow.scrollX, fromF.contentWindow.scrollY); } catch (e) {}
        setTimeout(function () { replaying = false; }, 0);
      }, true);
    } catch (e) {}
  };
  var wire = function () { attach(fB, fA); attach(fA, fB); };
  fB.addEventListener('load', wire);
  fA.addEventListener('load', wire);

  // ---- baseline auth-loop guard -------------------------------------------
  // A proxied baseline sees its origin as the host proxy, so its SSO builds a
  // redirect_uri the baseline rejects (invalid_redirect_uri) and bounces around
  // /login forever. Detect that — or any runaway reload loop — and replace the
  // pane with a notice instead of an endless flicker.
  var notice = $('bnotice'), loads = 0, t0 = Date.now();
  var showNotice = function () { notice.style.display = 'flex'; try { fB.src = 'about:blank'; } catch (e) {} };
  fB.addEventListener('load', function () {
    loads++;
    if (Date.now() - t0 > 15000) { loads = 1; t0 = Date.now(); } // rolling window
    var href = '';
    try { href = fB.contentWindow.location.href; } catch (e) {}
    // invalid_redirect_uri is a definitive rejection; loads>=6 catches generic
    // loops without false-firing on the normal bootstrap→SW reload dance.
    if (/error=invalid_redirect_uri/.test(href) || loads >= 6) showNotice();
  });
  $('bopen').addEventListener('click', function () { if (B) window.open(B, '_blank', 'noopener'); });
  $('bretry').addEventListener('click', function () {
    notice.style.display = 'none';
    loads = 0;
    t0 = Date.now();
    try { fB.src = proxied(B); } catch (e) {}
  });

  // ---- the bar ------------------------------------------------------------
  $('editbtn').addEventListener('click', function () { showSetup(A, B, ''); });
  $('askbtn').addEventListener('click', function () {
    if (!window.arigami || !A || !B) return;
    arigami
      .sendPrompt('I am comparing ' + A + ' (under review) against ' + B + ' (baseline) in the Compare tab. ')
      .then(function () { return arigami.setStatus({ badge: '↩' }); })
      .catch(function () {});
  });

  // ---- start --------------------------------------------------------------
  function start(a, b) {
    A = a;
    B = b;
    setup.hidden = true;
    view.hidden = false;
    notice.style.display = 'none';
    loads = 0;
    t0 = Date.now();
    setX(50);
    renderSyncBtn();
    $('lblA').textContent = label(a) + ' ▶';
    $('lblB').textContent = '◀ ' + label(b);
    fB.src = proxied(b);
    fA.src = proxied(a);
    if (window.arigami) arigami.setStatus({ title: 'Compare · ' + label(a) }).catch(function () {});
  }

  var q = new URLSearchParams(location.search);
  var qa = (q.get('a') || '').trim();
  var qb = (q.get('b') || '').trim();

  function boot() {
    var b = baselineFor(qa, qb);
    if (parse(qa) && parse(b)) start(qa, b);
    else showSetup(qa, qb, qa && !b ? 'No baseline yet — type one, or set a default in Settings › Extensions.' : '');
  }

  // `ready()` hands over the tab context (settings included). Outside the
  // cockpit it rejects; the page still works with explicit ?a=&b=.
  if (window.arigami) {
    arigami.ready().then(
      function (ctx) { settings = (ctx && ctx.settings) || {}; boot(); },
      function () { boot(); }
    );
  } else {
    boot();
  }
})();
