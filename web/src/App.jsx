import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api.js';
import { useStore, loadChat, setAttentionHandler, needsAttention, interruptSession, restartSession, getState, screenPanelOpen, closeScreenTakeover } from './lib/store.js';
import { usePrefs, setPrefs, getPrefs, setTermOverride } from './lib/prefs.js';
import { useIsDesktop } from './lib/useMedia.js';
import { isVncInputTarget } from './lib/useScreenConnection.js';
import { stopRecording, hotkeyPress, composerFocused, matchesHotkey, setSelectedContext } from './lib/voice.js';
import { setCommandHandlers } from './lib/commands.js';
import { useT } from './lib/i18n.js';
import { Icon } from './lib/icons.js';
import {
  faBars,
  faBoxArchive,
  faBrain,
  faCircleHalfStroke,
  faCircleUser,
  faGear,
  faHouse,
  faPen,
  faPlus,
  faPlusMinus,
  faPuzzlePiece,
  faQuestion,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import Rail from './components/Rail.jsx';
import SessionView, { resolveTabs, CHANGES_TAB_ID } from './components/SessionView.jsx';
import ScreenSidePanel from './components/ScreenSidePanel.jsx';
import ScreenModal from './components/ScreenModal.jsx';
import Launcher, { buildTicketPayload } from './components/Launcher.jsx';
import FirstRun from './components/FirstRun.jsx';
import Settings from './components/Settings.jsx';
import { parseHash, parseLocation, routeFromState, sessionFromSearch } from './lib/route.js';
import SkillsView from './components/SkillsView.jsx';
import BrainView from './components/BrainView.jsx';
import AgentView from './components/AgentView.jsx';
import Setup from './components/Setup.jsx';
import Wizard from './components/Wizard.jsx';
import VoiceHUD from './components/VoiceHUD.jsx';
import QuickSwitcher from './components/QuickSwitcher.jsx';
import ShortcutsHelp from './components/ShortcutsHelp.jsx';
import Toaster from './components/Toaster.jsx';
import Login from './components/Login.jsx';
import ConfirmHost from './components/ConfirmHost.jsx';
import { ArchiveDialog, DeleteDialog, EditSessionDialog } from './components/Dialogs.jsx';

// matchesHotkey (the "Cmd+Shift+V" parser) lives in lib/voice.js (VOICE2).

// Next unused "scratch-N" name for an instant empty session.
function scratchName(sessions) {
  const n = (sessions || []).filter((s) => /^scratch-\d+$/.test(s.title || '')).length;
  return `scratch-${n + 1}`;
}

// ---- URL routing lives in lib/route.js (parseHash / parseLocation / routeFromState).

// The session-type tab's id (where the chat/terminal lives) for a session.
function sessionTabId(session) {
  const tabs = resolveTabs(session);
  return (tabs.find((t) => t.type === 'session') || tabs[0])?.id || '__session';
}

// Short, gentle WebAudio beep — fired when a session starts needing attention
// while it's not focused/selected. Reuses one shared AudioContext.
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  } catch {
    /* audio may be blocked until first interaction — ignore */
  }
}

function isTyping(e) {
  const el = e.target;
  const tag = el?.tagName;
  // Also true while the user is driving the shared VNC canvas in Control
  // mode — otherwise global hotkeys ("/", "?", Esc-to-interrupt, the voice
  // hotkey…) hijack keystrokes meant for the remote machine, since a
  // <canvas> is neither an input nor contentEditable.
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable || isVncInputTarget(el);
}

// Full-pane preview of a pending (not-yet-a-session) ticket — the same
// /__ticket/<id> host page a ticket session opens as a tab, shown standalone
// since there's no session yet. "Start session" promotes it via the queue.
function TicketPreview({ ticket, fallbackTitle, onClose, onStart }) {
  const t = useT();
  // The pending item already carries a title from trigger time — pass it
  // through so the card can show *something* if the live Linear fetch fails
  // (e.g. no API key configured, or the ticket was never cached) instead of
  // a bare "isn't loaded".
  const src = fallbackTitle
    ? `/__ticket/${ticket}?title=${encodeURIComponent(fallbackTitle)}`
    : `/__ticket/${ticket}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg text-fg">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hair px-4">
        <span className="font-mono text-[12.5px] font-bold">{ticket}</span>
        <span className="rounded-[5px] border border-border px-[7px] py-px text-[10px] text-fgdim">
          {t('chrome.ticket.pending')}
        </span>
        <button
          type="button"
          onClick={onStart}
          className="ml-auto cursor-pointer rounded-[8px] border-[1.5px] border-ink bg-brand px-3 py-1 text-[11.5px] font-bold text-fg"
        >
          {t('chrome.ticket.startSession')}
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('chrome.ticket.closePreview')}
          className="cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"
        >
          ×
        </button>
      </div>
      <iframe
        title={t('chrome.ticket.iframeTitle', { id: ticket })}
        src={src}
        className="min-h-0 flex-1 border-0"
      />
    </div>
  );
}

// C1: signed out → the Login page replaces the whole cockpit (the store
// doesn't boot / connect until afterLogin()). undefined = still checking.
// The switch lives in its own component so the cockpit's hooks never change
// count between renders (auth flipping undefined → null mid-mount used to throw
// React #300 "rendered fewer hooks" and blank the page).
export default function App() {
  const storeState = useStore();
  if (storeState.auth === null) return <Login info={storeState.authInfo} />;
  return <Cockpit />;
}

function Cockpit() {
  const t = useT();
  const storeState = useStore();
  // C1: signed out → the Login page replaces the whole cockpit (the store
  // doesn't boot / connect until afterLogin()). undefined = still checking.
  // NOTE: this can't be an early `return` here — every hook below still has
  // to run on every render (Rules of Hooks), so the branch happens at the
  // bottom, right before the final JSX return.
  const { sessions, chats, chatLoaded, conn, config, pending } = storeState;
  const prefs = usePrefs();
  // Seed each view flag from the URL hash so a deep link / refresh lands on the
  // right page. The two sync effects below keep hash ↔ state aligned thereafter.
  // B11: the host's `/__host/?session=<id>` links resolve like `#/session/<id>`.
  const initial = parseLocation(window.location);
  const [selectedId, setSelectedId] = useState(initial.view === 'session' ? initial.id : null);
  const [launcher, setLauncher] = useState(initial.view === 'launcher' ? { mode: initial.mode } : null); // null | {mode:'ticket'|'empty'|'trigger'}
  const [previewTicket, setPreviewTicket] = useState(initial.view === 'ticket' ? initial.id : null); // ticket id shown full-pane (pending preview)
  const [settingsOpen, setSettingsOpen] = useState(initial.view === 'settings');
  const [settingsCat, setSettingsCat] = useState(initial.view === 'settings' ? initial.cat : 'appearance');
  const [settingsSection, setSettingsSection] = useState(initial.view === 'settings' ? initial.section || '' : '');
  const [settingsAdd, setSettingsAdd] = useState(initial.view === 'settings' && !!initial.add); // open the add-Claude-account form
  const [skillsOpen, setSkillsOpen] = useState(initial.view === 'skills');
  const [brainOpen, setBrainOpen] = useState(initial.view === 'brain');
  const [agentOpen, setAgentOpen] = useState(initial.view === 'agent' ? initial.slug : null); // A1: #/agents/<slug>
  const [agentTab, setAgentTab] = useState(initial.view === 'agent' ? initial.tab || 'home' : 'home'); // UX1: which tab of the agent surface
  const [agentDraftName, setAgentDraftName] = useState(''); // UX2: prefill for the create-mode surface (#/agents/__new__)
  const [setupOpen, setSetupOpen] = useState(initial.view === 'setup');
  // B3: first-run wizard. null = not decided yet (we ask the host once after
  // login); true = show it full-pane; false = dismissed / done for this tab.
  const [wizardOpen, setWizardOpen] = useState(initial.wizard ? true : null);
  useEffect(() => {
    if (wizardOpen !== null || !storeState.auth) return; // only once signed in (a 401 here would sign us out)
    if (sessionStorage.getItem('arigami.wizardDismissed')) { setWizardOpen(false); return; }
    api.get('/onboarding/wizard').then((v) => {
      if (v?.done) { setWizardOpen(false); return; }
      // F8: minimal mode (the default) never opens the 8-step wizard — the
      // front door is the Setup screen's "Connect Claude → Start" hero.
      if (v?.mode !== 'full') { setWizardOpen(false); setSetupOpen(true); return; }
      setWizardOpen(true);
    }).catch(() => setWizardOpen(false));
  }, [wizardOpen, storeState.auth]);
  // F8: "Start" from the wizard/hero — one session in the empty workspace, then straight into it.
  const startFirstSession = async () => {
    const s = await api.post('/sessions', { title: t('setup.minimal.sessionTitle'), permissionMode: 'bypassPermissions' });
    sessionStorage.setItem('arigami.wizardDismissed', '1');
    setWizardOpen(false);
    setSetupOpen(false);
    onCreated(s);
  };
  const closeWizard = () => { sessionStorage.setItem('arigami.wizardDismissed', '1'); setWizardOpen(false); };
  const [dialog, setDialog] = useState(null); // null | {type:'archive'|'delete', session}
  const [addTabOpen, setAddTabOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false); // mobile drawer
  // B27: any navigation (row tap, hash change, deep link, ⌘K) closes the drawer.
  useEffect(() => { setRailOpen(false); }, [selectedId, settingsOpen, skillsOpen, brainOpen, agentOpen, setupOpen, launcher, previewTicket]);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchRef = useRef(null);
  const isDesktop = useIsDesktop();

  // Order matches the rail's flat list (drag-to-reorder sets sortOrder), so
  // ⌘1–9, ⌘⇧↑/↓ prev-next, and the quick switcher all follow the visual d&d
  // order — new/unordered sessions sink to the end, keeping insertion order.
  // UX1: an agent's home chat is not a row in that list (it is the בית tab of
  // the agent surface), so it is not part of this order either — and, crucially,
  // is never what the auto-selection below lands on.
  const active = sessions
    .filter((s) => !s.archived && !s.metadata?.agentHome)
    .sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9));
  const selected = sessions.find((s) => s.id === selectedId) || null;

  // Apply a parsed route to the view flags (one active, others cleared).
  const applyRoute = (r) => {
    setSettingsOpen(r.view === 'settings');
    if (r.view === 'settings') { setSettingsCat(r.cat); setSettingsSection(r.section || ''); setSettingsAdd(!!r.add); }
    setSkillsOpen(r.view === 'skills');
    setBrainOpen(r.view === 'brain');
    setAgentOpen(r.view === 'agent' ? r.slug : null);
    if (r.view === 'agent') setAgentTab(r.tab || 'home');
    setSetupOpen(r.view === 'setup');
    setLauncher(r.view === 'launcher' ? { mode: r.mode } : null);
    setPreviewTicket(r.view === 'ticket' ? r.id : null);
    if (r.view === 'session') setSelectedId(r.id);
    else if (r.view === 'home') setSelectedId(null);
  };

  // Open Settings on a category (and optionally scroll to a section).
  const openSettings = (cat = 'appearance', section = '', add = false) => {
    setSettingsCat(cat); setSettingsSection(section); setSettingsAdd(add);
    setSettingsOpen(true); setSkillsOpen(false); setBrainOpen(false); setAgentOpen(null); setSetupOpen(false); setLauncher(null); setRailOpen(false);
  };

  // URL ↔ state sync, with real browser history.
  //   state→hash: pushState so Back/Forward step through the pages — EXCEPT the
  //   first sync and any transition out of bare home (`#/`), which are
  //   normalizations (e.g. auto-selecting the first session on load) and use
  //   replaceState so they don't leave a dead `#/` entry you'd bounce off of.
  //   hash→state: a hashchange (Back/Forward, edited URL, a shared link) applies
  //   to state. Our own pushState/replaceState never fire hashchange, so no loop.
  const firstSync = useRef(true);
  const lastRoute = useRef(routeFromState({ settingsOpen, settingsCat, settingsSection, skillsOpen, brainOpen, agentOpen, agentTab, setupOpen, launcher, previewTicket, selectedId }));
  useEffect(() => {
    const want = routeFromState({ settingsOpen, settingsCat, settingsSection, skillsOpen, brainOpen, agentOpen, agentTab, setupOpen, launcher, previewTicket, selectedId });
    const cur = '#' + (window.location.hash.replace(/^#/, '') || '/');
    // `#/session/<id>/tab/<tabId>` is SessionView's refinement of our
    // `#/session/<id>` — leave it alone so the active tab survives a refresh.
    const isTabRefinement = want.startsWith('#/session/') && cur.startsWith(`${want}/tab/`);
    if (cur !== want && !isTabRefinement) {
      const replace = firstSync.current || lastRoute.current === '#/';
      // B11: a `?session=<id>` deep link is rewritten to its canonical hash form
      // on the first sync — keeping the query would leave a stale id in the
      // address bar that wins again on the next refresh with a bare hash.
      const url = firstSync.current && sessionFromSearch(window.location.search) ? window.location.pathname + want : want;
      try {
        window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
      } catch {
        window.location.hash = want;
      }
    }
    firstSync.current = false;
    lastRoute.current = want;
  }, [settingsOpen, settingsCat, settingsSection, settingsAdd, skillsOpen, brainOpen, agentOpen, agentTab, setupOpen, launcher, previewTicket, selectedId]);

  useEffect(() => {
    const onHash = () => {
      lastRoute.current = '#' + (window.location.hash.replace(/^#/, '') || '/');
      applyRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep a valid selection. Guard the reset with `sessions.length` so a
  // deep-linked #/session/<id> isn't nulled during the initial empty phase
  // before the sessions list has loaded.
  useEffect(() => {
    if (selectedId && sessions.length && !sessions.some((s) => s.id === selectedId)) setSelectedId(null);
    if (!selectedId && active.length > 0) setSelectedId(active[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, selectedId]);

  // rehydrate chat history for the selected session
  useEffect(() => {
    if (selected?.id) loadChat(selected.id);
  }, [selected?.id]);

  // keep the dialog's session object fresh (WS may patch it)
  const dialogSession = dialog
    ? sessions.find((s) => s.id === dialog.session.id) || dialog.session
    : null;

  // Question beep + title badge: beep ONCE per (clean→attention) transition when
  // the session is unfocused/unselected or the page is hidden. Store fires the
  // handler exactly once per transition, so no double-beeping here.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    setAttentionHandler((s) => {
      const unfocused = s.id !== selectedRef.current || document.hidden;
      if (unfocused) beep();
    });
    return () => setAttentionHandler(null);
  }, []);

  // Title badge: show "(?)" while any UNSELECTED session needs attention.
  const anyOtherNeedsAttention = sessions.some(
    (s) => needsAttention(s) && s.id !== selectedId,
  );
  useEffect(() => {
    const base = 'Arigami';
    document.title = anyOtherNeedsAttention ? `(?) ${base}` : base;
  }, [anyOtherNeedsAttention]);

  // Tell the voice router which session is current (for context + inject target).
  useEffect(() => {
    setSelectedContext(selectedId);
  }, [selectedId]);

  // Auto-compact is now a real `claude --autocompact <tokens>` spawn flag
  // (server/claude.js setAutoCompact), applied per-session from the context
  // modal — the CLI enforces it natively, so no client-side polling needed.

  // ---- command bus: the single action surface voice control drives ----------
  // Handlers are registered ONCE but read fresh state/setters from this ref, so
  // a voice plan built minutes ago still acts on the live app. Action types and
  // args mirror server/voice.js COMMANDS exactly.
  const cmd = useRef({});
  cmd.current = {
    sessions, active, selectedId, config,
    setSelectedId, setLauncher, setSettingsOpen, setDialog, setAddTabOpen,
    setQuickSwitcherOpen, setShortcutsOpen, searchRef,
  };
  useEffect(() => {
    const C = () => cmd.current;
    const resolveId = (a) => a?.sessionId || C().selectedId;
    const findSession = (id) => C().sessions.find((s) => s.id === id);
    // Switch to a session, then drive its (only-when-mounted) SessionView to a
    // tab via a window event SessionView listens for. Cross-session needs a tick
    // for the new SessionView to mount before it can hear the event.
    const goToTab = (sessionId, tabId) => {
      const id = sessionId || C().selectedId;
      if (!id) return;
      const dispatch = () => window.dispatchEvent(new CustomEvent('host:activate-tab', { detail: { sessionId: id, tabId } }));
      if (id !== C().selectedId) {
        C().setSelectedId(id);
        C().setLauncher(null);
        C().setSettingsOpen(false);
        setTimeout(dispatch, 60);
      } else {
        dispatch();
      }
    };
    const closeOverlays = () => {
      C().setLauncher(null);
      C().setSettingsOpen(false);
      C().setDialog(null);
      C().setAddTabOpen(false);
      C().setQuickSwitcherOpen(false);
      C().setShortcutsOpen(false);
    };

    setCommandHandlers({
      select_session: (a, ctx) => {
        const s = findSession(a.sessionId);
        if (!s) return;
        C().setSelectedId(s.id); C().setLauncher(null); C().setSettingsOpen(false);
        ctx.targetSessionId = s.id;
      },
      next_session: () => {
        const list = C().active; if (!list.length) return;
        const i = list.findIndex((s) => s.id === C().selectedId);
        C().setSelectedId(list[(i + 1 + list.length) % list.length].id);
      },
      prev_session: () => {
        const list = C().active; if (!list.length) return;
        const i = list.findIndex((s) => s.id === C().selectedId);
        C().setSelectedId(list[(i - 1 + list.length) % list.length].id);
      },
      new_session: async (a, ctx) => {
        const cfg = C().config;
        const s = await api.post('/sessions', {
          title: scratchName(C().sessions),
          cwd: cfg?.reposDir || cfg?.defaultCwd || undefined,
        }).catch(() => null);
        if (s?.id) { C().setSelectedId(s.id); C().setLauncher(null); ctx.targetSessionId = s.id; }
      },
      open_launcher: () => { C().setLauncher({ mode: 'ticket' }); },
      open_terminal: (a) => {
        const s = findSession(resolveId(a)); if (!s) return;
        goToTab(s.id, sessionTabId(s));
      },
      open_changes: (a) => { goToTab(resolveId(a), CHANGES_TAB_ID); },
      activate_tab: (a) => { if (a.tabId) goToTab(resolveId(a), a.tabId); },
      open_tab: async (a) => {
        const id = resolveId(a); if (!id || !a.url) return;
        await api.post(`/sessions/${id}/tabs`, { type: 'url', url: a.url, title: a.title || a.url }).catch(() => {});
      },
      reload_tab: () => { window.dispatchEvent(new CustomEvent('host:reload-tab', { detail: { sessionId: C().selectedId } })); },
      close_tab: async (a) => {
        const id = resolveId(a); if (!id || !a.tabId) return;
        await api.del(`/sessions/${id}/tabs/${a.tabId}`).catch(() => {});
      },
      rename_session: async (a) => {
        const id = resolveId(a); if (!id || !a.title) return;
        await api.patch(`/sessions/${id}`, { title: a.title }).catch(() => {});
      },
      archive_session: (a) => {
        const s = findSession(resolveId(a)); if (s) C().setDialog({ type: 'archive', session: s });
      },
      delete_session: (a) => {
        const s = findSession(a.sessionId); if (s) C().setDialog({ type: 'delete', session: s });
      },
      restore_session: async (a) => {
        if (a.sessionId) await api.patch(`/sessions/${a.sessionId}`, { archived: false }).catch(() => {});
      },
      focus_input: () => { window.dispatchEvent(new CustomEvent('host:focus-input')); },
      set_theme: (a) => {
        const cur = getPrefs().theme;
        const mode = a.mode === 'toggle' ? (cur === 'dark' ? 'light' : 'dark') : a.mode;
        if (mode === 'light' || mode === 'dark') setPrefs({ theme: mode });
      },
      set_terminal: (a) => {
        const id = resolveId(a); if (!id) return;
        const patch = {};
        if (['light', 'dark'].includes(a.theme)) patch.theme = a.theme;
        if (['auto', 'ltr', 'rtl'].includes(a.dir)) patch.dir = a.dir;
        if (Object.keys(patch).length) setTermOverride(id, patch);
      },
      open_settings: () => { C().setSettingsOpen(true); C().setLauncher(null); },
      dismiss: () => { closeOverlays(); },
      interrupt: async (a) => {
        const id = resolveId(a); if (id) await interruptSession(id);
      },
      inject_prompt: async (a, ctx) => {
        const id = a.sessionId || ctx?.targetSessionId || C().selectedId;
        const text = (a.text || '').trim();
        if (!id || !text) return;
        await api.post(`/sessions/${id}/message`, { text }).catch(() => {});
      },
      clarify: () => {}, // control words — stripped by the router before they reach the bus (VOICE2)
      ask: () => {},
      end_conversation: () => {},
    });
    return () => setCommandHandlers({});
  }, []);

  // keyboard: '/' search, cmd+1..9 sessions, cmd+t tab popover, esc closes
  const keyCtx = useRef({});
  keyCtx.current = { active, dialog, launcher, selected, settingsOpen, addTabOpen, railOpen, sessionCount: sessions.length };
  const pttActive = useRef(false); // push-to-talk: recording while the hotkey is held
  useEffect(() => {
    const onKey = (e) => {
      const ctx = keyCtx.current;
      if (e.key === 'Escape') {
        // B27: the mobile drawer is the top-most thing when open.
        if (ctx.railOpen) { e.preventDefault(); setRailOpen(false); return; }
        // dialogs/popovers/settings handle their own esc via capture listeners.
        // Esc-to-interrupt: only when there's nothing to close AND the selected
        // session is working AND the user isn't typing in an input.
        const nothingOpen =
          !ctx.dialog && !ctx.launcher && !ctx.settingsOpen && !ctx.addTabOpen;
        if (nothingOpen && !isTyping(e) && ctx.selected?.claude?.state === 'working') {
          e.preventDefault();
          interruptSession(ctx.selected.id);
          return;
        }
        // Match the ✕ button's predicate (any session, incl. archived) so Esc
        // can always close the launcher whenever the ✕ is shown.
        if (!ctx.dialog && ctx.launcher && ctx.sessionCount > 0) setLauncher(null);
        return;
      }
      if (e.key === '/' && !isTyping(e) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Quick switcher: Cmd+K
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !isTyping(e)) {
        e.preventDefault();
        setQuickSwitcherOpen(true);
        return;
      }
      // Shortcuts help: ? (Shift+/)
      if (e.shiftKey && e.key === '?' && !isTyping(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // Voice control: user-configurable hotkey (default Cmd/Ctrl+Shift+V).
      // 'hold' = push-to-talk (record while held); 'toggle' = press to start/stop.
      // VOICE2: it works everywhere — in the chat composer it dictates into
      // the message, anywhere else it drives the command HUD (lib/voice.js
      // hotkeyAction). Only a bare key (no modifier) typed into some OTHER
      // field is left alone, so a single-letter shortcut can't eat a search.
      if (matchesHotkey(e, getPrefs().voiceHotkey)) {
        const inComposer = composerFocused(e.target);
        const chord = e.metaKey || e.ctrlKey || e.altKey;
        if (!isTyping(e) || inComposer || chord) {
          e.preventDefault();
          if (getPrefs().voiceMode === 'hold') {
            if (!e.repeat && !pttActive.current) { pttActive.current = true; hotkeyPress({ hold: true, composer: inComposer }); }
          } else {
            hotkeyPress({ composer: inComposer });
          }
          return;
        }
      }
      // Cmd/Ctrl+Shift chords (documented in the cheat-sheet): session nav,
      // new empty session, focus composer.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        const list = ctx.active;
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && list.length) {
          e.preventDefault();
          const i = list.findIndex((s) => s.id === ctx.selected?.id);
          const from = i < 0 ? 0 : i;
          const delta = e.key === 'ArrowUp' ? -1 : 1;
          setSelectedId(list[(from + delta + list.length) % list.length].id);
          setLauncher(null);
          return;
        }
        if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          const cfg = getState().config;
          api
            .post('/sessions', {
              title: scratchName(getState().sessions),
              cwd: cfg?.reposDir || cfg?.defaultCwd || undefined,
            })
            .then((s) => {
              if (s?.id) {
                setSelectedId(s.id);
                setLauncher(null);
              }
            })
            .catch(() => {});
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('host:focus-input'));
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (e.key >= '1' && e.key <= '9') {
          const idx = Number(e.key) - 1;
          const target = ctx.active[idx];
          if (target) {
            e.preventDefault();
            setSelectedId(target.id);
            setLauncher(null);
          }
          return;
        }
        if (e.key === 't' && ctx.selected && !ctx.launcher) {
          e.preventDefault();
          setAddTabOpen((v) => !v);
        }
      }
    };
    // Push-to-talk release: while a hold-recording is active, releasing any part
    // of the chord (the key or a modifier) ends the take and sends it.
    const onKeyUp = () => {
      if (pttActive.current) { pttActive.current = false; stopRecording(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Jump to a session from anywhere (e.g. the Orchestration tab clicking a worker).
  useEffect(() => {
    const onJump = (e) => {
      const id = e.detail?.id;
      if (id && sessions.some((s) => s.id === id)) {
        setSelectedId(id);
        setLauncher(null);
        setSettingsOpen(false);
        setSkillsOpen(false);
        setBrainOpen(false);
        setSetupOpen(false);
      }
    };
    window.addEventListener('host:select-session', onJump);
    return () => window.removeEventListener('host:select-session', onJump);
  }, [sessions]);

  // UX1: the home chat is the agent surface's בית tab, not a session page. Any
  // route that lands on one (a deep link, the quick switcher, a push, an older
  // bookmark) is bounced to the surface — the transcript is the same, the frame
  // is the one that says "this is a DM with the agent, not a job".
  useEffect(() => {
    if (!selectedId) return;
    const s = sessions.find((x) => x.id === selectedId);
    if (!s?.metadata?.agentHome || !s.metadata?.agent) return;
    setSelectedId(null);
    setAgentOpen(s.metadata.agent);
    setAgentTab('home');
    setSettingsOpen(false); setSkillsOpen(false); setBrainOpen(false); setSetupOpen(false); setLauncher(null); setPreviewTicket(null);
  }, [selectedId, sessions]);

  // A4: open an agent page from anywhere (the /team panel).
  // UX1: `tab` picks the surface's tab — a "פתח בית" receipt opens the DM.
  useEffect(() => {
    const onOpen = (e) => {
      const slug = e.detail?.slug;
      if (!slug) return;
      setAgentOpen(slug); setAgentTab(e.detail?.tab || 'home');
      setAgentDraftName(e.detail?.draftName || '');
      setSelectedId(null);
      setSettingsOpen(false); setSkillsOpen(false); setBrainOpen(false); setSetupOpen(false); setLauncher(null); setRailOpen(false);
    };
    window.addEventListener('host:open-agent', onOpen);
    return () => window.removeEventListener('host:open-agent', onOpen);
  }, []);

  // UX4: an agent was deleted (rail Team menu or the surface's own header) —
  // if its surface happens to be open, it just went missing from under the
  // user, so close it (AgentView.jsx has its own onDeleted → onClose for the
  // case where the delete happened from inside the surface itself; this
  // covers the rail, which has no reference to the surface to close it with).
  useEffect(() => {
    const onDeleted = (e) => {
      if (e.detail?.slug && agentOpen === e.detail.slug) setAgentOpen(null);
    };
    window.addEventListener('host:agent-deleted', onDeleted);
    return () => window.removeEventListener('host:agent-deleted', onDeleted);
  }, [agentOpen]);

  // Push notification click → navigate to the right session and scroll to event.
  useEffect(() => {
    const onMessage = (e) => {
      if (e.data?.type === 'navigate-session' && e.data.sessionId) {
        setSelectedId(e.data.sessionId);
        setSettingsOpen(false);
        setSkillsOpen(false);
        setBrainOpen(false);
        setSetupOpen(false);
        const eventId = e.data.eventId;
        // Wait for React to render, then scroll to the target event or bottom
        const tryScroll = (attempt = 0) => {
          requestAnimationFrame(() => {
            if (eventId) {
              const target = document.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
              if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.style.outline = '2px solid var(--color-brand, #12A594)';
                setTimeout(() => { target.style.outline = ''; }, 2000);
                return;
              }
            }
            // Fallback: scroll to bottom
            const el = document.querySelector('.term.thin-scroll');
            if (el) el.scrollTop = el.scrollHeight;
            else if (attempt < 5) setTimeout(() => tryScroll(attempt + 1), 200);
          });
        };
        tryScroll();
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);

  // Open the rail drawer from anywhere (e.g. the TabBar's mobile hamburger —
  // the session view has no top bar of its own, the tab bar hosts the button).
  useEffect(() => {
    const onOpen = () => setRailOpen(true);
    window.addEventListener('host:open-rail', onOpen);
    return () => window.removeEventListener('host:open-rail', onOpen);
  }, []);

  // Open the Accounts page from anywhere (e.g. the /mcp panel's Authenticate…).
  useEffect(() => {
    const onOpen = (e) => openSettings('connections', 'claude', !!e.detail?.add);
    window.addEventListener('host:open-accounts', onOpen);
    return () => window.removeEventListener('host:open-accounts', onOpen);
  }, []);

  const onCreated = (session) => {
    if (session?.id) setSelectedId(session.id);
    setLauncher(null);
  };

  // ⌘K command-palette actions — everything reachable keyboard-only. Building
  // fresh each render is cheap and keeps `selected` current.
  const goToChanges = () => {
    if (!selected) return;
    setSelectedId(selected.id);
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent('host:activate-tab', { detail: { sessionId: selected.id, tabId: CHANGES_TAB_ID } })),
    );
  };
  const paletteActions = [
    { id: 'new-empty', label: t('chrome.palette.newEmpty'), keywords: t('chrome.palette.newEmpty.kw'), icon: faPlus, run: () => {
      const cfg = getState().config;
      api.post('/sessions', { title: scratchName(getState().sessions), cwd: cfg?.reposDir || cfg?.defaultCwd || undefined })
        .then((s) => { if (s?.id) { setSelectedId(s.id); setLauncher(null); } }).catch(() => {});
    } },
    { id: 'new-ticket', label: t('chrome.palette.newTicket'), keywords: t('chrome.palette.newTicket.kw'), icon: faPlus, run: () => setLauncher({ mode: 'ticket' }) },
    { id: 'settings', label: t('chrome.palette.settings'), keywords: t('chrome.palette.settings.kw'), icon: faGear, run: () => setSettingsOpen(true) },
    { id: 'skills', label: t('chrome.palette.skills'), keywords: t('chrome.palette.skills.kw'), icon: faPuzzlePiece, run: () => setSkillsOpen(true) },
    { id: 'brain', label: t('chrome.palette.brain'), keywords: t('chrome.palette.brain.kw'), icon: faBrain, run: () => setBrainOpen(true) },
    { id: 'accounts', label: t('chrome.palette.accounts'), keywords: t('chrome.palette.accounts.kw'), icon: faCircleUser, run: () => openSettings('connections', 'claude') },
    { id: 'setup', label: t('chrome.palette.setup'), keywords: t('chrome.palette.setup.kw'), icon: faHouse, run: () => setSetupOpen(true) },
    { id: 'shortcuts', label: t('chrome.palette.shortcuts'), keywords: t('chrome.palette.shortcuts.kw'), icon: faQuestion, run: () => setShortcutsOpen(true) },
    { id: 'theme', label: t('chrome.palette.theme'), keywords: t('chrome.palette.theme.kw'), icon: faCircleHalfStroke, run: () => setPrefs({ theme: getPrefs().theme === 'dark' ? 'light' : 'dark' }) },
    ...(selected ? [
      { id: 'changes', label: t('chrome.palette.changes'), keywords: t('chrome.palette.changes.kw'), icon: faPlusMinus, run: goToChanges },
      { id: 'edit', label: t('chrome.palette.edit'), keywords: t('chrome.palette.edit.kw'), icon: faPen, run: () => setDialog({ type: 'edit', session: selected }) },
      { id: 'archive', label: t('chrome.palette.archive'), keywords: t('chrome.palette.archive.kw'), icon: faBoxArchive, run: () => setDialog({ type: 'archive', session: selected }) },
      { id: 'delete', label: t('chrome.palette.delete'), keywords: t('chrome.palette.delete.kw'), icon: faTrash, run: () => setDialog({ type: 'delete', session: selected }) },
    ] : []),
  ];

  // When a session is the main view its TabBar carries the mobile hamburger, so
  // the extra top bar would only duplicate the title — skip it there and keep
  // the pixels for the chat. Every other view still gets it for drawer access.
  const sessionIsMain =
    !!selected && !settingsOpen && !skillsOpen && !brainOpen && !agentOpen && !setupOpen && !launcher && !previewTicket;
  // Top-bar label names the view you're IN, not the session you came from.
  const topBarTitle = settingsOpen
    ? t('settings.title')
    : skillsOpen
      ? t('chrome.topbar.skills')
      : brainOpen
        ? t('chrome.topbar.brain')
        : agentOpen
          ? t('agent.page.title')
        : setupOpen
          ? t('chrome.topbar.setup')
          : launcher
            ? t('chrome.topbar.newSession')
            : previewTicket || selected?.title || 'Arigami';

  let main;
  if (settingsOpen) {
    main = <Settings category={settingsCat} section={settingsSection} initialAdd={settingsAdd} onCategory={(c) => { setSettingsCat(c); setSettingsSection(''); setSettingsAdd(false); }} onClose={() => setSettingsOpen(false)} />;
  } else if (skillsOpen) {
    main = <SkillsView session={selected} onClose={() => setSkillsOpen(false)} />;
  } else if (brainOpen) {
    main = <BrainView onClose={() => setBrainOpen(false)} />;
  } else if (agentOpen) {
    main = (
      <AgentView
        slug={agentOpen}
        tab={agentTab}
        draftName={agentDraftName}
        onTab={setAgentTab}
        onClose={() => setAgentOpen(null)}
        onOpenSession={(id) => { setAgentOpen(null); setSelectedId(id); }}
        // UX2: create mode's POST succeeded — flip the surface into normal
        // (existing-agent) mode for the new slug, still on the פרסונה tab
        // (its own "פתח בית" button is what lazily mints the home chat).
        onCreated={(a) => { setAgentOpen(a.slug); setAgentTab('persona'); setAgentDraftName(''); }}
      />
    );
  } else if (wizardOpen) {
    main = <Wizard onDone={closeWizard} onExit={closeWizard} onStart={startFirstSession} />;
  } else if (setupOpen) {
    main = <Setup onClose={() => setSetupOpen(false)} onCreated={(s) => { onCreated(s); setSetupOpen(false); }} onRunWizard={() => { setSetupOpen(false); sessionStorage.removeItem('arigami.wizardDismissed'); setWizardOpen(true); }} />;
  } else if (launcher) {
    main = (
      <Launcher
        config={config}
        sessions={sessions}
        initialMode={launcher.mode}
        onClose={sessions.length > 0 ? () => setLauncher(null) : null}
        onCreated={onCreated}
        onNeedsSetup={() => { setLauncher(null); setSetupOpen(true); }}
      />
    );
  } else if (previewTicket) {
    const previewItem = (pending || []).find(
      (p) => p.ticket?.toUpperCase() === previewTicket.toUpperCase(),
    );
    main = (
      <TicketPreview
        ticket={previewTicket}
        fallbackTitle={previewItem?.title}
        onClose={() => setPreviewTicket(null)}
        onStart={() => {
          const item = (pending || []).find(
            (p) => p.ticket?.toUpperCase() === previewTicket.toUpperCase(),
          );
          if (item) api.post(`/pending/${item.id}/start`).catch(() => {});
          setPreviewTicket(null);
        }}
      />
    );
  } else if (selected) {
    // archived sessions render the same view (read-only peek; restore via ⋯ menu)
    // The machine side panel docks to the right of the session (desktop only);
    // it auto-opens while this session has an open request_screen, or via the
    // header's 🖥 chip. See ScreenSidePanel.jsx.
    main = (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <SessionView
            session={selected}
            events={chats[selected.id] || []}
            chatLoading={!chatLoaded[selected.id] && !(chats[selected.id]?.length)}
            addTabOpen={addTabOpen}
            setAddTabOpen={setAddTabOpen}
          />
        </div>
        {screenPanelOpen(storeState, selected.id) && <ScreenSidePanel session={selected} />}
      </div>
    );
  } else {
    main = (
      <FirstRun
        config={config}
        sessions={sessions}
        onCreated={onCreated}
        onOpenLauncher={() => setLauncher({ mode: 'empty' })}
      />
    );
  }

  if (storeState.auth === null) return <Login info={storeState.authInfo} />;

  // --app-height, not h-screen: 100vh ignores the mobile keyboard (lib/viewport.js)
  return (
    <div className="flex h-[var(--app-height)] overflow-hidden bg-bg font-sans text-fg">
      {/* mobile drawer backdrop */}
      {railOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setRailOpen(false)}
        />
      )}
      <Rail
        sessions={sessions}
        selectedId={selected?.id}
        agentOpen={agentOpen}
        isDesktop={isDesktop}
        mobileOpen={railOpen}
        onClose={() => setRailOpen(false)}
        onSelect={(id) => {
          setSelectedId(id);
          setLauncher(null);
          setPreviewTicket(null);
          setSettingsOpen(false);
          setSkillsOpen(false);
          setBrainOpen(false);
          setAgentOpen(null);
          setSetupOpen(false);
          setAddTabOpen(false);
          setRailOpen(false);
        }}
        onNew={() => { setLauncher({ mode: 'ticket' }); setPreviewTicket(null); setSkillsOpen(false); setBrainOpen(false); setAgentOpen(null); setSetupOpen(false); setRailOpen(false); }}
        onOpenSettings={() => { setSettingsOpen(true); setSkillsOpen(false); setBrainOpen(false); setAgentOpen(null); setSetupOpen(false); setRailOpen(false); }}
        onOpenSkills={() => { setSkillsOpen(true); setSettingsOpen(false); setBrainOpen(false); setAgentOpen(null); setSetupOpen(false); setRailOpen(false); }}
        onOpenBrain={() => { setBrainOpen(true); setSettingsOpen(false); setSkillsOpen(false); setSetupOpen(false); setRailOpen(false); }}
        onOpenSetup={() => { setSetupOpen(true); setSkillsOpen(false); setBrainOpen(false); setAgentOpen(null); setSettingsOpen(false); setLauncher(null); setRailOpen(false); }}
        onPreviewTicket={(t) => { setPreviewTicket(t); setLauncher(null); setSettingsOpen(false); setSkillsOpen(false); setBrainOpen(false); setAgentOpen(null); setSetupOpen(false); setRailOpen(false); }}
        onOpenTriggers={() => { setLauncher({ mode: 'trigger' }); setPreviewTicket(null); setSettingsOpen(false); setSkillsOpen(false); setBrainOpen(false); setAgentOpen(null); setSetupOpen(false); setRailOpen(false); }}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenAgent={(slug, tab) => { setAgentOpen(slug); setAgentTab(tab || 'home'); setAgentDraftName(''); setSelectedId(null); setSettingsOpen(false); setSkillsOpen(false); setBrainOpen(false); setSetupOpen(false); setLauncher(null); setPreviewTicket(null); setRailOpen(false); }}
        searchRef={searchRef}
        onArchive={(s) => setDialog({ type: 'archive', session: s })}
        onEdit={(s) => setDialog({ type: 'edit', session: s })}
        onRestore={(s) => api.patch(`/sessions/${s.id}`, { archived: false }).catch(() => {})}
        onRestart={restartSession}
        onDelete={(s) => setDialog({ type: 'delete', session: s })}
        config={config}
        conn={conn}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* mobile top bar: hamburger + current view — not shown over a session,
            where the TabBar hosts the hamburger instead */}
        {!sessionIsMain && (
          <div className="flex shrink-0 items-center gap-2.5 border-b border-hair bg-panel px-3 py-2 md:hidden">
            <button
              type="button"
              onClick={() => setRailOpen(true)}
              aria-label={t('chrome.topbar.openSessions')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border-[1.5px] border-border bg-bg text-[15px] text-fg"
            >
              <Icon icon={faBars} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-fg">
              {topBarTitle}
            </span>
          </div>
        )}
        {conn !== 'open' && (
          <div className="absolute top-2 right-3 z-40 rounded-full border border-[#e2c4c0] bg-[#FBECEA] px-2.5 py-1 font-mono text-[10px] text-[#9c3b33]">
            {conn === 'connecting' ? t('chrome.conn.connecting') : t('chrome.conn.offline')}
          </div>
        )}
        {main}
      </main>
      <VoiceHUD />
      {quickSwitcherOpen && (
        <QuickSwitcher
          sessions={active}
          selectedId={selectedId}
          actions={paletteActions}
          onSelect={(id) => {
            setSelectedId(id);
            setQuickSwitcherOpen(false);
          }}
          onClose={() => setQuickSwitcherOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
      {dialog?.type === 'archive' && (
        <ArchiveDialog session={dialogSession} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'edit' && (
        <EditSessionDialog session={dialogSession} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'delete' && (
        <DeleteDialog
          session={dialogSession}
          onClose={() => setDialog(null)}
          onDeleted={(id) => {
            if (selectedId === id) setSelectedId(null);
          }}
        />
      )}
      {/* The one interactive desktop modal — rail icon (global desktop), a
          session's side-panel "enlarge" (that session's own machine), or
          Take over on a request_screen card (same, plus the request
          context). Closing never answers the request. */}
      {storeState.screen.modal && <ScreenModal context={storeState.screen.modal} onClose={closeScreenTakeover} />}
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
