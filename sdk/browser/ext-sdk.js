// window.arigami — the browser SDK an extension tab loads with
// <script src="/__ext-sdk.js"></script>. Served by the host from this file
// (server/index.ts, cached 1h, ETag'd by mtime).
//
// The tab is served with `Content-Security-Policy: sandbox allow-scripts …`
// and WITHOUT allow-same-origin — it has an opaque origin, so it has no cookie,
// no localStorage and no way to call /__api itself. Everything goes through
// postMessage to the cockpit shell, which checks the extension's manifest
// permissions before it does anything (decision 2 in the architecture doc:
// option B, sandbox + bridge, from day one).
//
// ── PROTOCOL v1 (frozen; a change needs EXT_API_VERSION to go up) ───────────
// iframe → shell
//   { type:'arigami:hello', v:1 }                     announce; repeated until init
//   { type:'arigami:call',  v:1, id, method, args }   one request
//   { type:'arigami:close', v:1 }                     the tab asks to be closed
// shell → iframe
//   { type:'arigami:init',   v:1, context }           {sessionId, tabId, extension,
//                                                      apiVersion, agent, cwd,
//                                                      settings, lang, permissions}
//   { type:'arigami:result', v:1, id, ok:true,  value }
//   { type:'arigami:result', v:1, id, ok:false, error }
//   { type:'arigami:event',  v:1, name, payload }     only names the tab subscribed to
//
// methods (`arigami:call`):
//   sendPrompt   { text, mode?:'auto'|'now'|'queue', attachments? } → {delivered}
//     needs permission `session:message` (mode 'queue' → `session:prompts`)
//     'auto' (the default) = the host's deliverToSession: idle session → sent
//     now, busy session → queued WITH auto-play, so it plays when the turn ends.
//     'now' writes mid-turn; 'queue' only queues (waits for ▶). An omitted mode
//     used to mean 'queue'; a page that passes 'queue' explicitly is unchanged.
//   runTool      { name, args }                              → tool result
//     needs permission `tools:<name>`
//   setStatus    { badge?, color?, title? }                  → {ok:true}
//     needs permission `session:tabs`
//   openArtifact { path, title? }                            → {ok:true}
//     needs permission `session:tabs`
//   subscribe    { events:[…] }                              → {ok:true}
//     needs permission `events:<glob>` for each name
//   unsubscribe  { events:[…] }                              → {ok:true}
//
// The shell is the only authority: an unknown method, a missing permission or a
// message from the wrong source is answered with ok:false and never executed.
(function () {
  'use strict';
  var V = 1;
  if (typeof window === 'undefined') return;
  if (window.arigami && window.arigami.__v === V) return; // loaded twice — keep the first

  var parent = window.parent;
  var standalone = !parent || parent === window; // opened outside the cockpit

  var nextId = 1;
  var waiting = Object.create(null); // id → {resolve, reject}
  var subs = []; // {events:[…], cb}
  var ctx = null;
  var readyResolvers = [];
  var helloTimer = null;

  function post(msg) {
    if (standalone) return;
    try {
      // targetOrigin '*': this document has an OPAQUE origin (sandbox without
      // allow-same-origin) and cannot name the shell's origin. The shell
      // authenticates us the other way round — event.source === iframe.contentWindow.
      parent.postMessage(Object.assign({ v: V }, msg), '*');
    } catch (e) {
      /* shell gone */
    }
  }

  function call(method, args) {
    if (standalone)
      return Promise.reject(new Error('arigami: this page is not running inside an Arigami tab'));
    var id = 'c' + nextId++;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      post({ type: 'arigami:call', id: id, method: method, args: args || {} });
    });
  }

  function matches(pattern, name) {
    if (pattern === name || pattern === '*') return true;
    var i = pattern.indexOf('*');
    return i >= 0 && name.slice(0, i) === pattern.slice(0, i);
  }

  window.addEventListener('message', function (e) {
    if (standalone || e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type === 'arigami:init') {
      if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
      ctx = m.context || {};
      var rs = readyResolvers;
      readyResolvers = [];
      for (var i = 0; i < rs.length; i++) rs[i](ctx);
      return;
    }
    if (m.type === 'arigami:result') {
      var w = waiting[m.id];
      if (!w) return;
      delete waiting[m.id];
      if (m.ok) w.resolve(m.value);
      else w.reject(new Error(String(m.error || 'arigami: call failed')));
      return;
    }
    if (m.type === 'arigami:event') {
      for (var j = 0; j < subs.length; j++) {
        for (var k = 0; k < subs[j].events.length; k++) {
          if (matches(subs[j].events[k], m.name)) {
            try { subs[j].cb(m.payload, m.name); } catch (err) { /* an extension bug is not ours */ }
            break;
          }
        }
      }
    }
  });

  // The shell posts `arigami:init` on iframe load, but this script may evaluate
  // after that — so we also announce ourselves until we hear back (the shell
  // answers every hello with the current context; init is idempotent).
  if (!standalone) {
    post({ type: 'arigami:hello' });
    var tries = 0;
    helloTimer = setInterval(function () {
      if (ctx || ++tries > 40) { clearInterval(helloTimer); helloTimer = null; return; }
      post({ type: 'arigami:hello' });
    }, 250);
  }

  var sdk = {
    __v: V,
    apiVersion: V,

    /** Resolves with the tab context once the shell has handed it over. */
    ready: function () {
      if (ctx) return Promise.resolve(ctx);
      if (standalone)
        return Promise.reject(new Error('arigami: this page is not running inside an Arigami tab'));
      return new Promise(function (resolve) { readyResolvers.push(resolve); });
    },

    /**
     * Send text to the session.
     *   'auto' (default) — idle → sent now; busy → queued with auto-play on, so
     *                      it plays as soon as the current turn ends;
     *   'now'            — sent immediately, even mid-turn;
     *   'queue'          — queued only, and waits for the human's ▶.
     */
    sendPrompt: function (text, opts) {
      opts = opts || {};
      var mode = opts.mode === 'now' || opts.mode === 'queue' ? opts.mode : 'auto';
      return call('sendPrompt', {
        text: String(text == null ? '' : text),
        mode: mode,
        attachments: opts.attachments || undefined,
      });
    },

    /** Run a tool this extension declared (`tools:<name>` in manifest permissions). */
    runTool: function (name, args) {
      return call('runTool', { name: String(name || ''), args: args || {} });
    },

    /** Badge / colour / title on THIS tab. */
    setStatus: function (o) {
      return call('setStatus', o || {}).then(function () {});
    },

    /** Open a published artifact (or any host-relative path) as another tab. */
    openArtifact: function (p, o) {
      return call('openArtifact', { path: String(p || ''), title: (o && o.title) || undefined }).then(function () {});
    },

    /**
     * Listen to host events the manifest allows (`events:<glob>`), filtered to
     * this session by the shell. Returns an unsubscribe function.
     */
    subscribe: function (events, cb) {
      var list = (Array.isArray(events) ? events : [events]).map(String);
      var entry = { events: list, cb: cb };
      subs.push(entry);
      call('subscribe', { events: list }).catch(function () {});
      return function () {
        var i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
        call('unsubscribe', { events: list }).catch(function () {});
      };
    },

    /** Ask the shell to close this tab. */
    close: function () {
      post({ type: 'arigami:close' });
    },
  };

  window.arigami = sdk;
  try {
    window.dispatchEvent(new Event('arigami:sdk-ready'));
  } catch (e) { /* older engines */ }
})();
