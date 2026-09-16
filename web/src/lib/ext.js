// EXT (wave 2, web) — the cockpit's own view of the extension system.
//
// Pure functions only (unit-tested in test/ext-web.test.js): the permission
// algebra the tab bridge enforces, the wire-event normalisation it forwards,
// and the manifest→UI derivations (settings form, tab-bar rows, slash items).
// Nothing here touches React or the network; ext-bridge.js and the Settings
// page do that.
//
// The permission strings are the manifest's (`session:message`,
// `session:prompts`, `session:tabs`, `tools:<name>`, `events:<glob>`). The
// SHELL is the only authority — an extension page has an opaque origin and
// cannot call /__api itself, so whatever is refused here simply cannot happen.
import { t } from './i18n.js';

/**
 * SDK-compatible glob: an exact match, or a `prefix*` pattern. Mirrors
 * `matches()` in sdk/browser/ext-sdk.js so both sides agree on what a
 * subscription covers. A bare `*` is NOT a wildcard — the manifest validator
 * warns that such a permission "grants nothing", and this keeps that true.
 */
export function globMatch(pattern, name) {
  const p = String(pattern || '');
  const n = String(name || '');
  if (p === n) return true;
  const star = p.indexOf('*');
  if (star < 0 || star !== p.length - 1) return false;
  const prefix = p.slice(0, -1);
  return prefix.length > 0 && n.startsWith(prefix);
}

/**
 * Is `needed` covered by the manifest's granted permissions? A granted entry
 * matches exactly, or as a namespaced glob (`tools:*`, `events:merge.*`) —
 * the same rule the host applies in `toolPermitted`, generalised.
 */
export function hasPermission(permissions, needed) {
  const want = String(needed || '');
  if (!want) return false;
  for (const raw of permissions || []) {
    if (typeof raw !== 'string') continue;
    if (raw === want) return true;
    if (raw.endsWith('*') && raw.includes(':') && want.startsWith(raw.slice(0, -1))) return true;
  }
  return false;
}

/**
 * The permission(s) an `arigami:call` method needs. The FIRST entry is the one
 * a denial names; ANY of them grants the call.
 *
 * `sendPrompt` is the one place with an alternative: queueing needs
 * `session:prompts`, but `session:message` — which may interrupt a running
 * turn — is strictly stronger, so it covers the queue too. The default mode
 * 'auto' may take either path (idle → message, busy → queue + auto-play), so
 * it asks for the same pair as 'queue'; the bridge then only takes the
 * message path when `session:message` is actually held. Returns `null` for
 * an unknown method (→ "unknown method"), `[]` for the ones checked per
 * argument (subscribe/unsubscribe check `events:<name>` one by one).
 */
export function permissionsFor(method, args = {}) {
  switch (method) {
    case 'sendPrompt':
      return args?.mode === 'now' ? ['session:message'] : ['session:prompts', 'session:message'];
    case 'runTool':
      return [`tools:${String(args?.name || '')}`];
    case 'setStatus':
    case 'openArtifact':
    case 'close':
      return ['session:tabs'];
    case 'createSession':
      return ['host:create-session'];
    case 'subscribe':
    case 'unsubscribe':
      return [];
    default:
      return null;
  }
}

/**
 * A raw WebSocket message → `{name, sessionId, payload}` the bridge may forward,
 * or null when it is not something an extension tab can subscribe to.
 *
 * Exactly four names cross the bridge (SPEC-EXT §6): `chat` (the wire type is
 * `chat:<sessionId>`), `session-updated`, `listener-updated`, and any
 * `ext:<name>` an extension broadcasts. `sessionId` is what the caller filters
 * on — an event without one is not session-scoped and reaches every tab that
 * asked for it and is allowed it.
 */
export function normalizeWireEvent(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  const type = msg.type;
  const payload = msg.payload !== undefined ? msg.payload : msg;
  const carried = msg.sessionId || msg.session_id || payload?.sessionId || payload?.session_id || '';

  if (type === 'chat' || type.startsWith('chat:')) {
    const sessionId = type.slice(5) || carried;
    return { name: 'chat', sessionId, payload: payload?.event ?? payload };
  }
  if (type === 'session-updated') {
    const s = payload?.session ?? payload;
    return { name: 'session-updated', sessionId: s?.id || carried, payload: s };
  }
  if (type === 'listener-updated') {
    const l = payload?.listener ?? payload;
    return { name: 'listener-updated', sessionId: l?.sessionId || carried, payload: l };
  }
  if (/^ext:[a-z0-9][a-z0-9-]*$/.test(type)) return { name: type, sessionId: carried, payload };
  return null;
}

/** Loaded AND enabled — the only extensions the cockpit offers anything for. */
export const isActive = (e) => !!e && e.state === 'loaded' && e.enabled !== false;

/** The extension record for `name` out of the store's list. */
export const findExtension = (extensions, name) =>
  (extensions || []).find((e) => e && e.name === name) || null;

/**
 * `settings.schema` → the rows the Settings form renders. Anything that is not
 * a number or a boolean is edited as text, so an unknown/absent `type` still
 * gets a usable field instead of disappearing.
 */
export function settingsFields(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  return Object.entries(schema).map(([key, raw]) => {
    const def = raw && typeof raw === 'object' ? raw : {};
    const type =
      def.type === 'number' || def.type === 'integer'
        ? 'number'
        : def.type === 'boolean'
          ? 'boolean'
          : 'string';
    return {
      key,
      type,
      title: typeof def.title === 'string' && def.title ? def.title : key,
      description: typeof def.description === 'string' ? def.description : '',
      fallback: def.default,
    };
  });
}

/** The value a field starts on: what is saved, else the schema default. */
export function fieldValue(field, saved) {
  const cur = saved && Object.prototype.hasOwnProperty.call(saved, field.key) ? saved[field.key] : field.fallback;
  if (field.type === 'boolean') return cur === true;
  if (cur === undefined || cur === null) return '';
  return String(cur);
}

/**
 * The form state → the `settings` object for PATCH /__api/extensions/:name.
 * A number field left empty is omitted (it means "use the default"), never
 * sent as NaN; a non-numeric entry is dropped the same way.
 */
export function coerceSettings(fields, form) {
  const out = {};
  for (const f of fields || []) {
    const v = form?.[f.key];
    if (f.type === 'boolean') {
      out[f.key] = v === true;
      continue;
    }
    if (f.type === 'number') {
      const s = String(v ?? '').trim();
      if (!s) continue;
      const n = Number(s);
      if (Number.isFinite(n)) out[f.key] = n;
      continue;
    }
    out[f.key] = String(v ?? '');
  }
  return out;
}

/**
 * Every tab an active extension declares → the rows the "+" popover offers.
 * `openFrom` is NOT filtered on here: it says where a tab is offered ON TOP of
 * the tab bar (a `slash:` entry adds a composer command), never where it is
 * hidden from.
 */
export function extTabItems(extensions) {
  const out = [];
  for (const e of extensions || []) {
    if (!isActive(e)) continue;
    for (const tb of e.tabs || []) {
      if (!tb?.id) continue;
      out.push({
        ext: e.name,
        extTitle: e.title || e.name,
        tab: tb.id,
        title: tb.title || tb.id,
        icon: tb.icon || null,
      });
    }
  }
  return out;
}

/**
 * Manifest `openFrom: ["launcher"]` → extra modes in the new-session launcher,
 * beside the built-in "From ticket" / "Empty session" / "From trigger".
 *
 * This is the platform seam that keeps role-specific creation flows OUT of the
 * core launcher: "review a pull request" belongs to a developer profile, not to
 * every Arigami, so it arrives as an extension that claims a mode here rather
 * than as a fourth hardcoded tab.
 *
 * Only extensions that actually hold `host:create-session` are offered. A mode
 * that can list and pick but not start anything is worse than an absent one —
 * the human finds out at the last click. `ext validate` warns about the same
 * pairing, this is the runtime half of it.
 */
export function extLauncherItems(extensions) {
  const out = [];
  for (const e of extensions || []) {
    if (!isActive(e)) continue;
    if (!hasPermission(e.permissions || [], 'host:create-session')) continue;
    for (const tb of e.tabs || []) {
      if (!tb?.id || !(tb.openFrom || []).includes('launcher')) continue;
      out.push({
        // `mode` is what Launcher.jsx switches on; namespaced so an extension
        // can never collide with 'ticket' | 'empty' | 'trigger'.
        mode: `ext:${e.name}:${tb.id}`,
        ext: e.name,
        tab: tb.id,
        title: tb.title || tb.id,
        // entry is `ui/index.html`; the /__ext mount is rooted AT ui/.
        url: `/__ext/${e.name}/${String(tb.entry || 'ui/index.html').replace(/^ui\//, '')}`,
        trusted: e.trusted === true,
      });
    }
  }
  return out;
}

/**
 * Manifest `openFrom: ["slash:/pick"]` → composer palette items. The item runs
 * on pick (`run:true`) and carries `extTab`, which ChatFooter turns into
 * `POST /sessions/:id/tabs {type:'ext'}`.
 */
export function extSlashItems(extensions) {
  const out = [];
  const seen = new Set();
  for (const e of extensions || []) {
    if (!isActive(e)) continue;
    for (const tb of e.tabs || []) {
      if (!tb?.id) continue;
      for (const from of tb.openFrom || []) {
        const m = /^slash:\/?([\w:-]+)$/.exec(String(from || '').trim());
        if (!m) continue;
        const name = m[1];
        if (seen.has(name)) continue; // first extension to claim the name keeps it
        seen.add(name);
        out.push({
          name,
          desc: t('ext.slashDesc', { tab: tb.title || tb.id, ext: e.title || e.name }),
          host: true,
          run: true,
          extTab: { ext: e.name, tab: tb.id, title: tb.title || tb.id },
        });
      }
    }
  }
  return out;
}

/** `/__ext/<name>/…` → `<name>` (older tabs have no `ext` field stamped on them). */
export function extNameFromUrl(url) {
  const m = /^\/__ext\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/.exec(String(url || ''));
  return m ? m[1] : '';
}

/** The extension a tab belongs to, or '' when it is an ordinary url tab. */
export const extOfTab = (tab) => String(tab?.ext || '') || extNameFromUrl(tab?.url);
