// Sessions store: single WS connection (auto-reconnect with backoff) + REST
// snapshots. No optimistic updates — the server echoes every mutation via WS.
import { useSyncExternalStore } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { mergeChatEvents, foldSetupUpdates } from './chat-merge.js';
import { confirmDialog } from './confirm.js';
import { toast, toastError } from './toast.js';
import { t } from './i18n.js';
import { sessionLabel } from '../components/ui.jsx';

let state = {
  sessions: [], // includes archived (REST snapshot merges them in)
  folders: [], // rail folders (session.folderId points here)
  agents: [], // A1: the team (GET /__api/agents; 'agents-updated' over WS)
  listeners: [], // deterministic pollers armed by sessions (PR watches etc.)
  triggers: [], // standing trigger rules (Linear-filter producers)
  pending: [], // Pending-tasks queue (ordered = autoplay execution order)
  queue: { autoplay: false, maxConcurrent: 3 }, // queue policy
  chats: {}, // sessionId -> [normalized chat events]
  chatLoaded: {}, // sessionId -> true once rehydrated over REST
  capsFull: {}, // sessionId -> {rev, caps}: full claude.capabilities (list payloads carry a slim form)
  drafts: {}, // sessionId -> unsent composer draft {text, attachments}
  lastSent: {}, // sessionId -> the draft most recently sent (for Esc-restore)
  conn: 'connecting', // 'open' | 'connecting' | 'down'
  config: null, // GET /__api/config result (null until loaded / failed)
  // C1 auth: undefined = not yet checked, null = signed out (Login screen),
  // object = GET /__api/auth/me ({user, principal, isAdmin, authMode, hasAdmin, oidc}).
  auth: undefined,
  authInfo: null, // {authMode, hasAdmin, oidc} — known even when signed out
  wizardTick: 0, // B3: bumps on every onboarding.step bus event (Wizard.jsx re-reads)
  setupTick: 0, // S2: bumps on every setup.* bus event (Connections card / Setup re-read)
  // RES1: the supervisor's health map (sessionId → {state, reason, dot, since})
  // and the aggregated "ממתין לך" queue. Both arrive as a `health` bus event
  // whenever they change; `loadHealth()` is the initial snapshot.
  health: {},
  waiting: [],
  usage: null, // GET /__api/usage — subscription 5h/7d windows (null until loaded)
  accounts: null, // GET /__api/accounts — { activeId, accounts:[…] } (null until loaded)
  accountUsage: {}, // accountId -> usage snapshot (from 'account-usage' broadcasts)
  // Shared desktop UI state — one source of truth for the chat card, the
  // session side panel and the enlarge modal (they all show the SAME VNC
  // connection, see useScreenConnection.js):
  //   controlRequestId — the screen-request the human "took over" (the
  //     interactive modal is open for it, auto-snapshots paused); null = no
  //     takeover in progress. Keyed by request so a stale takeover never
  //     leaks into the next request.
  //   panel — side-panel visibility: null = auto (open while the selected
  //     session has an open screen-request), true/false = user override.
  //     Reset to auto whenever a new screen-request arrives.
  //   modal — the interactive ScreenModal: false = closed; {} = the plain
  //     global view (rail icon); {sessionId, requestId} = opened by "Take
  //     over" on a request_screen card, so the modal shows Done / Cancel.
  screen: { controlRequestId: null, panel: null, modal: false },
};

const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  detectAttention();
  for (const fn of listeners) fn();
}

/* ---------------- "needs attention" detection ---------------------------- */
// A session needs attention when it has a pending question for the human.
export function needsAttention(s) {
  return !!(s && (s.action || s.claude?.state === 'awaiting-input'));
}

// Set of session ids currently needing attention (kept across setState calls).
let attentionSet = new Set();
// Callback fired ONCE per (clean → attention) transition, with the session.
let onAttention = null;

export function setAttentionHandler(fn) {
  onAttention = fn;
}

function detectAttention() {
  const next = new Set();
  for (const s of state.sessions) {
    if (needsAttention(s)) {
      next.add(s.id);
      if (!attentionSet.has(s.id) && onAttention) {
        try {
          onAttention(s);
        } catch {
          /* never let a beep break the store */
        }
      }
    }
  }
  attentionSet = next;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getState = () => state;

export function useStore() {
  return useSyncExternalStore(subscribe, getState, getState);
}

// Per-session composer draft — survives switching away and back to a session.
export function getDraft(sessionId) {
  return state.drafts[sessionId] || { text: '', attachments: [] };
}

export function setDraft(sessionId, patch) {
  if (!sessionId) return;
  const cur = getDraft(sessionId);
  setState({ drafts: { ...state.drafts, [sessionId]: { ...cur, ...patch } } });
}

export function clearDraft(sessionId) {
  if (!sessionId) return;
  const next = { ...state.drafts };
  delete next[sessionId];
  setState({ drafts: next });
}

// The draft that was in flight when the user last hit Send — kept so an
// interrupt can hand it back to the composer for editing/resending.
export function setLastSent(sessionId, draft) {
  if (!sessionId) return;
  setState({ lastSent: { ...state.lastSent, [sessionId]: draft } });
}

// Stop a session's running turn and, if it had an in-flight prompt, restore
// it to that session's draft so the composer isn't left empty after Esc/■.
// Confirm-then-restart a session's claude proc in place (worktree/chat/metadata
// survive; MCP connections are re-established). Shared by the rail row menu and
// the terminal-header gear menu. Completion is announced by upsertSession when
// claude.state leaves 'restarting'.
export async function restartSession(session) {
  if (!session?.id) return;
  const ok = await confirmDialog({
    title: 'Restart this session?',
    body: `Kills the claude process for "${sessionLabel(session)}" and respawns it in place — the worktree, chat and metadata are kept, and MCP connections are re-established. Anything it is doing right now is aborted.`,
    confirmLabel: 'Restart',
  });
  if (ok) await api.post(`/sessions/${session.id}/restart`).catch((e) => toastError(`Restart failed: ${e.message || e}`));
}

// Confirm-then-clear: drops the claude conversation and starts fresh in the
// SAME tab (worktree/metadata/chat log survive — only the model's memory of
// the conversation resets, same as this tab becoming a brand new session).
export async function clearSessionConversation(session) {
  if (!session?.id) return;
  const ok = await confirmDialog({
    title: 'Clear this conversation?',
    body: `Starts a brand new claude conversation for "${sessionLabel(session)}" — the worktree, chat log and metadata are kept, but the model loses all memory of what was discussed so far. Anything it is doing right now is aborted.`,
    confirmLabel: 'Clear',
  });
  if (ok) await api.post(`/sessions/${session.id}/clear`).catch((e) => toastError(`Clear failed: ${e.message || e}`));
}

export async function interruptSession(sessionId) {
  if (!sessionId) return;
  await api.post(`/sessions/${sessionId}/interrupt`).catch(() => {});
  const last = state.lastSent[sessionId];
  if (last) {
    setDraft(sessionId, last);
    setState({ lastSent: { ...state.lastSent, [sessionId]: null } });
    window.dispatchEvent(new CustomEvent('host:draft-restored', { detail: { sessionId } }));
  }
}

/* ---------------- session mutations (driven by WS / REST snapshots) ------- */

function upsertSession(session) {
  if (!session || !session.id) return;
  const exists = state.sessions.some((s) => s.id === session.id);
  // Restart completion signal: the server holds claude.state at 'restarting'
  // until the respawned proc's handshake replies. Announce the transition here
  // so it fires no matter where the restart came from (rail, header, MCP).
  const prev = state.sessions.find((s) => s.id === session.id);
  if (prev?.claude?.state === 'restarting' && session.claude?.state && session.claude.state !== 'restarting') {
    if (session.claude.state === 'dead') toastError(`${sessionLabel(session)} failed to restart`);
    else toast(`${sessionLabel(session)} restarted — MCP connections re-established`);
  }
  setState({
    sessions: exists
      ? state.sessions.map((s) => (s.id === session.id ? { ...s, ...session } : s))
      : [...state.sessions, session],
  });
}

function removeSession(id) {
  if (!id) return;
  setState({
    sessions: state.sessions.filter((s) => s.id !== id),
    listeners: state.listeners.filter((l) => l.sessionId !== id),
  });
}

/* ---------------- listeners (driven by WS) ------------------------------- */

function upsertListener(listener) {
  if (!listener || !listener.id) return;
  const exists = state.listeners.some((l) => l.id === listener.id);
  setState({
    listeners: exists
      ? state.listeners.map((l) => (l.id === listener.id ? { ...l, ...listener } : l))
      : [...state.listeners, listener],
  });
}

function removeListener(id) {
  if (!id) return;
  setState({ listeners: state.listeners.filter((l) => l.id !== id) });
}

// Selector: live listeners for a session (hide stopped ones from the chips).
export function listenersForSession(s, sessionId) {
  return (s.listeners || []).filter((l) => l.sessionId === sessionId && l.status !== 'stopped');
}

function patchSession(id, patch) {
  setState({
    sessions: state.sessions.map((s) =>
      s.id === id ? (typeof patch === 'function' ? patch(s) : { ...s, ...patch }) : s,
    ),
  });
}

function mergeSnapshot(list) {
  if (!Array.isArray(list)) return;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  for (const s of list) {
    if (s && s.id) byId.set(s.id, { ...(byId.get(s.id) || {}), ...s });
  }
  setState({ sessions: [...byId.values()] });
}

function replaceSnapshot(list) {
  if (!Array.isArray(list)) return;
  // WS state replay is authoritative for everything it contains, but it may
  // omit archived sessions — keep any archived ones it didn't mention.
  const ids = new Set(list.filter((s) => s && s.id).map((s) => s.id));
  const keepArchived = state.sessions.filter((s) => s.archived && !ids.has(s.id));
  setState({ sessions: [...list.filter((s) => s && s.id), ...keepArchived] });
}

function appendChat(sessionId, event) {
  if (!sessionId || !event) return;
  const cur = state.chats[sessionId] || [];
  // A permission request arrives both as a chat event and as its own WS
  // broadcast — render it once.
  if (event.kind === 'permission-request' && cur.some((e) => e.kind === 'permission-request' && e.requestId === event.requestId)) return;
  // A permission answer patches the original card in place instead of
  // appending a second (unrendered) event — without this, a request the
  // server resolved on its own (timeout, or the process dying) leaves the
  // card showing live Allow/Deny buttons forever.
  if (event.kind === 'permission-answer') {
    const idx = cur.findIndex((e) => e.kind === 'permission-request' && e.requestId === event.requestId);
    if (idx !== -1 && cur[idx].answered == null) {
      const next = [...cur];
      next[idx] = { ...next[idx], answered: event.behavior, answeredMessage: event.message };
      setState({ chats: { ...state.chats, [sessionId]: next } });
    }
    return;
  }
  // Same in-place-patch pattern as permission-answer, for request_screen
  // cards — this is also what tears down the live VNC connection (the card
  // stops rendering ScreenView once `answered` is set).
  if (event.kind === 'screen-request-answer') {
    const idx = cur.findIndex((e) => e.kind === 'screen-request' && e.requestId === event.requestId);
    let screen = state.screen;
    if (screen.controlRequestId === event.requestId) screen = { ...screen, controlRequestId: null };
    // Answered elsewhere (timeout, session died, another tab): the takeover
    // modal for this request loses its context — close it.
    if (screen.modal && screen.modal.requestId === event.requestId) screen = { ...screen, modal: false };
    if (idx !== -1 && cur[idx].answered == null) {
      const next = [...cur];
      next[idx] = { ...next[idx], answered: true, note: event.note, takenOver: !!event.takenOver };
      setState({ chats: { ...state.chats, [sessionId]: next }, screen });
    } else if (screen !== state.screen) setState({ screen });
    return;
  }
  // S2: `setup-update` patches the {kind:'setup'} card in place (state,
  // detail, evidence, appended narration lines) — same pattern as above.
  if (event.kind === 'setup-update') {
    const idx = cur.findIndex((e) => e.kind === 'setup' && e.requestId === event.requestId);
    if (idx === -1) return;
    const { kind: _k, requestId: _r, lines, ...patch } = event;
    const prev = cur[idx];
    const next = [...cur];
    // The host sends the card's FULL narration list on every update (F6); a
    // delta (old hosts / the dev shim) is appended. Prefix check tells them apart.
    const prevLines = prev.lines || [];
    const full = Array.isArray(lines) && lines.length >= prevLines.length && prevLines.every((l, i) => lines[i] === l);
    next[idx] = { ...prev, ...patch, ...(lines ? { lines: full ? lines : [...prevLines, ...lines] } : {}) };
    setState({ chats: { ...state.chats, [sessionId]: next }, setupTick: Date.now() });
    return;
  }
  // A1: `agent-card-update` patches the {kind:'agent-card'} card in place (cardId).
  if (event.kind === 'agent-card-update') {
    const idx = cur.findIndex((e) => e.kind === 'agent-card' && e.cardId === event.cardId);
    if (idx === -1) return;
    const { kind: _k, cardId: _c, ...patch } = event;
    const next = [...cur];
    next[idx] = { ...next[idx], ...patch };
    setState({ chats: { ...state.chats, [sessionId]: next } });
    return;
  }
  if (event.kind === 'setup') setState({ setupTick: Date.now() });
  // A fresh screen-request re-arms the side panel's auto-open (a manual close
  // applies to the request that was open at the time, not forever).
  if (event.kind === 'screen-request' && state.screen.panel !== null) {
    setState({ screen: { ...state.screen, panel: null } });
  }
  const last = cur[cur.length - 1];
  let next;
  if (event.partial) {
    // Streaming text deltas accumulate into ONE growing trailing message.
    next = last?.partial
      ? [...cur.slice(0, -1), { ...last, text: (last.text || '') + (event.text || '') }]
      : [...cur, event];
  } else if (event.kind === 'assistant-text' && last?.partial) {
    // The persisted full message replaces the streamed partial.
    next = [...cur.slice(0, -1), event];
  } else {
    next = [...cur, event];
  }
  setState({ chats: { ...state.chats, [sessionId]: next } });
}

// S2 dev shim (lib/setup-api.js): append / patch a local-only chat event.
export function injectLocalChat(sessionId, event) {
  appendChat(sessionId, event);
}
export function patchLocalChat(sessionId, kind, requestId, patch) {
  if (kind === 'setup') appendChat(sessionId, { kind: 'setup-update', requestId, ...patch });
}

/* ---------------- REST loaders ------------------------------------------- */

export async function loadSessions() {
  try {
    const list = await api.get('/sessions?archived=true');
    const sessions = Array.isArray(list) ? list : list?.sessions;
    mergeSnapshot(sessions);
    // Prefetch chat for the first active session so it's ready when selected
    if (sessions?.length) {
      const first = sessions
        .filter((s) => !s.archived)
        .sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9))[0];
      if (first?.id && !state.chatLoaded[first.id]) loadChat(first.id);
    }
  } catch {
    /* host not running — first-run state renders fine on empty */
  }
}

export async function loadFolders() {
  try {
    const list = await api.get('/folders');
    if (Array.isArray(list)) setState({ folders: list });
  } catch {
    /* host not running / pre-folders server */
  }
}

// A1: the team. Cheap (a directory of small JSON files); refreshed on every
// 'agents-updated' broadcast too.
export async function loadAgents() {
  try {
    const r = await api.get('/agents');
    if (Array.isArray(r?.agents)) setState({ agents: r.agents });
  } catch {
    /* pre-agents host */
  }
}

export async function loadConfig() {
  try {
    const cfg = await api.get('/config');
    setState({ config: cfg || {} });
  } catch {
    setState({ config: null });
  }
}

// Subscription usage (5-hour session + 7-day week windows). Polled server-side
// and pushed via the 'usage-updated' broadcast; this is the initial snapshot.
// Accounts the host can run sessions on (multi-account switching + auto-switch).
// Initial snapshot; kept current via the 'accounts-updated' broadcast.
export async function loadAccounts() {
  try {
    setState({ accounts: await api.get('/accounts') });
  } catch {
    setState({ accounts: { activeId: null, accounts: [] } });
  }
}

// RES1: the per-session health map + the queue of things only a human can
// clear. Cheap (pure computation over live state), and pushed on every change.
export async function loadHealth() {
  try {
    const r = await api.get('/health');
    setState({
      health: Object.fromEntries((r?.sessions || []).map((row) => [row.sessionId, row])),
      waiting: r?.waiting || [],
    });
  } catch {
    /* pre-supervisor host — the rail just shows no dots */
  }
}

export async function loadUsage() {
  try {
    setState({ usage: await api.get('/usage') });
  } catch {
    setState({ usage: { available: false, reason: 'fetch-failed' } });
  }
}

const INITIAL_PAGE = 150;

/* ---------------- full capabilities (lazy) ------------------------------- */
// Session lists (REST + WS) carry claude.capabilities in a slim form
// ({slim:true, model, mcpServers, skills, counts…}) — the full handshake
// (commands/tools/agents/models, ~35KB per session) is fetched here on demand
// from GET /__api/sessions/:id and cached per session until the Claude
// process changes (new claude.sessionId) or the counts move.
function capsRev(session) {
  const c = session?.claude?.capabilities;
  return JSON.stringify([session?.claude?.sessionId, c?.version, c?.counts || null]);
}

export function fullCapabilities(session) {
  const c = session?.claude?.capabilities;
  if (!c?.slim) return c;
  const hit = state.capsFull[session.id];
  return hit && hit.rev === capsRev(session) ? hit.caps : c;
}

const capsInflight = new Set();
export async function ensureFullCapabilities(session) {
  const c = session?.claude?.capabilities;
  if (!c?.slim) return;
  const rev = capsRev(session);
  const hit = state.capsFull[session.id];
  if (hit && hit.rev === rev) return;
  const key = session.id + rev;
  if (capsInflight.has(key)) return;
  capsInflight.add(key);
  try {
    const full = await api.get(`/sessions/${session.id}`);
    const caps = full?.claude?.capabilities;
    if (caps && !caps.slim) setState({ capsFull: { ...state.capsFull, [session.id]: { rev, caps } } });
  } catch {
    /* transient — the slim form still drives the panel counts */
  } finally {
    capsInflight.delete(key);
  }
}

export async function loadChat(sessionId) {
  if (!sessionId || state.chatLoaded[sessionId]) return;
  setState({ chatLoaded: { ...state.chatLoaded, [sessionId]: true } });
  try {
    const res = await api.get(`/sessions/${sessionId}/chat?limit=${INITIAL_PAGE}`);
    const events = Array.isArray(res) ? res : res?.events;
    if (Array.isArray(events)) {
      const live = state.chats[sessionId] || [];
      setState({
        chats: { ...state.chats, [sessionId]: foldSetupUpdates(mergeChatEvents(live, events)) },
        chatHasMore: { ...(state.chatHasMore || {}), [sessionId]: res?.hasMore ?? false },
        chatOldestSeq: { ...(state.chatOldestSeq || {}), [sessionId]: res?.oldestSeq ?? 0 },
      });
    }
  } catch {
    setState({ chatLoaded: { ...state.chatLoaded, [sessionId]: false } });
  }
}

const OLDER_PAGE = 200;

export async function loadOlderChat(sessionId) {
  if (!sessionId) return false;
  const oldest = (state.chatOldestSeq || {})[sessionId];
  if (oldest == null || oldest <= 1) return false;
  try {
    const res = await api.get(`/sessions/${sessionId}/chat?limit=${OLDER_PAGE}&before=${oldest}`);
    const events = Array.isArray(res) ? res : res?.events;
    if (Array.isArray(events) && events.length) {
      const live = state.chats[sessionId] || [];
      setState({
        chats: { ...state.chats, [sessionId]: foldSetupUpdates(mergeChatEvents(events, live)) },
        chatHasMore: { ...(state.chatHasMore || {}), [sessionId]: res?.hasMore ?? false },
        chatOldestSeq: { ...(state.chatOldestSeq || {}), [sessionId]: res?.oldestSeq ?? 0 },
      });
      return true;
    }
  } catch {}
  return false;
}

export function chatHasMore(sessionId) {
  return !!(state.chatHasMore || {})[sessionId];
}

// After a WS reconnect, chat events emitted while the socket was down were never
// delivered. Re-pull the full transcript for every already-loaded session and
// merge — the snapshot now includes the gap, and mergeChatEvents dedups.
function refetchLoadedChats() {
  for (const sid of Object.keys(state.chatLoaded)) {
    if (!state.chatLoaded[sid]) continue;
    // Only fetch events newer than what we already have (gap fill)
    const existing = state.chats[sid] || [];
    const lastSeq = existing.length ? existing[existing.length - 1].seq || 0 : 0;
    api
      .get(`/sessions/${sid}/chat?since=${lastSeq}`)
      .then((res) => {
        const events = Array.isArray(res) ? res : res?.events;
        if (Array.isArray(events) && events.length) {
          const live = state.chats[sid] || [];
          setState({ chats: { ...state.chats, [sid]: mergeChatEvents(live, events) } });
        }
      })
      .catch(() => {});
  }
}

export async function answerPermission(sessionId, requestId, behavior, message) {
  await api.post(`/sessions/${sessionId}/permission/answer`, {
    requestId,
    behavior,
    ...(message ? { message } : {}),
  });
  // Mark the inline card answered locally (the request itself isn't echoed back).
  const cur = state.chats[sessionId] || [];
  setState({
    chats: {
      ...state.chats,
      [sessionId]: cur.map((e) =>
        e.kind === 'permission-request' && e.requestId === requestId
          ? { ...e, answered: behavior }
          : e,
      ),
    },
  });
}

/* ---------------- shared desktop (screen) UI state ------------------------ */

// The open (unanswered) screen-request of a session, or null. Prefers the chat
// event (has prompt/hint) and falls back to the server's session-level marker
// for sessions whose chat isn't loaded (rail badges).
export function openScreenRequest(s, sessionId) {
  if (!sessionId) return null;
  const events = s.chats[sessionId];
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'screen-request') return e.answered ? null : e;
    }
  }
  const session = s.sessions.find((x) => x.id === sessionId);
  const marker = session?.claude?.screenRequest;
  return marker?.requestId ? { kind: 'screen-request', ...marker } : null;
}

export function hasOpenScreenRequest(session) {
  return !!session?.claude?.screenRequest?.requestId;
}

// Whether the side panel should be showing for `sessionId` (auto or override).
export function screenPanelOpen(s, sessionId) {
  if (s.screen.panel !== null) return s.screen.panel;
  return !!openScreenRequest(s, sessionId);
}

export function setScreenPanel(open) {
  setState({ screen: { ...state.screen, panel: open } });
}

// `open`: false, or true (plain GLOBAL view — rail icon only, no sessionId
// means the shared :99/5900 desktop), or {sessionId} (a session's own
// machine — side panel "enlarge", no open request), or {sessionId,
// requestId} (Take over, same as {sessionId} plus the request context/
// Done/Cancel footer — see ScreenModal.jsx).
export function setScreenModal(open) {
  const modal = open && typeof open === 'object' ? open : open ? {} : false;
  setState({ screen: { ...state.screen, modal } });
}

// "Take over" on a request_screen card / side panel: the human drives the
// machine in the SAME interactive modal the rail icon opens (ScreenModal),
// not inside the chat. Tell the server so the Watch-mode auto-snapshots
// pause — nothing is recorded while they type (privacy).
export function openScreenTakeover(sessionId, requestId) {
  setState({ screen: { ...state.screen, controlRequestId: requestId, modal: { sessionId, requestId } } });
  api.post(`/sessions/${sessionId}/screen-request/mode`, { requestId, mode: 'control' }).catch(() => {});
}

// Close the takeover modal WITHOUT answering: the request stays open (the
// card is still there, "Take over" reopens it) and snapshots resume.
export function closeScreenTakeover() {
  const m = state.screen.modal;
  setState({ screen: { ...state.screen, controlRequestId: null, modal: false } });
  if (m && m.requestId) {
    api.post(`/sessions/${m.sessionId}/screen-request/mode`, { requestId: m.requestId, mode: 'watch' }).catch(() => {});
  }
}

export const SCREEN_CANCEL_NOTE = 'cancelled by user';

// Cancel the request itself: resolves the tool call with takenOver:false and
// a fixed note so the agent knows the human declined rather than finished.
export function cancelScreenRequest(sessionId, requestId) {
  return answerScreenRequest(sessionId, requestId, SCREEN_CANCEL_NOTE, false);
}

export async function answerScreenRequest(sessionId, requestId, note, takenOver = false) {
  await api.post(`/sessions/${sessionId}/screen-request/answer`, {
    requestId,
    takenOver,
    ...(note ? { note } : {}),
  });
  if (state.screen.controlRequestId === requestId || state.screen.modal?.requestId === requestId) {
    setState({
      screen: {
        ...state.screen,
        controlRequestId: state.screen.controlRequestId === requestId ? null : state.screen.controlRequestId,
        modal: state.screen.modal?.requestId === requestId ? false : state.screen.modal,
      },
    });
  }
  // Mark the inline card answered locally (the request itself isn't echoed
  // back) — this is what tears down the card's live VNC connection.
  const cur = state.chats[sessionId] || [];
  setState({
    chats: {
      ...state.chats,
      [sessionId]: cur.map((e) =>
        e.kind === 'screen-request' && e.requestId === requestId
          ? { ...e, answered: true, note, takenOver }
          : e,
      ),
    },
  });
}

/* ---------------- WebSocket --------------------------------------------- */

let ws = null;
let attempts = 0;
let reconnectTimer = null;
let started = false;
let everConnected = false;

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/__ws`;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(500 * 2 ** Math.min(attempts, 5), 10000);
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  setState({ conn: 'connecting' });
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    setState({ conn: 'down' });
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    const reconnected = everConnected;
    everConnected = true;
    attempts = 0;
    setState({ conn: 'open' });
    loadSessions(); // pick up archived sessions the state replay may omit
    if (!state.config) loadConfig();
    // On a genuine reconnect (not the first open), refill any chat events that
    // were emitted while the socket was down.
    if (reconnected) refetchLoadedChats();
    // RES1: `health` only broadcasts on CHANGE, so a queue that emptied while
    // the socket was down is never re-announced — the rail would keep showing
    // a waiting badge for something already resolved until a full reload.
    if (reconnected) loadHealth();
  };
  ws.onclose = () => {
    setState({ conn: 'down' });
    if (state.auth === null) return; // signed out: Login will reconnect after success
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg && typeof msg.type === 'string') handleEvent(msg);
  };
}

// C1 — who am I? 401 → Login screen; anything else (auth off, cookie, bearer)
// → the normal boot. Called once at start and again after a successful login.
export async function loadAuth() {
  try {
    const me = await fetch('/__api/auth/me', { headers: { accept: 'application/json' } });
    let body = null;
    try { body = await me.json(); } catch { /* ignore */ }
    if (me.status === 401) {
      setState({ auth: null, authInfo: body ? { authMode: body.authMode, hasAdmin: body.hasAdmin, oidc: body.oidc } : null });
      return null;
    }
    if (!me.ok) throw new Error(`HTTP ${me.status}`);
    setState({ auth: body, authInfo: { authMode: body.authMode, hasAdmin: body.hasAdmin, oidc: body.oidc } });
    return body;
  } catch {
    // Host unreachable: leave auth unknown; the ws banner reports "offline".
    setState({ auth: state.auth === undefined ? undefined : state.auth });
    return state.auth ?? null;
  }
}

function bootLoads() {
  loadConfig();
  loadSessions();
  loadFolders();
  loadAgents();
  loadUsage();
  loadAccounts();
  loadHealth();
  connect();
}

// After Login succeeded (pairing or OIDC return): fetch /me, then boot.
export async function afterLogin() {
  const me = await loadAuth();
  if (me) bootLoads();
  return me;
}

export function signOut() {
  setState({ auth: null });
  try { ws?.close(); } catch { /* ignore */ }
}

export async function startStore() {
  if (started) return;
  started = true;
  setUnauthorizedHandler(() => {
    if (state.auth !== null) signOut();
  });
  // Optimistic boot: fire the auth probe AND the boot loads in parallel instead
  // of serialising them (one extra RTT hurt on phones over a tailnet). If the
  // probe comes back 401 the boot fetches 401 too → setUnauthorizedHandler →
  // signOut() → Login takes over; ws.onclose sees auth === null and stays quiet.
  const authP = loadAuth();
  bootLoads();
  const me = await authP;
  if (me === null && state.auth === null) {
    try { ws?.close(); } catch { /* ignore */ }
  }
}

/* ---------------- event routing ------------------------------------------ */

function handleEvent(msg) {
  const { type } = msg;
  const payload = msg.payload !== undefined ? msg.payload : msg;

  // Granular events may be namespaced 'chat:<sessionId>' — or carry sessionId.
  let kind = type;
  let sid = msg.sessionId || msg.session_id || payload?.sessionId || payload?.session_id;
  const colon = type.indexOf(':');
  if (colon > -1) {
    kind = type.slice(0, colon);
    sid = type.slice(colon + 1) || sid;
  }

  switch (kind) {
    case 'onboarding.step':
      setState({ wizardTick: Date.now() });
      break;
    case 'setup.requested':
    case 'setup.completed':
    case 'setup.skipped':
    case 'setup.changed':
    case 'setup':
      setState({ setupTick: Date.now() });
      return;
    case 'state':
      replaceSnapshot(msg.sessions ?? payload?.sessions);
      if (Array.isArray(msg.folders ?? payload?.folders))
        setState({ folders: msg.folders ?? payload.folders });
      if (Array.isArray(msg.listeners ?? payload?.listeners))
        setState({ listeners: msg.listeners ?? payload.listeners });
      if (Array.isArray(msg.triggers ?? payload?.triggers))
        setState({ triggers: msg.triggers ?? payload.triggers });
      if (Array.isArray(msg.pending ?? payload?.pending))
        setState({ pending: msg.pending ?? payload.pending });
      if (msg.queue ?? payload?.queue) setState({ queue: msg.queue ?? payload.queue });
      return;
    case 'triggers':
      if (Array.isArray(msg.triggers ?? payload?.triggers))
        setState({ triggers: msg.triggers ?? payload.triggers });
      return;
    case 'pending':
      if (Array.isArray(msg.pending ?? payload?.pending))
        setState({ pending: msg.pending ?? payload.pending });
      if (msg.queue ?? payload?.queue) setState({ queue: msg.queue ?? payload.queue });
      return;
    case 'listener-updated':
      upsertListener(payload?.listener ?? payload);
      return;
    case 'listener-deleted':
      removeListener(typeof payload === 'string' ? payload : payload?.id);
      return;
    case 'session-created':
    case 'session-updated':
      upsertSession(payload?.session ?? payload);
      return;
    case 'folder-created':
    case 'folder-updated': {
      const folder = payload?.folder ?? payload;
      if (!folder?.id) return;
      const exists = state.folders.some((f) => f.id === folder.id);
      setState({
        folders: exists
          ? state.folders.map((f) => (f.id === folder.id ? { ...f, ...folder } : f))
          : [...state.folders, folder],
      });
      return;
    }
    case 'folder-deleted': {
      const id = typeof payload === 'string' ? payload : payload?.id;
      setState({ folders: state.folders.filter((f) => f.id !== id) });
      return;
    }
    case 'folders-updated':
      if (Array.isArray(msg.folders ?? payload?.folders))
        setState({ folders: msg.folders ?? payload.folders });
      return;
    case 'agents-updated':
      if (Array.isArray(msg.agents ?? payload?.agents)) setState({ agents: msg.agents ?? payload.agents });
      else loadAgents();
      return;
    case 'session-deleted': {
      const id =
        typeof payload === 'string' ? payload : payload?.id ?? payload?.sessionId ?? sid;
      removeSession(id);
      return;
    }
    case 'tab-created':
    case 'tab-updated':
    case 'tab-deleted':
    case 'tab-activated':
    case 'tab-closed':
      handleTabEvent(kind, payload, sid);
      return;
    case 'chat':
      appendChat(sid, payload?.event ?? payload);
      return;
    case 'permission-request': {
      const req = payload?.request ?? payload ?? {};
      appendChat(sid, { kind: 'permission-request', ts: Date.now(), ...req });
      return;
    }
    case 'action': {
      const action =
        payload && payload.action !== undefined
          ? payload.action
          : payload && (payload.prompt || payload.buttons)
            ? payload
            : null;
      patchSession(sid, { action });
      return;
    }
    case 'usage-updated':
      setState({ usage: msg.usage ?? payload?.usage ?? null });
      return;
    case 'accounts-updated':
      setState({ accounts: msg.accounts ?? payload?.accounts ?? null });
      return;
    case 'account-usage': {
      const accountId = msg.accountId ?? payload?.accountId;
      if (accountId)
        setState({ accountUsage: { ...state.accountUsage, [accountId]: msg.usage ?? payload?.usage ?? null } });
      return;
    }
    case 'progress': {
      const progress =
        payload && payload.progress !== undefined
          ? payload.progress
          : payload && payload.steps
            ? payload
            : null;
      patchSession(sid, { progress });
      return;
    }
    case 'health': {
      // RES1: one event carries both the map and the queue, and only fires when
      // something the cockpit renders actually changed.
      const rows = msg.health ?? payload?.health;
      if (Array.isArray(rows)) setState({ health: Object.fromEntries(rows.map((r) => [r.sessionId, r])) });
      const w = msg.waiting ?? payload?.waiting;
      if (Array.isArray(w)) setState({ waiting: w });
      return;
    }
    case 'host': {
      // host-control.ts lifecycle events (restart/upgrade). Keep the latest one
      // in state.hostEvent for the Settings card; a restart also flips the
      // connection banner via ws.onclose shortly after.
      const ev = payload?.event || payload;
      if (ev?.kind) setState({ hostEvent: { ...ev, at: Date.now() } });
      // UPD1: the `claude` CLI updater's outcome — one line, wherever you are.
      if (ev?.kind === 'claude-update-done') toast(t('host.cli.updatedToast', { from: ev.from || '?', to: ev.to || '?' }));
      else if (ev?.kind === 'claude-update-failed') toastError(t('host.cli.failedToast', { error: ev.error || '?' }));
      return;
    }
    default:
      // Unknown event carrying a full session? Merge it. Otherwise ignore.
      if (payload && payload.id && Array.isArray(payload.tabs)) upsertSession(payload);
  }
}

function handleTabEvent(kind, payload, sid) {
  const p = payload || {};
  if (p.id && Array.isArray(p.tabs)) {
    upsertSession(p); // server echoed the whole session
    return;
  }
  if (p.session?.id && Array.isArray(p.session.tabs)) {
    // {sessionId, tab, session} shape — the embedded session is authoritative
    // (it also carries activeTabId, which the granular merge below would drop).
    upsertSession(p.session);
    return;
  }
  const sessionId = sid || p.sessionId || p.session_id;
  if (!sessionId) {
    loadSessions();
    return;
  }
  patchSession(sessionId, (s) => {
    let tabs = s.tabs || [];
    const tab = p.tab || (p.type && p.id ? p : null);
    if (kind === 'tab-created' && tab) {
      tabs = tabs.some((t) => t.id === tab.id)
        ? tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...tabs, tab];
    } else if (kind === 'tab-updated' && tab) {
      tabs = tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t));
    } else if (kind === 'tab-deleted' || kind === 'tab-closed') {
      const tid = p.tabId || p.tab_id || tab?.id;
      tabs = tabs.filter((t) => t.id !== tid);
      const next = { ...s, tabs };
      if (s.activeTabId === tid) next.activeTabId = tabs[0]?.id;
      return next;
    } else if (kind === 'tab-activated') {
      return { ...s, activeTabId: p.tabId || p.tab_id || tab?.id || s.activeTabId };
    }
    return { ...s, tabs };
  });
}
