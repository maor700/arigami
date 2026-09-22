// EXT — the SHELL side of the extension tab bridge (protocol v1, frozen in
// sdk/browser/ext-sdk.js §"PROTOCOL v1").
//
// An extension page is served from /__ext/<name>/ with
// `Content-Security-Policy: sandbox allow-scripts …` and WITHOUT
// allow-same-origin, and the cockpit's iframe repeats the sandbox. It therefore
// has an OPAQUE origin: no cookie, no localStorage, no reachable /__api. Every
// capability it has comes through postMessage, and this module is the only
// thing that grants any of it.
//
// Two rules make that safe, and they are the whole security story:
//   1. a message is only ever considered when `event.source` is THIS tab's
//      `iframe.contentWindow` — not its origin, which is opaque and unnameable;
//   2. the method is checked against the extension's manifest permissions
//      before any REST call is made. Unknown method or missing permission →
//      `{ok:false, error:'permission denied: <perm>'}`, and nothing happens.
//
// Replies go out with targetOrigin '*' because an opaque origin cannot be
// named — the same asymmetry the SDK documents. Nothing but the tab's own
// context and the events it subscribed to is ever posted.
import { api as defaultApi } from './api.js';
import { onWireEvent, getState } from './store.js';
import { permissionsFor, hasPermission, globMatch, normalizeWireEvent } from './ext.js';

const V = 1;

/**
 * Create one bridge per extension tab.
 *
 * @param sessionId      the session the tab lives in — the only one it can reach.
 *                       `null` for a LAUNCHER tab: there is no session yet, so
 *                       every session-scoped method refuses and `runTool` /
 *                       `createSession` are what the tab has.
 * @param tabId          the tab's own id (setStatus/close act on it alone)
 * @param extension      the extension name (scopes runTool)
 * @param getWindow      () => the iframe's contentWindow (may be null before mount)
 * @param getPermissions () => manifest permissions, read live so a reload applies
 * @param getContext     () => the `arigami:init` context
 * @param getSessionState () => the session's claude state ('idle' | 'working' |
 *                       …), read live — mode 'auto' routes on it
 * @param post           (msg) => post to the iframe
 * @param api            REST client (injectable for tests)
 * @param subscribeWire  (fn) => unsubscribe, over raw WS messages (injectable)
 * @param onHello        called the first time the tab's SDK announces itself —
 *                       the shell uses it to notice a page whose script never
 *                       loaded (EXT3: a stale asset token) and reload once
 */
export function createExtBridge({
  sessionId,
  tabId,
  extension,
  getWindow,
  getPermissions = () => [],
  getContext = () => ({}),
  getSessionState = () => getState().sessions.find((s) => s.id === sessionId)?.claude?.state || '',
  post,
  // Called after createSession succeeds, with the created session record: the
  // cockpit closes the launcher and opens it, the same handoff its own
  // built-in modes do.
  onCreated = () => {},
  api = defaultApi,
  subscribeWire = onWireEvent,
  onHello = () => {},
}) {
  const subs = new Set(); // event names/globs the tab asked for
  let unsubWire = null;
  let disposed = false;
  // A launcher tab. Kept as a named condition rather than checked inline at
  // each call site: the rule is one rule — no session, no session-scoped
  // method — and the failure it prevents is silent and ugly (a request to
  // `/sessions/null/message`, which the server answers 404 and the tab reports
  // as "not found" to a human who did nothing wrong).
  const sessionless = !sessionId;
  const needsSession = (method) => {
    if (!sessionless) return;
    throw new Error(`${method} needs a session — this tab was opened from the launcher, before one exists`);
  };

  const sendInit = () => {
    if (disposed) return;
    post({ type: 'arigami:init', v: V, context: getContext() });
  };

  function ensureWire() {
    if (unsubWire || disposed || !subs.size) return;
    unsubWire = subscribeWire(onWire);
  }

  function stopWire() {
    if (!unsubWire) return;
    try { unsubWire(); } catch { /* already gone */ }
    unsubWire = null;
  }

  // A host event → the tab, if it is for THIS session, matches something the
  // tab subscribed to, and is still covered by `events:<glob>`. The permission
  // is re-checked on delivery, not just at subscribe time, so a reload that
  // narrows the manifest takes effect immediately.
  function onWire(msg) {
    if (disposed || !subs.size) return;
    const ev = normalizeWireEvent(msg);
    if (!ev) return;
    // A session-scoped event reaches a launcher tab never: it has no session to
    // compare against, and "no session" must not read as "every session".
    if (ev.sessionId && ev.sessionId !== sessionId) return;
    let matched = false;
    for (const p of subs) {
      if (globMatch(p, ev.name)) { matched = true; break; }
    }
    if (!matched) return;
    if (!hasPermission(getPermissions(), `events:${ev.name}`)) return;
    post({ type: 'arigami:event', v: V, name: ev.name, payload: ev.payload });
  }

  const eventList = (raw) =>
    (Array.isArray(raw) ? raw : [raw]).map((x) => String(x || '')).filter(Boolean);

  async function invoke(method, args) {
    const needed = permissionsFor(method, args);
    if (needed === null) throw new Error(`unknown method: ${method}`);
    const perms = getPermissions();
    if (needed.length && !needed.some((p) => hasPermission(perms, p)))
      throw new Error(`permission denied: ${needed[0]}`);

    switch (method) {
      case 'sendPrompt': {
        needsSession('sendPrompt');
        const text = String(args.text ?? '');
        const attachments = Array.isArray(args.attachments) && args.attachments.length ? args.attachments : null;
        if (!text.trim() && !attachments) throw new Error('text required');
        // Three modes, and the default is the host's own delivery rule:
        //   'now'   — write to the session immediately, even mid-turn;
        //   'queue' — only add a pending prompt (it waits for ▶ unless the
        //             human already turned auto-play on);
        //   'auto'  — deliverToSession (server/api.ts): an idle session gets it
        //             now, a busy one gets it queued AND auto-play turned on, so
        //             it plays the moment the turn ends. Nothing is interrupted.
        // 'auto' is the default: a tab that says nothing wants its prompt to be
        // acted on, not to sit in a queue behind a switch it cannot see.
        const mode = args.mode === 'now' || args.mode === 'queue' ? args.mode : 'auto';
        const sendNow = async () => {
          await api.post(`/sessions/${sessionId}/message`, attachments ? { text, attachments } : { text });
          return { delivered: 'now' };
        };
        const enqueue = async (autoplay) => {
          await api.post(`/sessions/${sessionId}/prompts`, { text });
          if (autoplay) await api.post(`/sessions/${sessionId}/prompts/autoplay`, { on: true });
          return { delivered: 'queued' };
        };
        if (mode === 'now') return sendNow();
        if (mode === 'queue') return enqueue(false);
        // 'auto': deliver now only if the session is idle AND the extension
        // actually holds `session:message` — an extension granted only
        // `session:prompts` keeps the queue path (with auto-play), it does not
        // get promoted into the stronger permission by the default mode.
        const idle = getSessionState() === 'idle';
        if (idle && hasPermission(perms, 'session:message')) return sendNow();
        return enqueue(true);
      }
      case 'runTool': {
        const name = String(args.name || '');
        if (!name) throw new Error('tool name required');
        const r = await api.post(`/ext/${extension}/tool/${encodeURIComponent(name)}`, {
          args: args.args && typeof args.args === 'object' ? args.args : {},
        });
        return r?.result;
      }
      case 'setStatus': {
        needsSession('setStatus');
        const patch = {};
        for (const k of ['badge', 'color', 'title']) if (k in (args || {})) patch[k] = args[k];
        await api.patch(`/sessions/${sessionId}/tabs/${tabId}`, patch);
        return { ok: true };
      }
      case 'openArtifact': {
        needsSession('openArtifact');
        const path = String(args.path || '');
        // Host-RELATIVE only, as the SDK promises. Without this an extension
        // with `session:tabs` could plant any external site in the cockpit.
        if (!path.startsWith('/')) throw new Error('path must be host-relative (start with "/")');
        await api.post(`/sessions/${sessionId}/tabs`, {
          type: 'url',
          url: path,
          ...(args.title ? { title: String(args.title) } : {}),
        });
        return { ok: true };
      }
      case 'subscribe': {
        const events = eventList(args.events);
        for (const name of events)
          if (!hasPermission(perms, `events:${name}`)) throw new Error(`permission denied: events:${name}`);
        for (const name of events) subs.add(name);
        ensureWire();
        return { ok: true };
      }
      case 'unsubscribe': {
        for (const name of eventList(args.events)) subs.delete(name);
        if (!subs.size) stopWire();
        return { ok: true };
      }
      // The inbox goes through the BRIDGE and not through an extension tool,
      // and that is a safety decision rather than a style one. An extension's
      // tools are also mounted into the session's --mcp-config, so an
      // `inbox_submit` tool would let the AGENT approve and send its own
      // drafted replies — the submit gate exists precisely to stop that. Here
      // the cockpit makes the call, as the signed-in human, and the agent has
      // no way to reach it.
      case 'inboxList': {
        needsSession('inboxList');
        return await api.get(`/sessions/${sessionId}/inbox`);
      }
      case 'inboxPatch': {
        needsSession('inboxPatch');
        const itemId = String(args.itemId || '');
        if (!itemId) throw new Error('itemId required');
        // An allowlist, mirroring the REST route: a tab may record a decision
        // and edit the drafted texts. It may not touch `body`, `source` or
        // `settled` — what a person wrote is not the cockpit's to rewrite.
        const patch = {};
        for (const k of ['decision', 'replyOverride', 'noteToAgent'])
          if (k in (args.patch || {})) patch[k] = args.patch[k];
        if (!Object.keys(patch).length) throw new Error('nothing to patch');
        return await api.patch(`/sessions/${sessionId}/inbox/${encodeURIComponent(itemId)}`, patch);
      }
      case 'inboxSubmit': {
        needsSession('inboxSubmit');
        return await api.post(`/sessions/${sessionId}/inbox/submit`, {
          note: args.note ? String(args.note) : '',
        });
      }
      case 'inboxEnrich': {
        needsSession('inboxEnrich');
        // The "explain it" button on a low-signal item. It starts a READ-ONLY
        // drafting run; it cannot send anything, and what it writes back is
        // whitelisted to the agent's own fields.
        return await api.post(`/sessions/${sessionId}/inbox/enrich-now`, {});
      }
      case 'createSession': {
        // The launcher surface's whole reason to exist. Restricted TO it on
        // purpose: from inside a session this would be a second, unaudited way
        // to spawn agents that bypasses the launcher, the dispatch caps and
        // every bit of provenance that comes with create_session. A tab that
        // wants to spawn work from within a session has the MCP tool.
        if (!sessionless)
          throw new Error('createSession is for launcher tabs — inside a session, use the create_session tool');
        const spec = (args && typeof args.spec === 'object' && args.spec) || {};
        // An allowlist, not a spread: `spec` is whatever a sandboxed page sent,
        // and POST /__api/sessions accepts orchestration fields (master, kind,
        // subtask, worktree…) that would let a tab graft itself into someone
        // else's dispatch tree.
        const body = {};
        for (const k of ['title', 'cwd', 'prompt', 'skill', 'agent', 'engine', 'model', 'effort'])
          if (spec[k] != null && spec[k] !== '') body[k] = String(spec[k]);
        if (spec.permissionMode) body.permissionMode = String(spec.permissionMode);
        if (spec.metadata && typeof spec.metadata === 'object' && !Array.isArray(spec.metadata))
          body.metadata = spec.metadata;
        const s = await api.post('/sessions', body);
        // Order matters: a deferred answer carries no `id` either, so the
        // generic check below would swallow it and report "the host did not
        // create a session" for something that is not a failure at all — the
        // host is at the dispatch cap and the right move is to retry later.
        if (s?.deferred) throw new Error(`the host deferred this: ${s.reason || 'at capacity'}`);
        if (!s?.id) throw new Error(s?.error || 'the host did not create a session');
        // The whole record, not just the id: the cockpit's own handoff
        // (App.jsx onCreated) selects `session.id` and closes the launcher, and
        // handing it the same shape its built-in modes do keeps one path.
        onCreated(s);
        return { id: s.id };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  async function closeTab() {
    // Nothing to close: a launcher tab is not a tab record, it is a mode in the
    // launcher. The human closes it by picking another mode.
    if (sessionless) return;
    if (!hasPermission(getPermissions(), 'session:tabs')) return;
    try {
      await api.del(`/sessions/${sessionId}/tabs/${tabId}`);
    } catch {
      /* the tab may already be gone — closing twice is not an error */
    }
  }

  /** The window 'message' handler. Everything not from OUR iframe is ignored. */
  async function onMessage(event) {
    if (disposed) return;
    const win = getWindow?.();
    if (!win || event?.source !== win) return;
    const m = event.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type === 'arigami:hello') {
      // The SDK announces itself until it hears back; init is idempotent.
      try { onHello(); } catch { /* the shell's problem, not the tab's */ }
      sendInit();
      return;
    }
    if (m.type === 'arigami:close') {
      await closeTab();
      return;
    }
    if (m.type !== 'arigami:call') return;
    const id = m.id;
    try {
      const value = await invoke(String(m.method || ''), m.args && typeof m.args === 'object' ? m.args : {});
      post({ type: 'arigami:result', v: V, id, ok: true, value });
    } catch (e) {
      post({ type: 'arigami:result', v: V, id, ok: false, error: String(e?.message || e) });
    }
  }

  function dispose() {
    disposed = true;
    subs.clear();
    stopWire();
  }

  return { onMessage, sendInit, dispose, _subs: subs };
}
