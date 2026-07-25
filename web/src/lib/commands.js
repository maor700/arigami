// The app command bus: a single registry of named actions the app can perform.
// App.jsx registers the handlers (they need React state setters); voice control,
// keyboard shortcuts, and any future automation all drive the app through here.
//
// An "action" is { type, ...args } — the same shape the voice router emits.
// Keep the action types in sync with server/voice.js COMMANDS.

let handlers = {};

export function setCommandHandlers(map) {
  handlers = map || {};
}

export const knownActions = () => Object.keys(handlers);

// Run one action. `ctx` is a mutable object shared across a plan's actions so
// e.g. new_session/select_session can record the target session id that a
// following inject_prompt should use (ctx.targetSessionId). Handlers receive
// (action, ctx); returns whatever the handler returns (handlers may be async).
export async function runAction(action, ctx = {}) {
  if (!action || typeof action.type !== 'string') return;
  const fn = handlers[action.type];
  if (!fn) { console.warn('[commands] no handler for', action.type); return; }
  return fn(action, ctx);
}

// Run a plan (ordered list of actions), sequentially so e.g. select→inject lands
// on the right session. A failing action doesn't abort the rest.
export async function runActions(actions) {
  const ctx = {};
  for (const a of actions || []) {
    try { await runAction(a, ctx); } catch (e) { console.error('[commands]', a?.type, e); }
  }
}
