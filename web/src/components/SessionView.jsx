import { useState, useRef, useMemo, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api.js';
import { relTime } from '../lib/time.js';
import { toastError } from '../lib/toast.js';
import { errText } from '../lib/errors.js';
import { useStore, listenersForSession, fullCapabilities, ensureFullCapabilities, getDraft, setDraft, setLastSent, interruptSession, openScreenRequest, screenPanelOpen, setScreenPanel } from '../lib/store.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { HOST_ORIGIN, tabSrc } from '../lib/hostUrl.js';
import { useVoice, toggleRecording } from '../lib/voice.js';
import { HARD_CAP, shouldStream, fileToBase64, uploadAttachment, pendingAttachment, applyUploadEvent, isAlreadyAttached } from '../lib/attachments.js';
import { Dot, TriggerTag } from './ui.jsx';
import { t, useT, dirOf } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faArrowUp, faBoxArchive, faCaretDown, faCaretUp, faCheck, faCircle, faCircleUser, faDisplay, faEye, faFile, faGripVertical, faHourglassHalf, faImage, faListCheck, faMicrophone, faPaperclip, faPlay, faReply, faRotateRight, faStop, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import TabBar from './TabBar.jsx';
import ChatPane from './ChatPane.jsx';
import ChangesTab from './ChangesTab.jsx';
import OrchestrationTab from './OrchestrationTab.jsx';
import { Truncate } from './Truncate.jsx';
import { SlashPalette, CapabilitiesPanel, buildSlashItems, MentionPalette, TeamPanel } from './SlashCommands.jsx';
import { useSkills, skillSlashItems, agentCommandItems, resolveSubmission, mentionQuery, completeMention, buildMentionItems, lastHumanText } from '../lib/composer.js';
import { ProcessChip, BgProcessesPanel } from './BgProcesses.jsx';
import TermControls from './TermControls.jsx';
import { ActionBar } from './ActionCard.jsx';
import { AgentAvatar } from './AgentCard.jsx';
import { openAgent } from './DelegatedLine.jsx';

// Built-in "Changes" tab id — distinguishes it from agent-opened tabs.
export const CHANGES_TAB_ID = '__changes';
// Built-in "Orchestration" tab id — auto-appears on any session that has workers.
export const ORCH_TAB_ID = '__orchestration';

// Resolve the tab list for a session: the base tabs (defaulting to a single
// Session tab) plus a built-in "Changes" tab inserted right after Session —
// UNLESS the agent already opened a tab titled "Changes" (don't duplicate).
// When the session has workers (hasChildren), an "Orchestration" tab follows it.
export function resolveTabs(session, hasChildren = false) {
  const base = session.tabs?.length
    ? session.tabs
    : [{ id: '__session', type: 'session', title: t('rail.tabSession') }];
  const hasChanges = base.some((tb) => tb.type === 'changes' || tb.id === CHANGES_TAB_ID);
  const sessionIdx = base.findIndex((tb) => tb.type === 'session');
  const inserts = [];
  if (!hasChanges)
    inserts.push({ id: CHANGES_TAB_ID, type: 'changes', title: t('rail.tabChanges'), builtIn: true });
  if (hasChildren)
    inserts.push({ id: ORCH_TAB_ID, type: 'orchestration', title: t('rail.tabOrchestration'), builtIn: true });
  if (!inserts.length) return base;
  if (sessionIdx === -1) return [...base, ...inserts];
  return [...base.slice(0, sessionIdx + 1), ...inserts, ...base.slice(sessionIdx + 1)];
}

/* ---------- terminal header strip ---------------------------------------- */

function StatusChip({ session }) {
  const t = useT();
  const cState = session.claude?.state;
  // A restart in flight beats the free-form status — it's the live signal the
  // user is waiting on (upsertSession toasts when it completes).
  const restarting = cState === 'restarting';
  const status = restarting ? t('rail.statusRestartingDots') : session.status || cState || t('rail.statusIdle');
  const awaiting = !restarting && (/review/i.test(session.status || '') || cState === 'awaiting-input');
  const dotColor = awaiting
    ? '#F9D312'
    : cState === 'working'
      ? '#3C9A4E'
      : cState === 'dead'
        ? '#B23B30'
        : '#c4c4c4';
  return (
    <span
      className={`ms-auto flex shrink-0 items-center gap-[7px] rounded-full border-[1.5px] px-[11px] py-[3px] whitespace-nowrap ${
        awaiting ? 'border-ink bg-chip' : 'border-border bg-panel'
      }`}
    >
      {restarting ? (
        <span className="host-spinner h-[9px] w-[9px]" />
      ) : (
        <span
          className={`h-[7px] w-[7px] rounded-full ${awaiting ? 'pulse-yellow' : ''}`}
          style={{ background: dotColor }}
        />
      )}
      <span
        className={`font-mono text-[10.5px] font-bold ${awaiting ? 'text-[#4a3f12]' : restarting ? 'text-[#ce8324]' : 'text-fgdim'}`}
      >
        {String(status).toLowerCase()}
      </span>
    </span>
  );
}

// Which account this session runs on. Reads the session's pinned accountId (or
// the active account if unpinned) so switching accounts is VISIBLE per session —
// otherwise a switch looks like it did nothing.
function AccountChip({ session }) {
  const t = useT();
  const { accounts } = useStore();
  const list = accounts?.accounts || [];
  const pinned = session.claude?.accountId;
  const acc = (pinned && list.find((a) => a.id === pinned)) || list.find((a) => a.active) || null;
  if (!acc) return null;
  const name = acc.email || acc.label || t('rail.accountFallback');
  return (
    <span
      className="hidden items-center gap-1 font-mono text-[10px] text-fgdim sm:flex"
      title={t('rail.runsOn', { name }) + (acc.active ? t('rail.activeAccountSuffix') : '')}
      onClick={() => window.dispatchEvent(new CustomEvent('host:open-accounts'))}
      style={{ cursor: 'pointer' }}
    >
      <span><Icon icon={faCircleUser} /></span>
      <span className="max-w-[90px] truncate sm:max-w-[150px]">{name}</span>
    </span>
  );
}

// Mobile stand-in for the full listeners row: one "👀 N" chip in the terminal
// header that opens the same ListenersPanel. The chips row itself is desktop-only.
function ListenersChipCompact({ session }) {
  const t = useT();
  const store = useStore();
  const listeners = listenersForSession(store, session.id);
  const [open, setOpen] = useState(false);
  if (!listeners.length) return null;
  const errored = listeners.some((l) => l.status === 'errored');
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={listeners.length > 1 ? t('rail.listenersWatching', { n: listeners.length }) : t('rail.listenerWatching', { n: listeners.length })}
        className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] sm:hidden ${
          errored ? 'border-danger/40 bg-danger/10 text-danger' : 'border-hair bg-white text-[#555]'
        }`}
      >
        <span><Icon icon={errored ? faTriangleExclamation : faEye} /></span>
        <span className="font-mono font-bold">{listeners.length}</span>
      </button>
      {open && <ListenersPanel session={session} onClose={() => setOpen(false)} />}
    </>
  );
}

// Auto (follow the conversation) | English segmented control, reused in the
// summary popover's empty state (pre-choice) and footer (post-generation).
function LangToggle({ value, onChange, disabled }) {
  const t = useT();
  return (
    <span className="inline-flex shrink-0 items-center overflow-hidden rounded-[5px] border border-border" title={t('rail.summaryLanguage')}>
      {[['auto', t('rail.auto')], ['en', t('rail.english')]].map(([key, label], i) => (
        <button
          key={key}
          type="button"
          onClick={() => value !== key && onChange(key)}
          disabled={disabled}
          className={`cursor-pointer px-1.5 py-[1px] text-[10.5px] leading-none disabled:opacity-50 ${i ? 'border-l border-border' : ''} ${
            value === key ? 'bg-ink text-white' : 'bg-panel text-fgdim hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

// Manually-enabled status brief for the session. The button lives in the header;
// clicking opens a popover with the summary + controls. A cheap headless run
// generates it server-side (folding only the transcript delta on auto-update).
function SummaryChip({ session }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const summary = session.statusSummary;
  const busy = !!session.summarizing;
  const on = !!summary;
  const sid = session.id;
  // Language chosen in the empty state, before the first summary exists.
  const [pendingLang, setPendingLang] = useState('auto');

  const enable = () => api.post(`/sessions/${sid}/summary`, { autoUpdate: summary?.autoUpdate ?? false, lang: pendingLang })
    .catch((e) => toastError(t('rail.summaryFailed', { msg: e.message || e })));
  const updateNow = () => api.post(`/sessions/${sid}/summary/update`)
    .catch((e) => toastError(t('rail.updateFailed', { msg: e.message || e })));
  const toggleAuto = () => api.patch(`/sessions/${sid}/summary`, { autoUpdate: !summary?.autoUpdate }).catch(() => {});
  const setLang = (lang) => api.patch(`/sessions/${sid}/summary`, { lang }).catch((e) => toastError(t('rail.updateFailed', { msg: e.message || e })));
  const turnOff = () => { api.del(`/sessions/${sid}/summary`).catch(() => {}); setOpen(false); };
  const lang = summary?.lang || 'auto';

  return (
    <span ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('rail.statusSummary')}
        className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${
          on ? 'border-ink bg-chip text-fg' : 'border-hair bg-white text-[#555]'
        }`}
      >
        {busy ? <span className="host-spinner h-2.5 w-2.5" /> : <Icon icon={faListCheck} />}
        <span className="hidden font-mono sm:inline">{t('rail.summary')}</span>
      </button>
      {open && (
        <div className="absolute top-[28px] end-0 z-30 w-[340px] max-w-[86vw] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
          <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
            <span className="font-mono text-[11px] font-bold text-fg">{t('rail.statusSummary')}</span>
            <span className="ms-auto flex items-center gap-1.5">
              {on && (
                <button type="button" onClick={updateNow} disabled={busy} title={t('rail.updateNow')}
                  className="cursor-pointer rounded px-1 text-[11px] text-fgdim hover:text-fg disabled:opacity-40">
                  <Icon icon={faRotateRight} className={busy ? 'animate-spin' : ''} />
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} title={t('rail.close')}
                className="cursor-pointer rounded px-1 text-[11px] text-fgdim hover:text-fg">
                <Icon icon={faXmark} />
              </button>
            </span>
          </div>
          <div className="max-h-[42vh] overflow-y-auto px-3 py-2.5">
            {!on ? (
              <div className="text-[12px] text-fgdim">
                <p className="mb-2.5">{t('rail.summaryIntro')}</p>
                <div className="mb-2.5 flex items-center gap-2">
                  <span>{t('rail.language')}</span>
                  <LangToggle value={pendingLang} onChange={setPendingLang} />
                </div>
                <button type="button" onClick={enable}
                  className="cursor-pointer rounded-md border-2 border-ink bg-brand px-3 py-1.5 text-[12px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] active:translate-x-[1px] active:translate-y-[1px]">
                  {t('rail.summarizeConversation')}
                </button>
              </div>
            ) : busy && !summary.text ? (
              <div className="flex items-center gap-2 text-[12px] text-fgdim"><span className="host-spinner h-3 w-3" /> {t('rail.generating')}</div>
            ) : (
              <div className="md text-[12.5px]" dir="auto">
                <Markdown remarkPlugins={[remarkGfm]}>{summary.text || '…'}</Markdown>
              </div>
            )}
          </div>
          {on && (
            <div className="flex items-center gap-2 border-t border-hair px-3 py-2 text-[10.5px] text-fgdim">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" className="accent-brand" checked={!!summary.autoUpdate} onChange={toggleAuto} />
                {t('rail.autoUpdateEachTurn')}
              </label>
              {/* Output language: Auto (follow the conversation) | English */}
              <span className="ms-auto">
                <LangToggle value={lang} onChange={setLang} disabled={busy} />
              </span>
            </div>
          )}
          {on && (
            <div className="border-t border-hair px-3 py-1.5 text-end">
              <button type="button" onClick={turnOff} className="cursor-pointer text-[10.5px] text-danger hover:underline">{t('rail.turnOff')}</button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

// 🖥 "Machine" — toggles the session side panel with the live shared desktop
// (ScreenSidePanel.jsx). Highlighted while a request_screen is waiting on you.
function MachineChip({ session }) {
  const t = useT();
  const s = useStore();
  if (!s.config?.screen?.enabled) return null;
  const open = screenPanelOpen(s, session.id);
  const pending = !!openScreenRequest(s, session.id);
  return (
    <button
      type="button"
      onClick={() => setScreenPanel(!open)}
      title={open ? t('screen.hidePanel') : t('screen.showPanel')}
      aria-label={open ? t('screen.hidePanel') : t('screen.showPanel')}
      aria-pressed={open}
      className={`hidden h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 font-mono text-[10.5px] md:flex ${
        pending
          ? 'pulse-yellow border-ink bg-brand font-bold text-[#1a1a1a]'
          : open
            ? 'border-ink bg-bg text-fg'
            : 'border-hair text-fgdim hover:border-ink hover:text-fg'
      }`}
    >
      <Icon icon={faDisplay} />
      <span>{t('screen.panelTitle')}</span>
    </button>
  );
}

/**
 * UX1 — a session born from an agent is a JOB, not the agent. It keeps the
 * agent's face, and says so in words: "סשן עבודה · נולד מ-<agent>", linking back
 * to the agent surface. The agent's own home chat never renders this header (it
 * is the בית tab of the agent surface instead).
 */
export function BornFromChip({ session, className = '' }) {
  const tt = useT();
  const { agents } = useStore();
  const slug = session.metadata?.agent;
  if (!slug || session.metadata?.agentHome) return null;
  const agent = (agents || []).find((a) => a.slug === slug) || { slug, name: slug };
  const name = agent.name || slug;
  return (
    <button
      type="button"
      data-born-from={slug}
      title={tt('session.bornFromTitle', { name })}
      onClick={(e) => { e.stopPropagation(); openAgent(slug); }}
      className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9.5px] leading-none whitespace-nowrap hover:opacity-80 ${className}`}
      style={{ borderColor: `${agent.color || '#c4c4c4'}66`, background: `${agent.color || '#c4c4c4'}14` }}
    >
      <AgentAvatar agent={agent} size={12} />
      {tt('session.bornFrom', { name })}
    </button>
  );
}

function TerminalHeader({ session }) {
  const [procPanel, setProcPanel] = useState(false);
  // Same derivation the rail row uses (Rail.jsx Row) — the header had no
  // session identifier at all when the rail (the only other place showing it)
  // is collapsed behind the mobile hamburger.
  const name = session.metadata?.ticket || session.title || session.id;
  const meta = [session.metadata?.ticket, session.metadata?.branch].filter(Boolean).join(' · ');
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-hair bg-panel px-3.5 py-2 text-xs text-fg sm:flex-nowrap">
      <Dot color={session.color} size={9} />
      <span className="shrink-0 font-bold whitespace-nowrap">claude-code</span>
      <Truncate text={name} className="min-w-0 font-mono text-[11px] font-bold text-fg" />
      <BornFromChip session={session} />
      {/* ticket · branch — desktop-only detail; `name` above already covers mobile */}
      {meta && <Truncate text={meta} className="hidden min-w-0 font-mono text-[10.5px] text-fgdim sm:block" />}
      {session.metadata?.fromTriggerName && (
        <TriggerTag
          name={session.metadata.fromTriggerName}
          className="max-w-[160px] text-[10.5px]"
        />
      )}
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <AccountChip session={session} />
        <ProcessChip session={session} onClick={() => setProcPanel(true)} />
        <ListenersChipCompact session={session} />
        <SummaryChip session={session} />
        <MachineChip session={session} />
        <TermControls session={session} />
        <StatusChip session={session} />
      </div>
      {procPanel && <BgProcessesPanel session={session} onClose={() => setProcPanel(false)} />}
    </div>
  );
}

/* ---------- progress strip (set_progress) --------------------------------- */

export function ProgressStrip({ progress }) {
  const steps = progress?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return (
    <div className="flex shrink-0 items-stretch border-b border-hair bg-panel">
      {steps.map((step, i) => {
        const st = step.state || 'pending';
        return (
          <div
            key={i}
            className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 sm:px-3.5 sm:py-2.5 ${
              i < steps.length - 1 ? 'border-r border-hair' : ''
            } ${st === 'active' ? 'bg-[#FEFBE8]' : ''}`}
          >
            {st === 'done' ? (
              <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-[#3C9A4E] text-[9px] text-white sm:h-[18px] sm:w-[18px] sm:text-[11px]">
                <Icon icon={faCheck} />
              </span>
            ) : st === 'active' ? (
              <span className="host-spinner h-[14px] w-[14px] shrink-0 sm:h-[18px] sm:w-[18px]" />
            ) : st === 'error' ? (
              <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-danger text-[9px] text-white sm:h-[18px] sm:w-[18px] sm:text-[11px]">
                <Icon icon={faXmark} />
              </span>
            ) : (
              <span className="h-[14px] w-[14px] shrink-0 rounded-full border-2 border-dashed border-[#cfcfcf] sm:h-[18px] sm:w-[18px]" />
            )}
            {/* on phones only the active step keeps its label — the others are
                just state icons, so five steps never overflow the viewport */}
            <span
              className={`truncate text-xs ${
                st === 'pending' ? 'text-[#999]' : 'text-[#333]'
              } ${st === 'active' ? 'font-mono' : 'hidden sm:block'}`}
            >
              {step.label || ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- listener chips + details modal (deterministic pollers) -------- */

const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const fmtIn = (ts) => {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  return s <= 0 ? 'due now' : s < 60 ? `in ${s}s` : `in ${Math.floor(s / 60)}m`;
};
const fmtClock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const LOG_COLOR = { fire: '#7ee787', warn: '#e3b341', error: '#ff7b72', info: '#9aa0a6' };

export function ListenerChips({ session }) {
  const t = useT();
  const store = useStore();
  const listeners = listenersForSession(store, session.id);
  const [openId, setOpenId] = useState(null);
  if (!listeners.length) return null;
  const cancel = async (lid, e) => {
    e?.stopPropagation();
    try {
      await api.del(`/sessions/${session.id}/listeners/${lid}`);
    } catch {
      /* chip clears via WS echo on success */
    }
  };
  return (
    // Desktop-only: on phones this whole row folds into the header's 👀 chip.
    <div className="hidden shrink-0 flex-wrap items-center gap-1.5 border-b border-hair bg-panel px-3.5 py-2 sm:flex">
      <span className="font-mono text-[10px] tracking-wide text-[#999] uppercase">{t('rail.watching')}</span>
      {listeners.map((l) => {
        const errored = l.status === 'errored';
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => setOpenId(l.id)}
            title={t('rail.openListenerDetails')}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${
              errored
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-hair bg-white text-[#555] hover:bg-chip'
            }`}
          >
            <span><Icon icon={errored ? faTriangleExclamation : faEye} /></span>
            <span className="font-medium">{l.label}</span>
            {l.firedCount > 0 && !errored && <span className="text-[#999]">{t('rail.firedCount', { n: l.firedCount })}</span>}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => cancel(l.id, e)}
              title={t('rail.cancelListener')}
              className="ml-0.5 cursor-pointer text-[#bbb] hover:text-danger"
            >
              <Icon icon={faXmark} />
            </span>
          </button>
        );
      })}
      {openId && (
        <ListenersPanel session={session} initialId={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function ListenersPanel({ session, initialId, onClose }) {
  const t = useT();
  const store = useStore();
  const list = (store.listeners || []).filter((l) => l.sessionId === session.id);
  const [selId, setSelId] = useState(initialId || list[0]?.id || null);
  const sel = list.find((l) => l.id === selId) || list[0] || null;
  const [detail, setDetail] = useState(null); // {..listener, log}
  const logRef = useRef(null);

  // Poll the selected listener's full detail + activity log.
  useEffect(() => {
    if (!sel) return;
    let stop = false;
    setDetail(null);
    const tick = async () => {
      try {
        const d = await api.get(`/sessions/${session.id}/listeners/${sel.id}`);
        if (!stop) setDetail(d);
      } catch {
        /* listener may have been cancelled */
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [sel?.id, session.id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.log?.length]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cancel = async (lid) => {
    try {
      await api.del(`/sessions/${session.id}/listeners/${lid}`);
    } catch {
      /* WS echo updates the list */
    }
  };

  const dotColor = (l) => (l.status === 'errored' ? '#B23B30' : l.status === 'stopped' ? '#9a9a9a' : '#3C9A4E');
  const log = detail?.log || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 md:p-6" onMouseDown={onClose}>
      <div
        className="flex h-[78vh] w-[920px] max-w-full flex-col overflow-hidden rounded-[12px] border-[1.5px] border-ink bg-panel shadow-[4px_4px_0_rgba(0,0,0,0.25)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <span className="text-[13px] leading-none"><Icon icon={faEye} /></span>
          <span className="font-mono text-[13px] font-bold text-fg">{t('rail.listeners')}</span>
          <span className="font-mono text-[10.5px] text-fgdim">{t('rail.nWatching', { n: list.length })}</span>
          <button
            type="button"
            onClick={onClose}
            className="ms-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          >
            <Icon icon={faXmark} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* left: listener list — stacks on top of the details on phones */}
          <div className="thin-scroll max-h-[30vh] shrink-0 overflow-y-auto border-b border-hair bg-bg md:max-h-none md:w-[300px] md:border-r md:border-b-0">
            {list.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelId(l.id)}
                className={`flex w-full flex-col gap-1 border-b border-hair px-3 py-2.5 text-start ${
                  l.id === sel?.id ? 'bg-chip' : 'hover:bg-panel'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor(l) }} />
                  <span className="font-mono text-[11px] font-bold text-fg">{l.label}</span>
                  <span className="ms-auto font-mono text-[9.5px] text-fgdim">{l.status}</span>
                </div>
                <span className="font-mono text-[9.5px] text-fgdim">
                  {l.type} · {t('rail.nFired', { n: l.firedCount || 0 })}
                </span>
              </button>
            ))}
            {!list.length && (
              <div className="px-3 py-4 text-center text-[11px] text-fgdim">{t('rail.noListeners')}</div>
            )}
          </div>

          {/* right: details + activity log */}
          <div className="flex min-w-0 flex-1 flex-col bg-term">
            {sel ? (
              <>
                <div className="border-b border-white/10 px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor(sel) }} />
                    <span className="font-mono text-[12px] font-bold text-[#e4e4e4]">{sel.label}</span>
                    <span className="font-mono text-[10px] text-[#8a8a8a]">{sel.status}</span>
                    {sel.status !== 'stopped' && (
                      <button
                        type="button"
                        onClick={() => cancel(sel.id)}
                        className="ms-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-[1.5px] border-danger bg-transparent px-2.5 py-1 text-[10.5px] font-bold text-danger hover:bg-danger/10"
                      >
                        <Icon icon={faStop} className="text-[9px]" /> {t('rail.cancelLower')}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] text-[#9aa0a6]">
                    <span>{t('rail.firesOn')} <span className="text-[#cfcfcf]">{(sel.fireOn || []).join(', ') || '—'}</span></span>
                    <span>{t('rail.every')} <span className="text-[#cfcfcf]">{sel.intervalSec}s</span></span>
                    <span>{t('rail.lastPoll')} <span className="text-[#cfcfcf]">{fmtAgo(detail?.lastPolledAt ?? sel.lastPolledAt)}</span></span>
                    <span>{t('rail.nextPoll')} <span className="text-[#cfcfcf]">{fmtIn(detail?.nextPollAt ?? sel.nextPollAt)}</span></span>
                    <span>{t('rail.firedLabel')} <span className="text-[#cfcfcf]">{detail?.firedCount ?? sel.firedCount ?? 0}×</span></span>
                    <span>{t('rail.expires')} <span className="text-[#cfcfcf]">{fmtIn(sel.ttlAt)}</span></span>
                    {(detail?.lastError ?? sel.lastError) && (
                      <span className="col-span-2 text-danger">{t('rail.lastError')} {detail?.lastError ?? sel.lastError}</span>
                    )}
                  </div>
                </div>
                <div className="border-b border-white/10 px-3.5 py-1.5 font-mono text-[9.5px] tracking-wide text-[#6a6a6a] uppercase">
                  {t('rail.activity')}
                </div>
                <pre
                  ref={logRef}
                  dir="ltr"
                  className="thin-scroll min-h-0 flex-1 overflow-auto px-3.5 py-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >
                  {detail == null ? (
                    <span className="text-[#888]">{t('rail.loading')}</span>
                  ) : log.length === 0 ? (
                    <span className="text-[#888]">{t('rail.noActivityYet')}</span>
                  ) : (
                    log.map((e, i) => (
                      <div key={i}>
                        <span className="text-[#6a6a6a]">{fmtClock(e.ts)} </span>
                        <span style={{ color: LOG_COLOR[e.level] || '#cfcfcf' }}>{e.text}</span>
                      </div>
                    ))
                  )}
                </pre>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-[#888]">
                {t('rail.noActiveListeners')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- chat footer ---------------------------------------------------- */

// Archived sessions are a read-only peek — swap the live composer for a banner
// so the user can't type into a session that won't respond, with a one-click
// restore.
function ArchivedFooter({ session }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      await api.patch(`/sessions/${session.id}`, { archived: false });
    } catch (e) {
      toastError(t('rail.couldntRestore', { msg: e?.message || e }));
      setBusy(false);
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-hair bg-panel px-4 py-3">
      <span className="min-w-0 flex-1 basis-52 text-[12px] text-fgdim">
        {t('rail.sessionArchivedReadonly')}
      </span>
      <button
        type="button"
        onClick={restore}
        disabled={busy}
        className="ms-auto cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3 py-1 text-[11.5px] font-bold text-[#1a1a1a] disabled:opacity-50"
      >
        {busy ? t('rail.restoring') : t('rail.restoreSession')}
      </button>
    </div>
  );
}

/* ---------- pending prompts (queued while busy) ---------------------------- */

function PendingPromptsPanel({ session }) {
  const t = useT();
  const prompts = session.pendingPrompts || [];
  const autoPlay = !!session.promptAutoPlay;
  const [open, setOpen] = useState(false);
  // Optimistic order mirror for drag-sort (same HTML5 pattern as the rail's
  // Pending tasks list — no library, plain draggable + dataTransfer).
  const [order, setOrder] = useState(prompts.map((p) => p.id));
  const dragId = useRef(null);
  const [overId, setOverId] = useState(null);
  useEffect(() => {
    setOrder(prompts.map((p) => p.id));
  }, [prompts.map((p) => p.id).join('|')]);
  if (!prompts.length) return null;
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const rows = order.map((pid) => byId.get(pid)).filter(Boolean);

  const play = (pid) => api.post(`/sessions/${session.id}/prompts/${pid}/play`).catch(toastError);
  const del = (pid) => api.del(`/sessions/${session.id}/prompts/${pid}`).catch(toastError);
  const toggleAuto = () =>
    api.post(`/sessions/${session.id}/prompts/autoplay`, { on: !autoPlay }).catch(toastError);

  const onDragStart = (e, pid) => {
    dragId.current = pid;
    e.dataTransfer.effectAllowed = 'move';
    // Tag the drag so ancestors (the composer's attachment drop zone) can tell
    // it apart from a file/session drag and ignore it.
    e.dataTransfer.setData('application/x-arigami-prompt', pid);
  };
  const onDragOver = (e, pid) => {
    e.preventDefault();
    e.stopPropagation();
    if (pid !== overId) setOverId(pid);
  };
  const onDropRow = (e, pid) => {
    e.preventDefault();
    e.stopPropagation();
    setOverId(null);
    const from = order.indexOf(dragId.current);
    const to = order.indexOf(pid);
    dragId.current = null;
    if (from === -1 || to === -1 || from === to) return;
    const ids = [...order];
    ids.splice(to, 0, ...ids.splice(from, 1));
    setOrder(ids);
    api.post(`/sessions/${session.id}/prompts/reorder`, { order: ids }).catch(toastError);
  };

  return (
    <div className="relative">
      {/* collapsed pill row */}
      <div className="mb-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-border bg-bg px-2.5 py-1 text-[11px] text-fg hover:border-ink"
          title={open ? t('rail.hideQueuedPrompts') : t('rail.showQueuedPrompts')}
        >
          <span><Icon icon={faHourglassHalf} /></span>
          <span className="font-mono font-bold">{prompts.length}</span>
          <span className="text-fgdim">{t('rail.queued')}</span>
          <span className="text-[9px] text-fgdim"><Icon icon={open ? faCaretDown : faCaretUp} /></span>
        </button>
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-fgdim"
          title={t('rail.autoPlayPromptHint')}
        >
          <span
            onClick={toggleAuto}
            className="relative h-[13px] w-[22px] cursor-pointer rounded-full transition-colors"
            style={{ background: autoPlay ? '#F9D312' : '#d6d6d6' }}
          >
            <span
              className="absolute top-px h-[11px] w-[11px] rounded-full bg-white transition-[left]"
              style={{ left: autoPlay ? 10 : 1, border: `1px solid ${autoPlay ? '#2a2a2a' : '#999'}` }}
            />
          </span>
          {t('rail.autoPlay')}
        </label>
      </div>
      {/* floating list */}
      {open && (
        <div className="absolute bottom-full start-0 z-30 mb-1 w-full max-w-[560px] rounded-[10px] border-[1.5px] border-ink bg-panel p-2 shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
          <div className="mb-1.5 px-1 font-mono text-[9.5px] tracking-[0.08em] text-fgdim uppercase">
            {t('rail.queuedPromptsHint')}
          </div>
          <div className="thin-scroll flex max-h-[38vh] flex-col gap-1 overflow-y-auto">
            {rows.map((p) => (
              <div
                key={p.id}
                draggable
                onDragStart={(e) => onDragStart(e, p.id)}
                onDragOver={(e) => onDragOver(e, p.id)}
                onDrop={(e) => onDropRow(e, p.id)}
                onDragEnd={() => setOverId(null)}
                className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 ${
                  overId === p.id ? 'border-ink bg-chip/60' : 'border-hair bg-bg'
                }`}
              >
                <span className="cursor-grab pt-px text-[11px] text-fgdim select-none" title={t('rail.dragToReorder')}>
                  <Icon icon={faGripVertical} />
                </span>
                <span dir="auto" className="min-w-0 flex-1 text-[11.5px] leading-snug break-words text-fg">
                  {p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text}
                </span>
                <button
                  type="button"
                  onClick={() => play(p.id)}
                  title={
                    session.claude?.state === 'working'
                      ? t('rail.interruptSendNow')
                      : t('rail.sendPromptNow')
                  }
                  className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-panel text-[10px] text-fg hover:border-ink"
                >
                  <Icon icon={faPlay} />
                </button>
                <button
                  type="button"
                  onClick={() => del(p.id)}
                  title={t('rail.removeFromQueue')}
                  className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-panel text-[10px] text-fgdim hover:border-danger hover:text-danger"
                >
                  <Icon icon={faXmark} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChatFooter({ session }) {
  const t = useT();
  // Draft text/attachments are mirrored into the global store keyed by session
  // id, so they survive switching to another session and back — local state
  // alone doesn't, since ChatFooter unmounts when the active session changes.
  const [text, setTextLocal] = useState(() => getDraft(session.id).text);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [panelTab, setPanelTab] = useState(null); // null = closed; else a tab id
  const [attachments, setAttachmentsLocal] = useState(() => getDraft(session.id).attachments);
  const [dragging, setDragging] = useState(false);
  const [quoted, setQuoted] = useState(null); // { kind, text, ts }
  const isDesktop = useIsDesktop();
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const setText = (updater) =>
    setTextLocal((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraft(session.id, { text: next });
      return next;
    });
  const setAttachments = (updater) =>
    setAttachmentsLocal((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setDraft(session.id, { attachments: next });
      return next;
    });
  // Covers the case where ChatFooter stays mounted and only `session` changes.
  const prevSessionId = useRef(session.id);
  useEffect(() => {
    if (prevSessionId.current === session.id) return;
    prevSessionId.current = session.id;
    const d = getDraft(session.id);
    setTextLocal(d.text);
    setAttachmentsLocal(d.attachments);
  }, [session.id]);
  const working = session.claude?.state === 'working';
  // List payloads carry slim capabilities; the slash palette + Capabilities
  // panel need the full command/tool lists — fetched lazily, cached in the store.
  useStore(); // re-render when capsFull lands
  const caps = fullCapabilities(session);
  const capsSlim = !!session.claude?.capabilities?.slim;
  const capsSessionId = session.claude?.sessionId;
  useEffect(() => {
    if (capsSlim) ensureFullCapabilities(session);
  }, [session.id, capsSlim, capsSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Rich command objects from the initialize handshake; fall back to legacy
  // bare-string slashCommands captured before this shape existed.
  const commands = caps?.commands || (caps?.slashCommands || []).map((name) => ({ name }));

  // A4: host agent commands (/team, /as, /agent new) + skills with a `slash:`
  // field (/plan, /review, user skills) join the palette; "@" suggests agents.
  const { agents, sessions: sessionsAll } = useStore();
  const skills = useSkills();
  const [teamOpen, setTeamOpen] = useState(false);
  const extraItems = useMemo(() => [...agentCommandItems(), ...skillSlashItems(skills)], [skills]);

  // The palette shows while the input is a single "/token" (no space yet) —
  // "/agent new" is two words, so the second word is allowed for that one.
  const slashMatch = /^\/([\w:-]*)$/.exec(text) || /^\/(agent(?: [a-z]*)?)$/.exec(text);
  const query = slashMatch ? slashMatch[1] : '';
  const items = useMemo(
    () => (slashMatch ? buildSlashItems(query, commands, extraItems) : []),
    [slashMatch, query, commands, extraItems]
  );
  const mq = mentionQuery(text);
  const mentionItems = useMemo(() => (mq !== null ? buildMentionItems(mq, agents) : []), [mq, agents]);
  const mentionOpen = mq !== null && !dismissed && mentionItems.length > 0;
  const paletteOpen = !!slashMatch && !dismissed && items.length > 0;
  useEffect(() => setActive(0), [query, mq]);
  useEffect(() => { if (!slashMatch && mq === null) setDismissed(false); }, [slashMatch, mq]);

  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());

  // Command bus → focus the composer (voice: "let me type", "focus the input").
  useEffect(() => {
    const onFocus = () => focusInput();
    window.addEventListener('host:focus-input', onFocus);
    return () => window.removeEventListener('host:focus-input', onFocus);
  }, []);

  // Quote: ChatPane fires 'host:quote' when the user clicks ↩ on a message.
  useEffect(() => {
    const onQuote = (e) => {
      const ev = e.detail?.event;
      if (!ev) return;
      const txt = ev.text ?? ev.content ?? ev.message ?? ev.output ?? '';
      const text = typeof txt === 'string' ? txt : Array.isArray(txt) ? txt.map(p => typeof p === 'string' ? p : p?.text ?? '').join('\n') : String(txt);
      setQuoted({ kind: ev.kind, text, ts: ev.ts });
      focusInput();
    };
    window.addEventListener('host:quote', onQuote);
    return () => window.removeEventListener('host:quote', onQuote);
  }, []);


  // Accept a palette item: host "inspect" commands open the panel; real
  // commands are inserted as "/name " so the user can add args, then ↵ sends.
  const accept = (item) => {
    if (!item) return;
    if (item.agentCmd) {
      // A4: /team runs at once; /as and /agent new want arguments.
      if (item.run) { runHostCommand({ type: item.agentCmd }); setText(''); return; }
      setText('/' + item.name + ' ');
      setDismissed(true);
      focusInput();
    } else if (item.host) {
      setPanelTab(item.tab);
      setText('');
    } else {
      setText('/' + item.name + ' ');
      setDismissed(true);
      focusInput();
    }
  };

  const acceptMention = (a) => {
    if (!a) return;
    setText((t) => completeMention(t, a.slug));
    setDismissed(true);
    focusInput();
  };

  // A4: the host-side outcomes of a submission (never sent to claude).
  const runHostCommand = async (r) => {
    if (r.type === 'team') { setTeamOpen(true); return; }
    if (r.type === 'as-usage') { toastError(t('dialogs.asUsage')); return; }
    if (r.type === 'unknown-agent') { toastError(t('dialogs.unknownAgent', { name: r.name })); return; }
    if (r.type === 'agent-new') {
      // UX2: no session-spawning "interview" — opens the same agent surface an
      // existing agent uses, just in create mode (AgentView, slug '__new__').
      openAgent('__new__', 'persona', r.name || '');
      return;
    }
    if (r.type === 'adopt-usage') { toastError(t('dialogs.adoptUsage')); return; }
    if (r.type === 'adopt') {
      await api.post(`/sessions/${session.id}/adopt-agent`, { agent: r.agent.slug });
      return;
    }
    if (r.type === 'as') {
      await api.post(`/sessions/${session.id}/delegate`, { agent: r.agent.slug, text: r.text, mode: 'as' });
      return;
    }
    if (r.type === 'mention') {
      for (const a of r.agents) await api.post(`/sessions/${session.id}/delegate`, { agent: a.slug, text: r.text, mode: 'mention' });
    }
  };

  // Insert a command from the Capabilities panel into the input.
  const insertCommand = (name) => {
    setPanelTab(null);
    setText('/' + name + ' ');
    focusInput();
  };

  const isArchiveName = (name) => /\.(zip|tar|tar\.gz|tgz)$/i.test(name || '');

  // ---- attachments (file picker / drag-drop / paste) ----
  // ZIP: anything under STREAM_THRESHOLD still rides inline as base64 in the
  // message body; at/past it, it streams to .../attachments first (needed for
  // archives — the 32MB JSON body cap made anything but a small screenshot
  // fail outright) and the chip tracks upload progress until the server's
  // descriptor comes back (with the extracted tree, for a zip/tar).
  const addFiles = async (fileList) => {
    const arr = Array.from(fileList || []);
    // ZIP2: a re-drag of a file already in the draft (same name+size) is
    // dropped here instead of spooling another full copy server-side.
    const fresh = arr.filter((f) => !isAlreadyAttached(attachments, f));
    const oversized = fresh.filter((f) => f.size > HARD_CAP);
    for (const f of oversized) toastError(new Error(t('rail.attachTooLarge', { name: f.name })));
    const accepted = fresh.filter((f) => f.size <= HARD_CAP);
    const small = accepted.filter((f) => !shouldStream(f));
    const big = accepted.filter(shouldStream);

    if (small.length) {
      const read = await Promise.all(
        small.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataBase64: await fileToBase64(f) }))
      );
      setAttachments((a) => [...a, ...read.filter((x) => x.dataBase64)].slice(0, 10));
    }
    for (const f of big) {
      const placeholder = pendingAttachment(f);
      setAttachments((a) => [...a, placeholder].slice(0, 10));
      try {
        const descriptor = await uploadAttachment(session.id, f, {
          onProgress: (p) => setAttachments((a) => applyUploadEvent(a, placeholder.uid, { type: 'progress', progress: p })),
        });
        setAttachments((a) => applyUploadEvent(a, placeholder.uid, { type: 'done', descriptor }));
      } catch (e) {
        setAttachments((a) => applyUploadEvent(a, placeholder.uid, { type: 'fail', error: errText(e) }));
      }
    }
  };
  const removeAttachment = (i) => {
    // ZIP2: a streamed upload already landed on disk (has `.path`) — reclaim
    // the spooled copy + extraction dir now that the chip is gone, instead of
    // leaving it in ~/.arigami/uploads until someone cleans it up by hand.
    const item = attachments[i];
    if (item?.path && !item.uploading) {
      api.del(`/sessions/${session.id}/attachments?path=${encodeURIComponent(item.path)}`).catch(() => {});
    }
    setAttachments((a) => a.filter((_, k) => k !== i));
  };

  // Guards against a double-fire from the Enter-keydown handler and the Send
  // button's onClick landing in the same tick, before React re-renders to
  // reflect the cleared `text` — without this, one submission could POST twice.
  const sendingRef = useRef(false);
  const send = async () => {
    if (sendingRef.current) return;
    // NOTE: `t` is the i18n function in this component — the composer text is
    // `draft` (it used to shadow `t`, so nothing here could be translated).
    const draft = text.trim();
    if (!draft && !attachments.length) return;
    if (attachments.some((a) => a.uploading || a.failed)) {
      toastError(new Error(t('rail.attachStillUploading')));
      return;
    }
    sendingRef.current = true;
    const sentAttachments = attachments;
    // Prepend the quoted message as a blockquote so the model sees context.
    const quotedPrefix = quoted
      ? `> ${quoted.text.split('\n').join('\n> ')}\n\n`
      : '';
    // A4: slash-commands / @mentions the host answers itself (see lib/composer.js).
    const resolved = resolveSubmission(draft, { skills, agents });
    if (resolved.type !== 'plain' && resolved.type !== 'skill') {
      setText('');
      try {
        await runHostCommand(resolved.type === 'mention' ? { ...resolved, text: quotedPrefix + resolved.text } : resolved);
      } catch (e) {
        // A5 (#10): a FAILED command must never go back into the box. It used to
        // be restored there, so the next thing the human typed was appended to it
        // and Enter silently re-ran the same failing slash line instead of sending
        // a message. Say what happened; put the text back only if they ask.
        toastError(t('chat.commandFailed', { msg: errText(e) }), {
          action: { label: t('chat.commandRestore'), onClick: () => { setText(draft); focusInput(); } },
        });
      } finally {
        sendingRef.current = false;
      }
      return;
    }
    // A skill slash (/plan …) is rewritten to its plugin command (/arigami:dispatch …).
    const fullText = quotedPrefix + (resolved.type === 'skill' ? resolved.text : draft);
    const payload = {
      text: fullText,
      attachments: sentAttachments.map(({ name, type, dataBase64, path }) => (path ? { name, type, path } : { name, type, dataBase64 })),
    };
    setLastSent(session.id, { text: fullText, attachments: sentAttachments });
    setText('');
    setAttachments([]);
    setQuoted(null);
    try {
      await api.post(`/sessions/${session.id}/message`, payload);
    } catch (e) {
      // Restore the draft — but SAY why it came back (a refused turn used to look
      // like Enter did nothing at all): a budget 429 renders localized (A5 #11).
      setText(draft);
      setAttachments(sentAttachments);
      toastError(e);
    } finally {
      sendingRef.current = false;
    }
  };

  const interrupt = () => interruptSession(session.id);

  // Queue the composer text as a pending prompt instead of interjecting into
  // the running turn (attachments stay in the draft — the queue is text-only).
  const queue = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      await api.post(`/sessions/${session.id}/prompts`, { text: t });
    } catch (e) {
      setText(t); // restore on failure
      toastError(e);
    }
  };

  // Stopping a running turn (Esc, ■, or a voice "stop") hands the in-flight
  // prompt back to this session's draft — sync it in if we're still mounted.
  useEffect(() => {
    const onRestored = (e) => {
      if (e.detail?.sessionId !== session.id) return;
      const d = getDraft(session.id);
      setTextLocal(d.text);
      setAttachmentsLocal(d.attachments);
    };
    window.addEventListener('host:draft-restored', onRestored);
    return () => window.removeEventListener('host:draft-restored', onRestored);
  }, [session.id]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    // A rail session row dropped here becomes an inline reference the agent can
    // act on (it can read that session via the host MCP's list_sessions).
    const sessRef = e.dataTransfer?.getData('application/x-arigami-session');
    if (sessRef) {
      try {
        const { id: sid, title } = JSON.parse(sessRef);
        if (sid && sid !== session.id) {
          const ref = `[host session: "${title || sid}" — id ${sid}] `;
          setText((t) => (t ? `${t} ${ref}` : ref));
          focusInput();
        }
      } catch { /* malformed payload — ignore */ }
      return;
    }
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const onKeyDown = (e) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(mentionItems.length - 1, i + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(mentionItems[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (paletteOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div
      className="relative shrink-0 border-t border-hair bg-panel px-2.5 py-2 sm:px-3.5 sm:py-2.5"
      onDragOver={(e) => {
        // Only react to drags this zone can accept — real files or a rail
        // session row. Internal drags (queued-prompt reorder) fall through.
        const types = e.dataTransfer?.types || [];
        const kind = types.includes('application/x-arigami-session')
          ? 'session'
          : types.includes('Files')
            ? 'file'
            : null;
        if (!kind) return;
        e.preventDefault();
        if (!dragging) setDragging(kind);
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {paletteOpen && <SlashPalette items={items} active={active} onPick={accept} onHover={setActive} />}
      {mentionOpen && !paletteOpen && <MentionPalette items={mentionItems} active={active} onPick={acceptMention} onHover={setActive} />}
      {teamOpen && (
        <TeamPanel agents={agents} sessions={sessionsAll} onClose={() => setTeamOpen(false)} onMention={(a) => { setText((t) => (t ? `${t} @${a.slug} ` : `@${a.slug} `)); focusInput(); }} />
      )}
      {panelTab && (
        <CapabilitiesPanel capabilities={caps} session={session} initialTab={panelTab} onClose={() => setPanelTab(null)} onPickCommand={insertCommand} />
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-[10px] border-2 border-dashed border-ink bg-chip/80 font-mono text-[12px] font-bold text-[#4a3f12]">
          {dragging === 'session' ? t('rail.dropReferenceSession') : t('rail.dropFilesToAttach')}
        </div>
      )}

      <PendingPromptsPanel session={session} />

      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a, i) => {
            const archiveLike = a.archive || isArchiveName(a.name);
            // ZIP3: a partial extraction (entriesTotal > entryCount, no hard
            // error) must look like a problem, not a quiet success — the bug
            // this fixes was a chip that reported 57/1335 as if nothing had
            // gone wrong.
            const archivePartial = !!(a.archive && !a.archive.error && a.archive.entriesTotal > 0 && a.archive.entriesTotal !== a.archive.entryCount);
            const archiveProblem = !a.uploading && !!(a.failed || (a.archive && (a.archive.error || archivePartial)));
            return (
              <div
                key={i}
                title={a.archive?.dir || undefined}
                className={`flex items-center gap-1.5 rounded-md border py-1 pe-1 ps-1.5 ${archiveProblem ? 'border-danger bg-[#fdf6f5]' : 'border-border bg-bg'}`}
              >
                {a.type?.startsWith('image/') && a.dataBase64 ? (
                  <img src={`data:${a.type};base64,${a.dataBase64}`} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
                ) : (
                  <span className={`text-[12px] ${archiveProblem ? 'text-danger' : 'text-fgdim'}`}>
                    <Icon icon={archiveLike ? faBoxArchive : a.type?.startsWith('image/') ? faImage : faFile} />
                  </span>
                )}
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="max-w-[160px] truncate font-mono text-[10.5px] text-fg">{a.name}</span>
                  {a.uploading && (
                    <span className="font-mono text-[9px] text-fgdim">{t('rail.attachUploading', { pct: Math.round((a.progress || 0) * 100) })}</span>
                  )}
                  {a.failed && (
                    <span className="max-w-[160px] truncate font-mono text-[9px] text-danger">{t('rail.attachUploadFailed', { msg: a.error || '' })}</span>
                  )}
                  {!a.uploading && !a.failed && a.archive && (
                    <span className={`font-mono text-[9px] ${archiveProblem ? 'text-danger' : 'text-fgdim'}`}>
                      {a.archive.error
                        ? t('rail.archiveExtractFailed')
                        : archivePartial
                          ? t('rail.archivePartial', { n: a.archive.entryCount, total: a.archive.entriesTotal })
                          : a.archive.entryCount === 1
                            ? t('rail.archiveOneEntry')
                            : t('rail.archiveNEntries', { n: a.archive.entryCount })}
                      {a.archive.rejectedCount > 0 && ` · ${t('rail.archiveRejected', { n: a.archive.rejectedCount })}`}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  title={t('rail.remove')}
                  className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[10px] text-fgdim hover:bg-hair hover:text-danger"
                >
                  <Icon icon={faXmark} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        />
        <button
          type="button"
          title={t('rail.attachFiles')}
          onClick={() => fileRef.current?.click()}
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] border-border bg-bg text-[14px] text-fgdim hover:border-ink hover:text-fg"
        >
          <Icon icon={faPaperclip} />
        </button>
        {/* phones: typing "/" opens the same palette — the button isn't worth
            the composer width it costs */}
        <button
          type="button"
          title={t('rail.slashCommandsCapabilities')}
          onClick={() => setPanelTab('commands')}
          className="hidden h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] border-border bg-bg font-mono text-[13px] text-fgdim hover:border-ink hover:text-fg sm:flex"
        >
          /
        </button>
        <div className="flex min-w-0 flex-1 flex-col rounded-[10px] border-[1.5px] border-border focus-within:border-[#9a9a9a]">
          {quoted && (
            <div className="flex items-start gap-2 border-b border-border bg-[var(--term-hover,#f5f5f5)] px-3 py-1.5">
              <Icon icon={faReply} className="mt-0.5 text-[10px] text-brand opacity-70" />
              <span dir="auto" className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fgdim">
                {quoted.text.length > 120 ? quoted.text.slice(0, 120) + '…' : quoted.text}
              </span>
              <button
                type="button"
                onClick={() => setQuoted(null)}
                className="shrink-0 cursor-pointer text-[10px] text-fgdim hover:text-fg"
              >
                <Icon icon={faXmark} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 px-3 py-2">
          <textarea
            ref={taRef}
            rows={1}
            dir={dirOf(text)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={isDesktop ? t('rail.replyPlaceholder') : t('rail.replyPlaceholderShort')}
            className="max-h-32 min-w-0 flex-1 resize-none bg-transparent text-[11.5px] leading-relaxed outline-none placeholder:text-[#aaa]"
            style={{ fieldSizing: 'content' }}
          />
          </div>
        </div>
        {working && (
          <button
            type="button"
            title={t('rail.interruptClaude')}
            onClick={interrupt}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] border-danger bg-bg text-[11px] text-danger hover:bg-[#fdf6f5]"
          >
            <Icon icon={faStop} />
          </button>
        )}
        {working && (
          <button
            type="button"
            title={t('rail.queuePendingHint')}
            onClick={queue}
            disabled={!text.trim()}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] border-border bg-bg text-[13px] text-fgdim hover:border-ink hover:text-fg disabled:cursor-default disabled:opacity-40"
          >
            <Icon icon={faHourglassHalf} />
          </button>
        )}
        <MicButton />
        <button
          type="button"
          title={t('rail.send')}
          onClick={send}
          disabled={(!text.trim() && !attachments.length) || attachments.some((a) => a.uploading)}
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] border-border bg-bg text-sm text-fgdim hover:border-ink hover:text-fg disabled:cursor-default disabled:opacity-40"
        >
          <Icon icon={faArrowUp} />
        </button>
      </div>
    </div>
  );
}

// Always-visible voice trigger — voice used to hide inside the rail's profile
// menu, unreachable on phones where the rail is a closed drawer.
function MicButton() {
  const t = useT();
  const { status } = useVoice();
  const rec = status === 'recording';
  return (
    <button
      type="button"
      title={t('rail.voiceControlHint')}
      onClick={toggleRecording}
      className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] text-[13px] ${
        rec
          ? 'border-danger bg-[#fdf6f5] text-danger'
          : 'border-border bg-bg text-fgdim hover:border-ink hover:text-fg'
      }`}
    >
      <Icon icon={rec ? faCircle : faMicrophone} className={rec ? 'text-[9px]' : undefined} />
    </button>
  );
}

/* ---------- url / content tabs --------------------------------------------- */

function ComparePill({ on, onToggle, label }) {
  const t = useT();
  const lbl = label || t('rail.compareToProd');
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`ms-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-ink py-0.5 pe-2.5 ps-1.5 ${
        on ? 'bg-chip' : 'bg-panel'
      }`}
    >
      <span
        className="relative h-[13px] w-[22px] rounded-full transition-colors"
        style={{ background: on ? '#F9D312' : '#d6d6d6' }}
      >
        <span
          className="absolute top-px h-[11px] w-[11px] rounded-full bg-white transition-[left]"
          style={{
            left: on ? 10 : 1,
            border: `1px solid ${on ? '#2a2a2a' : '#999'}`,
          }}
        />
      </span>
      <span className={`text-[10.5px] ${on ? 'text-[#4a3f12]' : 'text-fgdim'}`}>
        {lbl}
      </span>
    </button>
  );
}

function UrlTab({ tab, active }) {
  const t = useT();
  // A session can open a tab already split in comparison mode (compare.open via
  // the open_tab MCP tool); otherwise it starts on the live view with the toggle.
  const compareProxied = !!tab.url && !tab.url.startsWith('/') && !tab.url.startsWith(HOST_ORIGIN);
  const [compareOn, setCompareOn] = useState(!!tab.compare?.open && compareProxied);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const { config } = useStore();
  // The server can flip compare mode on later via update_tab (tab-updated WS):
  // sync the local toggle when the server's compare.open changes, mirroring how
  // the active-tab override works. Local user toggling still wins between server
  // changes because we only react to the server value flipping.
  const serverCompareOpen = !!tab.compare?.open && compareProxied;
  const prevServerCompare = useRef(serverCompareOpen);
  useEffect(() => {
    if (serverCompareOpen !== prevServerCompare.current) {
      prevServerCompare.current = serverCompareOpen;
      setCompareOn(serverCompareOpen);
    }
  }, [serverCompareOpen]);
  // Command bus → reload the live tab (voice: "reload the page"). Only the
  // ACTIVE tab responds — otherwise every hidden URL tab in the session would
  // remount its iframe and lose its navigation/scroll/login state. Bumping the
  // iframe key forces a fresh mount, the simplest cross-origin-safe reload.
  useEffect(() => {
    if (!active) return;
    const onReload = () => { setLoading(true); setReloadKey((k) => k + 1); };
    window.addEventListener('host:reload-tab', onReload);
    return () => window.removeEventListener('host:reload-tab', onReload);
  }, [active]);
  // Every proxied URL tab gets the compare toggle. Baseline priority:
  // explicit tab.compare.url → storybookCompareUrl for Storybook-port targets
  // (the latest published build, e.g. Chromatic main) → prod at the same path
  // (the /__compare page's own default).
  const proxied = !!tab.url && !tab.url.startsWith('/') && !tab.url.startsWith(HOST_ORIGIN);
  const isStorybook = /:60\d\d(\/|$)/.test(tab.url || '');
  const compareTo =
    tab.compare?.url || (isStorybook && config?.storybookCompareUrl) || null;
  // A url tab with no url is malformed (nothing to show) — render a calm empty
  // state rather than an iframe, so it can never spin the host-proxy bootstrap.
  if (!tab.url) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-bg text-center">
        <div className="text-[13px] font-bold text-fg">{t('rail.noUrlForTab')}</div>
        <div className="text-[11.5px] text-fgdim">{t('rail.noAddressToLoad')}</div>
      </div>
    );
  }
  const src = compareOn
    ? `${HOST_ORIGIN}/__compare?a=${encodeURIComponent(tab.url || '')}${
        compareTo ? `&b=${encodeURIComponent(compareTo)}` : ''
      }`
    : tabSrc(tab.url);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hair bg-panel px-2.5">
        <button
          type="button"
          onClick={() => { setLoading(true); setReloadKey((k) => k + 1); }}
          title={t('rail.reloadPreview')}
          aria-label={t('rail.reloadPreviewAria')}
          className="shrink-0 cursor-pointer rounded-[5px] border border-border px-1.5 leading-[18px] text-fgdim hover:border-ink hover:text-fg"
        >
          <Icon icon={faRotateRight} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fgdim">{tab.url}</span>
        <a
          /* proxied so it opens from any device — the raw tab.url may point at
             the HOST's localhost, which a phone over VPN can't reach */
          href={tabSrc(tab.url)}
          target="_blank"
          rel="noreferrer"
          title={t('rail.openInNewTab')}
          aria-label={t('rail.openInNewTab')}
          className="shrink-0 cursor-pointer rounded-[5px] border border-border px-1.5 leading-[18px] text-fgdim hover:border-ink hover:text-fg"
        >
          ↗
        </a>
        {proxied && (
          <ComparePill
            on={compareOn}
            onToggle={() => { setLoading(true); setCompareOn((v) => !v); }}
            label={tab.compare?.url ? t('rail.compare') : isStorybook && compareTo ? t('rail.vsMainBuild') : t('rail.compareToProd')}
          />
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/80 text-[11px] text-fgdim">
            <span className="host-spinner h-3.5 w-3.5" /> {t('rail.loadingPreview')}
          </div>
        )}
        <iframe
          key={reloadKey}
          title={tab.title || t('rail.tabFallback')}
          src={src}
          onLoad={() => setLoading(false)}
          /* Published artifacts (A1) run with an opaque origin — no
             allow-same-origin — so a page can't call /__api as the cockpit.
             The host also sends a CSP sandbox header; this is belt+braces. */
          {...(String(tab.url || '').startsWith('/__artifacts/') ? { sandbox: 'allow-scripts allow-forms allow-popups' } : {})}
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />
      </div>
    </div>
  );
}

function ContentTab({ tab }) {
  const t = useT();
  if (tab.format === 'html') {
    return (
      <iframe
        title={tab.title || t('rail.contentFallback')}
        sandbox="allow-scripts"
        srcDoc={tab.body || ''}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    );
  }
  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-white">
      <div className="md-light mx-auto max-w-[860px] px-7 py-6">
        <Markdown>{tab.body || ''}</Markdown>
      </div>
    </div>
  );
}

/* ---------- the session view ------------------------------------------------ */

/**
 * UX1 — the agent's home chat, embedded as the **בית** tab of the agent surface.
 * The same transcript and composer a session has, minus the session chrome (no
 * tab bar, no "claude-code" terminal header): this is a DM with the agent, not a
 * job. It is no longer reachable as a rail row — the surface owns it.
 *
 * The hint chip above the composer is the bridge to the other half of the model:
 * one click turns the human's last message into a real work session born from
 * the agent (`/as` under the hood), which then lives in the Sessions section.
 */
export function AgentHomeChat({ session, events, loading, agent, onOpenSession }) {
  const tt = useT();
  const [busy, setBusy] = useState(false);
  const ask = lastHumanText(events);
  const toWork = async () => {
    if (busy) return;
    if (!ask) return toastError(tt('agent.surface.homeHintEmpty'));
    setBusy(true);
    try {
      const r = await api.post(`/sessions/${session.id}/delegate`, { agent: agent.slug, text: ask, mode: 'as' });
      if (r?.target) onOpenSession?.(r.target);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-agent-home={agent.slug} className="flex min-h-0 flex-1 flex-col">
      <ProgressStrip progress={session.progress} />
      <ListenerChips session={session} />
      <ChatPane
        sessionId={session.id}
        events={events}
        loading={loading}
        working={session.claude?.state === 'working'}
        awaiting={session.claude?.state === 'awaiting-input'}
        action={session.action}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-hair bg-panel px-3.5 pt-1.5 text-[10.5px] text-fgdim">
        <button
          type="button"
          data-home-to-work
          disabled={busy}
          title={tt('agent.surface.homeHintAction')}
          onClick={toWork}
          className="flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] hover:border-ink hover:text-fg disabled:opacity-50"
        >
          <Icon icon={faListCheck} /> {tt('agent.surface.homeHint')}
        </button>
      </div>
      {session.archived ? <ArchivedFooter session={session} /> : <ChatFooter session={session} />}
    </div>
  );
}

export default function SessionView({ session, events, chatLoading, addTabOpen, setAddTabOpen }) {
  const isDesktop = useIsDesktop();
  const { sessions: allSessions } = useStore();
  const hasChildren = allSessions.some((s) => s.metadata?.master === session.id);
  const tabs = resolveTabs(session, hasChildren);
  // The built-in Changes tab isn't a server tab, so its activation is local.
  const [localActive, setLocalActive] = useState(null);
  // A server-side activation (e.g. a skill opening the Changes tab via MCP) is
  // an explicit command — let it override a stale local pick.
  const prevServerActive = useRef(session.activeTabId);
  useEffect(() => {
    if (session.activeTabId !== prevServerActive.current) {
      prevServerActive.current = session.activeTabId;
      setLocalActive(null);
    }
  }, [session.activeTabId]);

  const serverActive =
    session.activeTabId && tabs.some((t) => t.id === session.activeTabId)
      ? session.activeTabId
      : tabs[0].id;
  // A local pick wins until the server activates a (real) tab again.
  const activeTabId =
    localActive && tabs.some((t) => t.id === localActive) ? localActive : serverActive;

  // Auto-focus the composer whenever the chat (session) tab is the active tab —
  // on a session switch or when the user switches to that tab. All tabs stay
  // mounted (hidden via CSS), so this is driven by the active tab, not mount.
  // Defer while the session is awaiting an answer — the permission / question
  // card grabs focus instead and hands it back here once answered. Desktop
  // only: on mobile this pops the on-screen keyboard on every session switch,
  // which is disruptive — mobile users focus the composer explicitly by tapping it.
  const chatTabId = tabs.find((t) => t.type === 'session')?.id;
  useEffect(() => {
    if (isDesktop && activeTabId === chatTabId && session.claude?.state !== 'awaiting-input') {
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, session.id, isDesktop]);

  const onActivate = (tab) => {
    if (tab.id === CHANGES_TAB_ID || tab.id === ORCH_TAB_ID) {
      setLocalActive(tab.id);
    } else {
      setLocalActive(tab.id);
      if (tab.id !== session.activeTabId) {
        api.post(`/sessions/${session.id}/activate-tab`, { tabId: tab.id }).catch(() => {});
      }
    }
  };

  // URL ↔ active tab. The hash carries `#/session/<id>/tab/<tabId>` so a
  // refresh (or shared link) lands on the same tab. replaceState only — tab
  // switches shouldn't pile up history entries.
  useEffect(() => {
    const applyHashTab = () => {
      const m = /^#\/session\/([^/]+)\/tab\/(.+)$/.exec(window.location.hash || '');
      if (!m || decodeURIComponent(m[1]) !== session.id) return;
      const tid = decodeURIComponent(m[2]);
      if (tid !== activeTabId && tabs.some((t) => t.id === tid)) onActivate({ id: tid });
    };
    applyHashTab();
    window.addEventListener('hashchange', applyHashTab);
    return () => window.removeEventListener('hashchange', applyHashTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  useEffect(() => {
    const base = `#/session/${encodeURIComponent(session.id)}`;
    const cur = window.location.hash || '';
    if (cur !== base && !cur.startsWith(`${base}/tab/`)) return; // another view owns the URL
    const want =
      activeTabId === chatTabId ? base : `${base}/tab/${encodeURIComponent(activeTabId)}`;
    if (cur !== want) {
      try { window.history.replaceState(null, '', want); } catch { /* very old engines */ }
    }
  }, [activeTabId, session.id, chatTabId]);

  // Command bus → tab activation (voice: "open the changes tab", "go to terminal").
  // The command handler dispatches a window event after selecting this session;
  // route it through onActivate so local (Changes) and server tabs both work.
  useEffect(() => {
    const onCmd = (e) => {
      if (e.detail?.sessionId && e.detail.sessionId !== session.id) return;
      if (e.detail?.tabId) onActivate({ id: e.detail.tabId });
    };
    window.addEventListener('host:activate-tab', onCmd);
    return () => window.removeEventListener('host:activate-tab', onCmd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.activeTabId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabBar
        session={session}
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={onActivate}
        addOpen={addTabOpen}
        setAddOpen={setAddTabOpen}
      />
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 flex-col bg-bg ${active ? 'flex' : 'hidden'}`}
            >
              {tab.type === 'session' ? (
                <>
                  <TerminalHeader session={session} />
                  <ProgressStrip progress={session.progress} />
                  <ListenerChips session={session} />
                  <ChatPane
                    sessionId={session.id}
                    events={events}
                    loading={chatLoading}
                    working={session.claude?.state === 'working'}
                    awaiting={session.claude?.state === 'awaiting-input'}
                    action={session.action}
                  />
                  {session.archived ? <ArchivedFooter session={session} /> : <ChatFooter session={session} />}
                </>
              ) : tab.type === 'changes' ? (
                <ChangesTab session={session} active={active} />
              ) : tab.type === 'orchestration' ? (
                <OrchestrationTab session={session} active={active} />
              ) : tab.type === 'url' ? (
                <UrlTab tab={tab} active={active} />
              ) : (
                <ContentTab tab={tab} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
