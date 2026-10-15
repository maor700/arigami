import { useState, useRef, useMemo, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api.js';
import { relTime } from '../lib/time.js';
import { toastError } from '../lib/toast.js';
import { errText } from '../lib/errors.js';
import { useStore, listenersForSession, fullCapabilities, ensureFullCapabilities, getDraft, setDraft, setLastSent, interruptSession, openScreenRequest, screenPanelOpen, setScreenPanel, setChatMode, needsAttention } from '../lib/store.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { chatModeOf } from '../lib/chatMode.js';
import { engineLabel, engineTermName } from '../lib/engines.js';
import { providerForEngine, providerOf } from '../lib/providers.js';
import { tabSrc } from '../lib/hostUrl.js';
import { extOfTab, findExtension, extSlashItems } from '../lib/ext.js';
import { createExtBridge } from '../lib/ext-bridge.js';
import { setDictationSink, appendDictation } from '../lib/voice.js';
import { ChatFooter } from './Composer.jsx';
import { HARD_CAP, shouldStream, fileToBase64, uploadAttachment, pendingAttachment, applyUploadEvent, isAlreadyAttached } from '../lib/attachments.js';
import { Dot, TriggerTag } from './ui.jsx';
import { t, useT, dirOf, currentLang } from '../lib/i18n.js';
import { currentTheme, usePrefs, setPrefs } from '../lib/prefs.js';
import { CHAT_TEXT, stepChatText } from '../lib/chatText.js';
import { statusLabel } from '../lib/status.js';
import { Icon } from '../lib/icons.js';
import { ALargeSmall, Archive, Check, CircleUser, Eye, ListChecks, Monitor, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { Badge, StatusDot, badgeVariants } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Label } from './ui/label.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.jsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.jsx';
import { Tip } from './ui/tooltip.jsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from './ui/dropdown-menu.jsx';
import { faArrowUp, faBoxArchive, faCaretDown, faCaretUp, faCheck, faCircleUser, faDisplay, faEye, faFile, faGripVertical, faHourglassHalf, faImage, faListCheck, faPaperclip, faPlay, faReply, faRotateRight, faStop, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import TabBar from './TabBar.jsx';
import ChatPane from './ChatPane.jsx';
import ChangesTab from './ChangesTab.jsx';
import OrchestrationTab from './OrchestrationTab.jsx';
import { Truncate } from './Truncate.jsx';
import { SlashPalette, CapabilitiesPanel, buildSlashItems, MentionPalette, TeamPanel } from './SlashCommands.jsx';
import { useSkills, skillSlashItems, agentCommandItems, resolveSubmission, mentionQuery, completeMention, buildMentionItems, lastHumanText } from '../lib/composer.js';
import { ProcessChip, BgProcessesPanel } from './BgProcesses.jsx';
import TermControls from './TermControls.jsx';
import LadderBadge from './LadderBadge.jsx';
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

// The ONE status indicator of the header: a neutral chip with a status dot —
// amber (pulsing) when it is waiting for you, green working, red dead, grey idle.
function StatusChip({ session }) {
  const t = useT();
  const cState = session.claude?.state;
  // A restart in flight beats the free-form status — it's the live signal the
  // user is waiting on (upsertSession toasts when it completes).
  const restarting = cState === 'restarting';
  // B28: a waiting request_action / request_screen / question is the headline, not the stale free-form status.
  const attention = !restarting && needsAttention(session);
  const status = restarting ? t('rail.statusRestartingDots') : attention ? t('status.needsYou') : statusLabel(session.status || cState) || t('rail.statusIdle');
  const awaiting = !restarting && (attention || /review/i.test(session.status || '') || cState === 'awaiting-input');
  const dot = awaiting ? 'warn' : cState === 'working' ? 'ok' : cState === 'dead' ? 'err' : 'idle';
  return (
    <Badge variant="outline" className="shrink-0 text-foreground" data-session-status={restarting ? 'restarting' : awaiting ? 'needs-you' : cState || 'idle'}>
      {restarting ? <span className="host-spinner size-2.5" /> : <StatusDot status={dot} pulse={awaiting} />}
      <span className="max-w-[10rem] truncate">{String(status).toLowerCase()}</span>
    </Badge>
  );
}

// Which account this session runs on. Reads the session's pinned accountId (or
// the active account of the PROVIDER its engine consumes, if unpinned) so
// switching accounts is VISIBLE per session — otherwise a switch looks like it
// did nothing. A codex session never shows a Claude login here. D11: it lives
// in the header's "…" menu now (one click there opens the accounts page).
function useSessionAccount(session) {
  const { accounts } = useStore();
  const list = accounts?.accounts || [];
  const provider = providerForEngine(session.engine);
  const pinned = session.claude?.accountId;
  const pinnedAcc = pinned ? list.find((a) => a.id === pinned) : null;
  return (pinnedAcc && providerOf(pinnedAcc) === provider ? pinnedAcc : null) || list.find((a) => a.active && providerOf(a) === provider) || null;
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
      <Tip label={listeners.length > 1 ? t('rail.listenersWatching', { n: listeners.length }) : t('rail.listenerWatching', { n: listeners.length })}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          aria-label={listeners.length > 1 ? t('rail.listenersWatching', { n: listeners.length }) : t('rail.listenerWatching', { n: listeners.length })}
          className={`shrink-0 gap-1 px-1.5 sm:hidden ${errored ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {errored ? <TriangleAlert /> : <Eye />}
          <span className="text-xs tabular-nums">{listeners.length}</span>
        </Button>
      </Tip>
      {open && <ListenersPanel session={session} onClose={() => setOpen(false)} />}
    </>
  );
}

// Auto (follow the conversation) | English segmented control, reused in the
// summary popover's empty state (pre-choice) and footer (post-generation).
function LangToggle({ value, onChange, disabled }) {
  const t = useT();
  return (
    <span role="group" aria-label={t('rail.summaryLanguage')} className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
      {[['auto', t('rail.auto')], ['he', t('rail.hebrew')], ['en', t('rail.english')]].map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => value !== key && onChange(key)}
          disabled={disabled}
          className={`h-5 cursor-pointer rounded-sm px-1.5 text-2xs leading-none outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 coarse:h-9 coarse:px-3 ${
            value === key ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={t('rail.statusSummary')}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-summary-chip
            aria-label={t('rail.statusSummary')}
            className={`shrink-0 gap-1.5 px-2 ${on ? 'text-foreground' : 'text-muted-foreground'} aria-expanded:bg-muted aria-expanded:text-foreground`}
          >
            {busy ? <span className="host-spinner size-3" /> : <ListChecks />}
            <span className="hidden sm:inline">{t('rail.summary')}</span>
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-[21.25rem] max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium text-foreground">{t('rail.statusSummary')}</span>
          <span className="ms-auto flex items-center gap-0.5">
            {on && (
              <Tip label={t('rail.updateNow')}>
                <Button variant="ghost" size="icon-xs" onClick={updateNow} disabled={busy} aria-label={t('rail.updateNow')} className="text-muted-foreground">
                  <RefreshCw className={busy ? 'animate-spin' : ''} />
                </Button>
              </Tip>
            )}
            <Button variant="ghost" size="icon-xs" onClick={() => setOpen(false)} aria-label={t('rail.close')} className="text-muted-foreground">
              <X />
            </Button>
          </span>
        </div>
        <div className="max-h-[42vh] overflow-y-auto px-3 py-2.5">
          {!on ? (
            <div className="text-xs text-muted-foreground">
              <p className="mb-2.5">{t('rail.summaryIntro')}</p>
              <div className="mb-2.5 flex items-center gap-2">
                <span>{t('rail.language')}</span>
                <LangToggle value={pendingLang} onChange={setPendingLang} />
              </div>
              <Button variant="default" onClick={enable}>{t('rail.summarizeConversation')}</Button>
            </div>
          ) : busy && !summary.text ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="host-spinner size-3" /> {t('rail.generating')}</div>
          ) : (
            <div className="md text-sm" dir="auto">
              <Markdown remarkPlugins={[remarkGfm]}>{summary.text || '…'}</Markdown>
            </div>
          )}
        </div>
        {on && (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Checkbox id={`sum-auto-${sid}`} checked={!!summary.autoUpdate} onCheckedChange={toggleAuto} />
              <Label htmlFor={`sum-auto-${sid}`} className="cursor-pointer text-xs font-normal">{t('rail.autoUpdateEachTurn')}</Label>
            </span>
            {/* Output language: Auto (follow the conversation) | English */}
            <span className="ms-auto">
              <LangToggle value={lang} onChange={setLang} disabled={busy} />
            </span>
          </div>
        )}
        {on && (
          <div className="border-t border-border px-3 py-1.5 text-end">
            <Button variant="link" size="xs" onClick={turnOff} className="text-destructive">{t('rail.turnOff')}</Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// 🖥 "Machine" — toggles the session side panel with the live shared desktop
// (ScreenSidePanel.jsx). Amber dot (pulsing) while a request_screen is waiting on you.
function MachineChip({ session }) {
  const t = useT();
  const s = useStore();
  if (!s.config?.screen?.enabled) return null;
  const open = screenPanelOpen(s, session.id);
  const pending = !!openScreenRequest(s, session.id);
  return (
    <Tip label={open ? t('screen.hidePanel') : t('screen.showPanel')}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setScreenPanel(!open)}
        aria-label={open ? t('screen.hidePanel') : t('screen.showPanel')}
        aria-pressed={open}
        data-machine-chip
        className={`hidden shrink-0 gap-1.5 px-2 md:inline-flex ${open ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
      >
        {pending ? <StatusDot status="warn" pulse /> : <Monitor />}
        <span>{t('screen.panelTitle')}</span>
      </Button>
    </Tip>
  );
}

/**
 * UX1 — a session born from an agent is a JOB, not the agent. It keeps the
 * agent's face, and says so in words: "Work session · born from <agent>", linking back
 * to the agent surface. The agent's own home chat never renders this header (it
 * is the Home tab of the agent surface instead).
 */
export function BornFromChip({ session, className = '' }) {
  const tt = useT();
  const { agents } = useStore();
  const slug = session.metadata?.agent;
  if (!slug || session.metadata?.agentHome) return null;
  const agent = (agents || []).find((a) => a.slug === slug) || { slug, name: slug };
  const name = agent.name || slug;
  return (
    <Tip label={tt('session.bornFromTitle', { name })}>
      <button
        type="button"
        data-born-from={slug}
        onClick={(e) => { e.stopPropagation(); openAgent(slug); }}
        className={`${badgeVariants()} max-w-[14rem] cursor-pointer hover:text-foreground ${className}`}
      >
        <AgentAvatar agent={agent} size={12} />
        <span className="truncate">{tt('session.bornFrom', { name })}</span>
      </button>
    </Tip>
  );
}

/* ---------- SIMPLE1: chat view (Simple | Terminal) ---------------------------- */

// Per-session, persisted in metadata.chatMode (the host reads it every turn).
// The Simple default for an unset session on a phone-width viewport is what
// the human actually sees — persist it, so the model answers briefly too.
// D9: the control is a radio group inside the header's "…" menu now; the
// effect below keeps running because the header is always mounted.
function useChatModeDefault(session) {
  const isDesktop = useIsDesktop();
  const stored = session.metadata?.chatMode;
  useEffect(() => {
    if (!isDesktop && stored == null && !session.archived) setChatMode({ id: session.id }, 'simple');
  }, [session.id, isDesktop, stored, session.archived]);
  return chatModeOf(session, isDesktop);
}

// The radio items themselves; `M` carries the menu parts (a test renders them
// with plain stand-ins, the header passes the DropdownMenu ones).
export function ChatModeItems({ M, session, mode }) {
  const t = useT();
  return (
    <M.Group aria-label={t('rail.chatMode')} data-chat-mode-toggle={mode}>
      <M.Label>{t('rail.chatMode')}</M.Label>
      <M.RadioGroup value={mode} onValueChange={(v) => { if (v !== mode) setChatMode(session, v); }}>
        <M.RadioItem value="simple" data-chat-mode-btn="simple" aria-pressed={mode === 'simple'}>{t('rail.chatModeSimple')}</M.RadioItem>
        <M.RadioItem value="full" data-chat-mode-btn="full" aria-pressed={mode === 'full'}>{t('rail.chatModeTerminal')}</M.RadioItem>
      </M.RadioGroup>
    </M.Group>
  );
}

// "Text size ▸ smaller / default / larger", the current px beside the label.
// Smaller/larger keep the menu open so a few steps are one visit.
function ChatTextSizeSub() {
  const t = useT();
  const px = usePrefs().chatTextSize;
  const step = (dir) => (e) => { e.preventDefault(); setPrefs({ chatTextSize: stepChatText(px, dir) }); };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-chat-text-size-menu>
        <ALargeSmall /> {t('chat.textSize')}
        <span dir="ltr" className="ms-auto text-xs tabular-nums text-muted-foreground">{px}px</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem disabled={px <= CHAT_TEXT.min} onSelect={step('down')}>{t('chat.textSizeSmaller')}<DropdownMenuShortcut dir="ltr">⌘−</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem disabled={px === CHAT_TEXT.def} onSelect={() => setPrefs({ chatTextSize: CHAT_TEXT.def })}>{t('chat.textSizeDefault', { px: CHAT_TEXT.def })}<DropdownMenuShortcut dir="ltr">⌘0</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem disabled={px >= CHAT_TEXT.max} onSelect={step('up')}>{t('chat.textSizeLarger')}<DropdownMenuShortcut dir="ltr">⌘+</DropdownMenuShortcut></DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// The "…" menu: everything that is not state and not daily. Each item is two
// clicks away (… then the item).
function HeaderMenu({ session, mode, meta, onEdit, onArchive, onRestore, setAddTabOpen }) {
  const t = useT();
  const account = useSessionAccount(session);
  const accountName = account ? account.email || account.label || t('rail.accountFallback') : null;
  return (
    <DropdownMenu>
      <Tip label={t('rail.sessionActions')}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('rail.sessionActions')} data-header-menu className="shrink-0 text-muted-foreground aria-expanded:text-foreground">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="text-2xs text-muted-foreground">{engineTermName(session.engine)}</span>
          {meta && <bdi className="truncate text-xs text-foreground">{meta}</bdi>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onEdit && (
          <DropdownMenuItem onSelect={() => onEdit(session)}>
            <Pencil /> {t('rail.editDetails')}
          </DropdownMenuItem>
        )}
        {setAddTabOpen && (
          <DropdownMenuItem onSelect={() => setAddTabOpen(true)}>
            <Plus /> {t('rail.openUrlAsTab')}
            <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {accountName && (
          <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent('host:open-accounts'))}>
            <CircleUser /> <span className="min-w-0 truncate">{t('rail.runsOn', { name: accountName })}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <ChatModeItems
          M={{ Group: DropdownMenuGroup, Label: DropdownMenuLabel, RadioGroup: DropdownMenuRadioGroup, RadioItem: DropdownMenuRadioItem }}
          session={session}
          mode={mode}
        />
        <ChatTextSizeSub />
        {(session.archived ? onRestore : onArchive) && <DropdownMenuSeparator />}
        {session.archived
          ? onRestore && (
            <DropdownMenuItem onSelect={() => onRestore(session)}>
              <RotateCcw /> {t('rail.restoreSession')}
            </DropdownMenuItem>
          )
          : onArchive && (
            <DropdownMenuItem onSelect={() => onArchive(session)}>
              <Archive /> {t('rail.archiveSession')}
            </DropdownMenuItem>
          )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TerminalHeader({ session, onEdit, onArchive, onRestore, setAddTabOpen }) {
  const [procPanel, setProcPanel] = useState(false);
  const mode = useChatModeDefault(session);
  // Same derivation the rail row uses (Rail.jsx Row) — the header had no
  // session identifier at all when the rail (the only other place showing it)
  // is collapsed behind the mobile hamburger.
  const name = session.metadata?.ticket || session.title || session.id;
  const meta = [session.metadata?.ticket, session.metadata?.branch].filter(Boolean).join(' · ');
  return (
    <div data-engine={engineTermName(session.engine)} className="flex min-h-11 shrink-0 items-center gap-x-2 border-b border-border bg-background px-3 text-sm text-foreground md:px-4">
      <Dot color={session.color} size={9} />
      <Tip label={meta || undefined}>
        <span className="min-w-0 shrink">
          <Truncate text={name} className="block text-sm font-medium text-foreground" />
        </span>
      </Tip>
      <StatusChip session={session} />
      <BornFromChip session={session} />
      {/* LADDER1: "running on haiku · fable's quota resets at 18:50" while on a weaker rung */}
      <LadderBadge session={session} />
      {session.metadata?.fromTriggerName && (
        <TriggerTag
          name={session.metadata.fromTriggerName}
          className="hidden max-w-[10rem] text-xs text-muted-foreground sm:inline-flex"
        />
      )}
      <div className="ms-auto flex shrink-0 items-center gap-0.5">
        <ProcessChip session={session} onClick={() => setProcPanel(true)} />
        <ListenersChipCompact session={session} />
        <SummaryChip session={session} />
        <MachineChip session={session} />
        <TermControls session={session} />
        <HeaderMenu session={session} mode={mode} meta={meta} onEdit={onEdit} onArchive={onArchive} onRestore={onRestore} setAddTabOpen={setAddTabOpen} />
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
    <div className="flex shrink-0 items-stretch border-b border-border bg-background">
      {steps.map((step, i) => {
        const st = step.state || 'pending';
        return (
          <div
            key={i}
            className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 sm:px-4 sm:py-2 ${
              i < steps.length - 1 ? 'border-e border-border' : ''
            } ${st === 'active' ? 'bg-muted/60' : ''}`}
          >
            {st === 'done' ? (
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-ok">
                <Check className="size-3" />
              </span>
            ) : st === 'active' ? (
              <span className="host-spinner size-4 shrink-0" />
            ) : st === 'error' ? (
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-destructive">
                <X className="size-3" />
              </span>
            ) : (
              <span className="size-4 shrink-0 rounded-full border border-dashed border-input" />
            )}
            {/* on phones only the active step keeps its label — the others are
                just state icons, so five steps never overflow the viewport */}
            <span
              className={`truncate text-xs ${
                st === 'pending' ? 'text-muted-foreground' : 'text-foreground'
              } ${st === 'active' ? 'font-medium' : 'hidden sm:block'}`}
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

// WAFILT1: a WhatsApp listener's contact filter, as the host stored it —
// [{raw, jids, name}]. A legacy single `contact`/`from` string is shown as a
// one-element list, mirroring the host's read-side normalisation.
export function listenerContacts(l) {
  const p = l?.params || {};
  if (Array.isArray(p.contacts) && p.contacts.length) {
    return p.contacts.map((c) => (typeof c === 'string' ? { raw: c, jids: [c], name: null } : c)).filter((c) => c && c.raw);
  }
  const legacy = p.contact ?? p.from;
  return typeof legacy === 'string' && legacy.trim() ? [{ raw: legacy.trim(), jids: [legacy.trim()], name: null }] : [];
}

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
    <div className="hidden shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-background px-4 py-1.5 sm:flex">
      <span className="text-xs text-muted-foreground">{t('rail.watching')}</span>
      {listeners.map((l) => {
        const errored = l.status === 'errored';
        const contacts = listenerContacts(l);
        return (
          <Tip
            key={l.id}
            label={contacts.length ? `${t('rail.contacts')} ${contacts.map((c) => `${c.name || c.raw} (${(c.jids || []).join(', ')})`).join('; ')}` : t('rail.openListenerDetails')}
          >
            <span aria-label={contacts.length ? `${t('rail.contacts')} ${contacts.map((c) => `${c.name || c.raw} (${(c.jids || []).join(', ')})`).join('; ')}` : undefined} className={`${badgeVariants({ variant: 'outline' })} h-6 gap-1.5 ps-2 pe-1 ${errored ? 'text-destructive' : 'text-foreground'}`}>
              <button type="button" onClick={() => setOpenId(l.id)} className="inline-flex cursor-pointer items-center gap-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ring">
                {errored ? <TriangleAlert /> : <Eye />}
                <span className="font-medium">{l.label}</span>
                {l.firedCount > 0 && !errored && <span className="text-muted-foreground">{t('rail.firedCount', { n: l.firedCount })}</span>}
              </button>
              <Tip label={t('rail.cancelListener')}>
                <button
                  type="button"
                  onClick={(e) => cancel(l.id, e)}
                  aria-label={t('rail.cancelListener')}
                  className="flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </Tip>
            </span>
          </Tip>
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showClose={false} className="flex h-[78vh] w-[min(57.5rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Eye className="size-4 text-muted-foreground" />
          <DialogTitle>{t('rail.listeners')}</DialogTitle>
          <DialogDescription className="text-xs">{t('rail.nWatching', { n: list.length })}</DialogDescription>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('rail.close')} className="ms-auto text-muted-foreground">
            <X />
          </Button>
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
                  <span className="ms-auto font-mono text-[11px] md:text-[9.5px] text-fgdim">{l.status}</span>
                </div>
                <span className="font-mono text-[11px] md:text-[9.5px] text-fgdim">
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
                    <span className="font-mono text-[11.5px] md:text-[10px] text-[#8a8a8a]">{sel.status}</span>
                    {sel.status !== 'stopped' && (
                      <button
                        type="button"
                        onClick={() => cancel(sel.id)}
                        className="ms-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-[1.5px] border-danger bg-transparent px-2.5 py-1 text-[11.5px] md:text-[10.5px] font-bold text-danger hover:bg-danger/10"
                      >
                        <Icon icon={faStop} className="text-[11px] md:text-[9px]" /> {t('rail.cancelLower')}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11.5px] md:text-[10px] text-[#9aa0a6]">
                    <span>{t('rail.firesOn')} <span className="text-[#cfcfcf]">{(sel.fireOn || []).join(', ') || '—'}</span></span>
                    <span>{t('rail.every')} <span className="text-[#cfcfcf]">{sel.intervalSec}s</span></span>
                    <span>{t('rail.lastPoll')} <span className="text-[#cfcfcf]">{fmtAgo(detail?.lastPolledAt ?? sel.lastPolledAt)}</span></span>
                    <span>{t('rail.nextPoll')} <span className="text-[#cfcfcf]">{fmtIn(detail?.nextPollAt ?? sel.nextPollAt)}</span></span>
                    <span>{t('rail.firedLabel')} <span className="text-[#cfcfcf]">{detail?.firedCount ?? sel.firedCount ?? 0}×</span></span>
                    <span>{t('rail.expires')} <span className="text-[#cfcfcf]">{fmtIn(sel.ttlAt)}</span></span>
                    {listenerContacts(sel).length > 0 && (
                      <span className="col-span-2">{t('rail.contacts')}{' '}
                        {listenerContacts(sel).map((c) => (
                          <span key={c.raw} className="me-1.5 inline-block rounded-full border border-white/15 px-1.5 text-[#cfcfcf]" title={`${c.raw} → ${(c.jids || []).join(', ')}`}>
                            {c.name || c.raw}
                          </span>
                        ))}
                      </span>
                    )}
                    {(detail?.lastError ?? sel.lastError) && (
                      <span className="col-span-2 text-danger">{t('rail.lastError')} {detail?.lastError ?? sel.lastError}</span>
                    )}
                  </div>
                </div>
                <div className="border-b border-white/10 px-3.5 py-1.5 font-mono text-[11px] md:text-[9.5px] tracking-wide text-[#6a6a6a] uppercase">
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
      </DialogContent>
    </Dialog>
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
      <Button variant="primary" onClick={restore} disabled={busy} className="ms-auto">
        {busy ? t('rail.restoring') : t('rail.restoreSession')}
      </Button>
    </div>
  );
}

/* ---------- url / content tabs --------------------------------------------- */

function UrlTab({ tab, active, session }) {
  const t = useT();
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const { extensions } = useStore();

  // EXT — an extension tab is a url tab the host stamped with `ext`/`extTab`
  // (server/state.ts addTab). It gets the artifact sandbox (opaque origin: no
  // cookie, no /__api) plus the postMessage bridge, which is the ONLY way it can
  // reach the session, and only as far as its manifest permissions allow.
  const extName = extOfTab(tab);
  const extRecord = useMemo(() => findExtension(extensions, extName), [extensions, extName]);
  // …unless the human granted it the TRUSTED tier, in which case the host also
  // omits the CSP sandbox header and the tab is same-origin with the cockpit.
  // This is required by extensions that embed host-proxied URLs. Fail-closed:
  // an extension we have no record for yet is sandboxed,
  // and the iframe is remounted if that answer ever flips, because `sandbox`
  // only takes effect at navigation.
  const extSandboxed = !!extName && extRecord?.trusted !== true;
  const iframeRef = useRef(null);
  const bridgeRef = useRef(null);
  // EXT3 recovery: the page's own <script src> is fetched from an opaque origin
  // and therefore cookie-less — it rides the asset token in the entry HTML's
  // <base>. A token that went stale while the tab sat open (24h TTL) makes that
  // script 401, so the SDK never says hello. Remounting the iframe re-fetches
  // the entry HTML (a same-site navigation: the cookie IS sent) and mints a
  // fresh token. Once per mount, so a genuinely broken page doesn't loop.
  const helloRef = useRef(false);
  const extRetriedRef = useRef(false);
  const helloTimerRef = useRef(null);
  // Read live by the bridge, so a settings change or a reload lands without
  // tearing the bridge (and the iframe's own state) down.
  const liveRef = useRef(null);
  liveRef.current = { ext: extRecord, session, tabId: tab.id };

  useEffect(() => {
    if (!extName || !session?.id) return;
    const bridge = createExtBridge({
      sessionId: session.id,
      tabId: tab.id,
      extension: extName,
      getWindow: () => iframeRef.current?.contentWindow || null,
      getPermissions: () => liveRef.current?.ext?.permissions || [],
      // Read live, not captured: `sendPrompt` mode 'auto' routes on whether the
      // session is idle AT THE MOMENT OF THE CALL.
      getSessionState: () => liveRef.current?.session?.claude?.state || '',
      getContext: () => {
        const l = liveRef.current || {};
        return {
          sessionId: l.session?.id || '',
          tabId: l.tabId || '',
          extension: extName,
          apiVersion: l.ext?.apiVersion ?? 1,
          agent: l.session?.metadata?.agent || null,
          cwd: l.session?.cwd || '',
          settings: l.ext?.settings || {},
          lang: currentLang(),
          theme: currentTheme(),
          permissions: l.ext?.permissions || [],
        };
      },
      // targetOrigin '*' is forced: the page has an OPAQUE origin (sandbox
      // without allow-same-origin) and cannot be named. Inbound messages are
      // authenticated the other way round — by contentWindow identity.
      post: (msg) => {
        try { iframeRef.current?.contentWindow?.postMessage(msg, '*'); } catch { /* iframe gone */ }
      },
      onHello: () => { helloRef.current = true; },
    });
    bridgeRef.current = bridge;
    const onMsg = (e) => bridge.onMessage(e);
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(helloTimerRef.current);
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [extName, session?.id, tab.id]);
  // A live theme switch must reach the tab: it is a separate document that
  // cannot see our CSS, so without this it keeps the palette it booted with.
  // Re-sending the context is enough — the SDK treats init as idempotent.
  const extPrefs = usePrefs();
  useEffect(() => { bridgeRef.current?.sendInit?.(); }, [extPrefs.theme]);

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
  const src = tabSrc(tab.url);
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
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] md:text-[10px] text-fgdim">{tab.url}</span>
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
      </div>
      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/80 text-[11px] text-fgdim">
            <span className="host-spinner h-3.5 w-3.5" /> {t('rail.loadingPreview')}
          </div>
        )}
        <iframe
          /* the tier is part of the key: `sandbox` is only read at navigation,
             so a grant/revoke that lands while the tab is open must remount */
          key={`${reloadKey}:${extSandboxed ? 'sandboxed' : 'trusted'}`}
          ref={iframeRef}
          title={tab.title || t('rail.tabFallback')}
          src={src}
          onLoad={() => {
            setLoading(false);
            // EXT: hand the tab its context the moment it exists. The SDK also
            // says hello until it hears back, so a late-evaluating script is
            // covered too — init is idempotent.
            bridgeRef.current?.sendInit();
            if (!extName) return;
            clearTimeout(helloTimerRef.current);
            helloTimerRef.current = setTimeout(() => {
              if (helloRef.current || extRetriedRef.current) return;
              extRetriedRef.current = true;
              setReloadKey((k) => k + 1);
            }, 4000);
          }}
          /* Published artifacts (A1) and SANDBOXED extension tabs (EXT) run with
             an opaque origin — no allow-same-origin — so a page can't call
             /__api as the cockpit. The host also sends a CSP sandbox header;
             this is belt+braces. A TRUSTED extension tab gets neither, by
             design, exactly like /__ticket or a proxied url tab. */
          {...(extSandboxed || String(tab.url || '').startsWith('/__artifacts/')
            ? { sandbox: 'allow-scripts allow-forms allow-popups' }
            : {})}
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
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-bg">
      <div className="md-light mx-auto max-w-[860px] px-7 py-6">
        <Markdown>{tab.body || ''}</Markdown>
      </div>
    </div>
  );
}

/* ---------- the session view ------------------------------------------------ */

/**
 * UX1 — the agent's home chat, embedded as the **Home** tab of the agent surface.
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
  const isDesktop = useIsDesktop();
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
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-hair px-3.5 py-1">
        <TermControls session={session} />
      </div>
      <ProgressStrip progress={session.progress} />
      <ListenerChips session={session} />
      <ChatPane
        sessionId={session.id}
        events={events}
        loading={loading}
        working={session.claude?.state === 'working'}
        awaiting={session.claude?.state === 'awaiting-input'}
        action={session.action}
        mode={chatModeOf(session, isDesktop)}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-hair bg-panel px-3.5 pt-1.5 text-[11.5px] md:text-[10.5px] text-fgdim">
        <button
          type="button"
          data-home-to-work
          disabled={busy}
          title={tt('agent.surface.homeHintAction')}
          onClick={toWork}
          className="flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[11.5px] md:text-[10px] hover:border-ink hover:text-fg disabled:opacity-50"
        >
          <Icon icon={faListCheck} /> {tt(isDesktop ? 'agent.surface.homeHint' : 'agent.surface.homeHintTouch')}
        </button>
      </div>
      {session.archived ? <ArchivedFooter session={session} /> : <ChatFooter session={session} />}
    </div>
  );
}

// `homeAgent` (AGENT-PAGE): the session is the agent's HOME chat embedded in
// the agent surface — the session pane renders AgentHomeChat (no terminal
// header) and the TabBar is `embedded`; every other tab (desktop, artifacts,
// url, changes…) is the same component a work session gets, so the human can
// see what the agent opened.
export default function SessionView({ session, events, chatLoading, addTabOpen, setAddTabOpen, homeAgent = null, onOpenSession, onEdit, onArchive, onRestore }) {
  const isDesktop = useIsDesktop();
  const tt = useT();
  const { sessions: allSessions } = useStore();
  const hasChildren = allSessions.some((s) => s.metadata?.master === session.id);
  const tabs = homeAgent
    ? resolveTabs(session, hasChildren).map((tb) => (tb.type === 'session' ? { ...tb, title: tt('agent.surface.homeTitle') } : tb))
    : resolveTabs(session, hasChildren);
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

  // ChatPane's large-diff card asks to jump to the Changes tab.
  useEffect(() => {
    const onOpen = (ev) => {
      if (ev.detail?.sessionId && ev.detail.sessionId !== session.id) return;
      if (tabs.some((t) => t.id === CHANGES_TAB_ID)) setLocalActive(CHANGES_TAB_ID);
    };
    window.addEventListener('host:open-changes', onOpen);
    return () => window.removeEventListener('host:open-changes', onOpen);
  });

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
        embedded={!!homeAgent}
      />
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 flex-col bg-bg ${active ? 'flex' : 'hidden'}`}
            >
              {tab.type === 'session' && homeAgent ? (
                <AgentHomeChat session={session} agent={homeAgent} events={events} loading={chatLoading} onOpenSession={onOpenSession} />
              ) : tab.type === 'session' ? (
                <>
                  <TerminalHeader session={session} onEdit={onEdit} onArchive={onArchive} onRestore={onRestore} setAddTabOpen={setAddTabOpen} />
                  <ProgressStrip progress={session.progress} />
                  <ListenerChips session={session} />
                  <ChatPane
                    sessionId={session.id}
                    events={events}
                    loading={chatLoading}
                    working={session.claude?.state === 'working'}
                    awaiting={session.claude?.state === 'awaiting-input'}
                    action={session.action}
                    mode={chatModeOf(session, isDesktop)}
                  />
                  {session.archived ? <ArchivedFooter session={session} /> : <ChatFooter session={session} />}
                </>
              ) : tab.type === 'changes' ? (
                <ChangesTab key={session.id} session={session} active={active} />
              ) : tab.type === 'orchestration' ? (
                <OrchestrationTab session={session} active={active} />
              ) : tab.type === 'url' ? (
                <UrlTab tab={tab} active={active} session={session} />
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
