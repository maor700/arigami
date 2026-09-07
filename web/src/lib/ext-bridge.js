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
import { onWireEvent } from './store.js';
import { permissionsFor, hasPermission, globMatch, normalizeWireEvent } from './ext.js';

const V = 1;

/**
 * Create one bridge per extension tab.
 *
 * @param sessionId      the session the tab lives in — the only one it can reach
 * @param tabId          the tab's own id (setStatus/close act on it alone)
 * @param extension      the extension name (scopes runTool)
 * @param getWindow      () => the iframe's contentWindow (may be null before mount)
 * @param getPermissions () => manifest permissions, read live so a reload applies
 * @param getContext     () => the `arigami:init` context
 * @param post           (msg) => post to the iframe
 * @param api            REST client (injectable for tests)
 * @param subscribeWire  (fn) => unsubscribe, over raw WS messages (injectable)
 */
export function createExtBridge({
  sessionId,
  tabId,
  extension,
  getWindow,
  getPermissions = () => [],
  getContext = () => ({}),
  post,
  api = defaultApi,
  subscribeWire = onWireEvent,
}) {
  const subs = new Set(); // event names/globs the tab asked for
  let unsubWire = null;
  let disposed = false;

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
        const text = String(args.text ?? '');
        const attachments = Array.isArray(args.attachments) && args.attachments.length ? args.attachments : null;
        if (!text.trim() && !attachments) throw new Error('text required');
        // 'now' interrupts the running turn; 'queue' is the pending-prompt
        // queue, which the host plays when the session goes idle.
        if (args.mode === 'now') {
          await api.post(`/sessions/${sessionId}/message`, attachments ? { text, attachments } : { text });
          return { delivered: 'now' };
        }
        await api.post(`/sessions/${sessionId}/prompts`, { text });
        return { delivered: 'queued' };
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
        const patch = {};
        for (const k of ['badge', 'color', 'title']) if (k in (args || {})) patch[k] = args[k];
        await api.patch(`/sessions/${sessionId}/tabs/${tabId}`, patch);
        return { ok: true };
      }
      case 'openArtifact': {
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
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  async function closeTab() {
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
