import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Zap,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  Folder,
  FolderPlus,
  FolderTree,
  Globe,
  GripVertical,
  Info,
  ListChecks,
  ListFilter,
  LogOut,
  Monitor,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RotateCcw,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  Rows3,
  Layers,
} from 'lucide-react';
import { statusLabel } from '../lib/status.js';
import { relTime, fmtDateTime } from '../lib/time.js';
import { hasOpenScreenRequest, needsAttention, setScreenModal, signOut, useStore } from '../lib/store.js';
import { usePrefs, setPrefs, PREF_LIMITS } from '../lib/prefs.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { Dot, TriggerTag } from './ui.jsx';
import { Logo } from './Logo.jsx';
import { useShell, openMachines } from '../lib/shell.js';
import {
  CreateFolderDialog,
  FolderNameDialog,
  DeleteFolderDialog,
  MakeProjectDialog,
} from './Dialogs.jsx';
import { Truncate } from './Truncate.jsx';
import { AgentAvatar } from './AgentCard.jsx';
import LadderBadge from './LadderBadge.jsx';
import { openAgent, deleteAgentConfirmed } from './DelegatedLine.jsx';
import { untilTime, nextCronFor } from './RoutineList.jsx';
import { UsageMini } from './Usage.jsx';
import { MachineMini } from './Machine.jsx';
import { DEFAULT_ENGINE, normalizeEngine } from '../lib/engines.js';
import { snapshotUsage } from '../lib/providers.js';
import { useT, dirOf } from '../lib/i18n.js';
import { useIsDesktop } from '../lib/useMedia.js';
import MicButton from './MicButton.jsx';
import { Badge, StatusDot, badgeVariants } from './ui/badge.jsx';
import { cn } from '../lib/utils.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Kbd } from './ui/kbd.jsx';
import { Tip } from './ui/tooltip.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.jsx';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu.jsx';

const STATUS_ORDER = ['Booting', 'In Progress', 'In Review', 'Blocked', 'Completed'];

// RES1 §4 — the supervisor's health dot. The badges beside it already say
// "working" and "needs you"; what the dot adds is the two states nothing else
// showed: a session the host is failing to recover (red) and one that has gone
// quiet with work still owed (also red — it is not fine, it is stuck).
// The dot is one of the tiny status dots of the token layer: info / warn / err.
const HEALTH_STATUS = { blue: 'info', amber: 'warn', red: 'err' };


function HealthDot({ health }) {
  const t = useT();
  // Grey means "nothing to report" — a dot on every row was noise, so only the
  // states the dot exists for (blue/amber/red) render.
  if (!health || !health.dot || health.dot === 'grey') return null;
  const status = HEALTH_STATUS[health.dot];
  if (!status) return null;
  // An escalated session is not one the host is still working on — it is one it
  // gave up on, which is a different thing to tell the human.
  const label = health.escalated ? t('waiting.what.system') : t(`rail.health.${health.state}`);
  return (
    <Tip label={`${label} · ${health.reason}`}>
      <span aria-label={label} className="inline-flex shrink-0 items-center">
        <StatusDot status={status} />
      </span>
    </Tip>
  );
}

// RES1 §4 — a waiting item is a small, static badge on the row it actually
// belongs to (agent rows, collapsed folders and the collapsed Team header roll
// it up as a count). It covers the kinds a session row has no other indicator
// for (setup, review, merge, budget, system). Neutral chip + an amber dot:
// amber is the one colour reserved for "waiting for you". Shows the count only
// once there is more than one thing waiting.
function WaitingBadge({ items, t }) {
  if (!items?.length) return null;
  const title = items
    .map((w) => `${t(`waiting.what.${w.kind}`)} · ${t(`waiting.do.${w.unblock}`)}`)
    .join('\n');
  return (
    <Tip label={<span className="whitespace-pre-line">{title}</span>}>
      <Badge status="warn" className="tabular-nums" data-waiting-badge="">
        {items.length > 1 ? items.length : '!'}
      </Badge>
    </Tip>
  );
}

// RAIL1 — a per-child rollup that survives a collapsed folder: one dot per
// kid (capped), coloured by its own state, so the header still answers "what's
// happening in here" without opening it. Needs-attention is amber, working is
// the info blue, anything else is the quiet idle dot.
function StateDots({ kids }) {
  if (!kids?.length) return null;
  const shown = kids.slice(0, 8);
  return (
    <span className="flex items-center gap-[0.1875rem]" aria-hidden="true">
      {shown.map((s) => {
        const attn = needsAttention(s);
        const working = ['working', 'restarting'].includes(s.claude?.state);
        return <StatusDot key={s.id} status={attn ? 'warn' : working ? 'info' : 'idle'} className="size-[0.3125rem]" />;
      })}
    </span>
  );
}

// RAIL1 §4/§5 — "out of context, say the parent". A small chip naming
// whichever folder/controller a session belongs to, shown wherever a row
// renders OUTSIDE its own group (search, grouped-by-status, a PM child sitting
// free at root) — `info` comes from `parentInfoFor`. Clicking it selects the
// parent (a plain folder with no controller has nothing selectable, so it
// renders as inert text instead of a button).
function ParentChip({ info, onSelect, t }) {
  if (!info) return null;
  const cls = 'max-w-[8.125rem] cursor-default';
  const inner = (
    <>
      <Dot color={info.color} size={7} className="shrink-0" />
      <span className="min-w-0 truncate">{info.label}</span>
    </>
  );
  if (!info.targetId) {
    return (
      <Tip label={t('rail.parentOf', { name: info.label })}>
        <Badge className={cls}>{inner}</Badge>
      </Tip>
    );
  }
  return (
    <Tip label={t('rail.parentOf', { name: info.label })}>
      <button
        type="button"
        aria-label={t('rail.parentOf', { name: info.label })}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(info.targetId);
        }}
        className={cn(badgeVariants(), 'max-w-[8.125rem] cursor-pointer hover:text-foreground')}
      >
        {inner}
      </button>
    </Tip>
  );
}

function statusSort(a, b) {
  const ia = STATUS_ORDER.indexOf(a);
  const ib = STATUS_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

function matches(s, q) {
  if (!q) return true;
  const hay = [
    s.id,
    s.title,
    s.status,
    s.metadata?.ticket,
    s.metadata?.branch,
    s.metadata?.worktree,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

// The session actions, once, for both surfaces: the row's ⋯ DropdownMenu and the
// right-click ContextMenu. `M` carries the matching Item / Separator parts.
function SessionMenuItems({ M, session, onArchive, onRestore, onRestart, onDelete, onEdit, onRemoveFromFolder }) {
  const t = useT();
  return (
    <>
      <M.Item onSelect={() => onEdit(session)}>
        <Pencil /> {t('rail.editDetails')}
      </M.Item>
      {onRemoveFromFolder && (
        <M.Item onSelect={() => onRemoveFromFolder(session)}>
          <Folder /> {t('rail.removeFromFolder')}
        </M.Item>
      )}
      <M.Separator />
      {session.archived ? (
        <M.Item onSelect={() => onRestore(session)}>
          <RotateCcw /> {t('rail.restoreSession')}
        </M.Item>
      ) : (
        <>
          <M.Item onSelect={() => onRestart(session)}>
            <RotateCw /> {t('rail.restartSession')}
          </M.Item>
          <M.Item onSelect={() => onArchive(session)}>
            <Archive /> {t('rail.archiveSession')}
          </M.Item>
        </>
      )}
      <M.Separator />
      <M.Item variant="destructive" onSelect={() => onDelete(session)}>
        <Trash2 /> {t('rail.deletePermanently')}
      </M.Item>
    </>
  );
}
const DD = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CM = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

// The ⋯ trigger every row / folder / agent carries: hidden until the row is
// hovered or focused (always there on a touch screen, at 44px), and it stays put
// while its menu is open.
const MORE_CLS =
  'shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100';
function MoreButton({ label, className = '', ...props }) {
  return (
    <Tip label={label}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={`${MORE_CLS} ${className}`}
          {...props}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
    </Tip>
  );
}

// Styled hover tooltip, portaled to <body> so the rail's transform/overflow
// (which makes a containing block for position:fixed) can't clip or offset it.
// Small open delay so sweeping across rows doesn't flash tips. `toggle()` is
// the tap-driven alternative (mobile has no hover) — dismisses on the next
// tap anywhere outside the anchor. Position flips to the anchor's left in
// RTL (previously hardcoded to open rightward, which reads wrong in Hebrew).
function useHoverTip(text) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const timer = useRef(null);
  const measure = () => {
    const r = ref.current.getBoundingClientRect();
    return { top: Math.max(8, r.top), left: r.left, right: r.right };
  };
  const show = () => {
    if (!text || !ref.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(measure()), 140);
  };
  const hide = () => { clearTimeout(timer.current); setPos(null); };
  const toggle = () => {
    if (!text || !ref.current) return;
    clearTimeout(timer.current);
    setPos((p) => (p ? null : measure())); // no open delay — this is an explicit tap
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  // Tap-to-open mode: the next tap anywhere else closes it.
  useEffect(() => {
    if (!pos) return;
    const onDocDown = (e) => { if (!ref.current?.contains(e.target)) hide(); };
    document.addEventListener('pointerdown', onDocDown, true);
    return () => document.removeEventListener('pointerdown', onDocDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const tip = pos && text
    ? createPortal(
        <div
          className="pointer-events-none fixed z-[70] max-w-[18.75rem] rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-snug whitespace-pre-wrap text-popover-foreground shadow-pop"
          style={rtl ? { top: pos.top, right: window.innerWidth - pos.left + 8 } : { top: pos.top, left: pos.right + 8 }}
          dir="auto"
        >
          {text}
        </div>,
        document.body
      )
    : null;
  return { ref, show, hide, toggle, tip };
}

// RAILUI — shared row vocabulary. One selected treatment for every kind of row
// (`row-selected`: a neutral fill and a 2px accent bar on the start edge, drawn
// by ::before so selecting never shifts the content). The row's own colour is
// the identity dot / avatar; nothing else on a row is coloured except the amber
// "needs you" dot. Hover reveals the ⋯ menu (always shown on touch).
const ROW_CLS =
  'group relative mb-px flex cursor-pointer items-start gap-2.5 rounded-md py-1.5 ps-2.5 pe-1.5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring coarse:min-h-11';
const META_CLS = 'mt-0.5 flex min-h-[1.125rem] min-w-0 items-center gap-1.5 text-2xs text-muted-foreground';
// time and ⋯ share one cell on a pointer device (hover swaps them); on touch
// both show, side by side.
const TRAIL_CLS = 'grid shrink-0 items-center justify-items-end coarse:flex coarse:gap-0.5';
const TIME_CLS =
  'col-start-1 row-start-1 text-2xs tabular-nums text-muted-foreground group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0 coarse:opacity-100! coarse:group-hover:opacity-100';
// H4 V2 — the children of a folder: one 1px vertical hairline running down
// their side, no glyphs, 12px of air after each group. Nest the same class
// again for depth 2.
const KIDS_CLS =
  "relative mb-2 ps-[1.375rem] before:pointer-events-none before:absolute before:start-[0.9375rem] before:top-0.5 before:bottom-1.5 before:w-px before:bg-border before:content-['']";
const TRAILING_BTN_CLS = 'col-start-1 row-start-1 -my-0.5';

// The status word stays quiet — per feedback the only colour a row carries is
// its own dot/avatar; "needs you" and the working spinner are the exceptions.
// Custom statuses are free text — truncate, never overflow.
function StatusWord({ children }) {
  return <span className="min-w-0 max-w-[65%] shrink-0 truncate">{children}</span>;
}

// "needs you" — the one loud element on a row: neutral chip, pulsing amber dot.
function NeedsYouPill({ title, icon: IconCmp, children }) {
  return (
    <Tip label={title}>
      <Badge status="warn" className="gap-1 text-foreground" data-needs-you="">
        {IconCmp && <IconCmp />}
        {children}
      </Badge>
    </Tip>
  );
}

function Row({ session, selected, onSelect, onArchive, onRestore, onRestart, onDelete, onEdit, onRemoveFromFolder, watch, health, waiting, muted, pinned }) {
  const t = useT();
  const color = session.color || '#c4c4c4';
  const label = session.metadata?.ticket || session.title || session.id;
  const showTitle = session.title && session.title !== label;
  const port = session.metadata?.port;
  const branch = session.metadata?.branch;
  const pr = session.metadata?.prNumber || session.metadata?.pr;
  const attention = needsAttention(session) && !selected;
  // request_screen pending — "needs you" (shown even on the selected row: the
  // machine is waiting on a human, not just on a click).
  const screenReq = hasOpenScreenRequest(session);
  const working = session.claude?.state === 'working';
  const restarting = session.claude?.state === 'restarting';
  const isDesktop = useIsDesktop();
  // The status-summary tldr (if the feature is on) shows as a styled tip —
  // hover on desktop; on mobile (no hover) a dedicated tap target below
  // toggles it instead, so it doesn't fight the row's own tap-to-select.
  const tip = useHoverTip(session.statusSummary?.tldr);
  const hoverProps = isDesktop ? { onMouseEnter: tip.show, onMouseLeave: tip.hide } : {};
  // A1: a session born from an agent wears the agent's emoji (its color is
  // already the session color — stamped at creation).
  const { agents } = useStore();
  const agent = session.metadata?.agent ? (agents || []).find((a) => a.slug === session.metadata.agent) : null;
  // One meta line: a single status word, picked by priority —
  // archived › screen take-over › working/restarting › the session's status.
  const statusWord = session.archived
    ? t('rail.archived')
    : screenReq
      ? t('status.awaitingTakeover')
      : restarting
        ? t('rail.restarting')
        : working
          ? t('rail.working')
          : statusLabel(session.status);
  const titleCls = muted && !selected ? 'text-sm font-normal text-foreground/85' : 'text-sm font-medium text-foreground';
  const menuProps = { session, onArchive, onRestore, onRestart, onDelete, onEdit, onRemoveFromFolder };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={tip.ref}
          {...(pinned ? { 'data-needs-row': session.id } : { 'data-session-row': session.id })}
          role="button"
          tabIndex={0}
          aria-current={selected ? 'true' : undefined}
          {...hoverProps}
          onClick={() => onSelect(session.id)}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onSelect(session.id);
            }
          }}
          className={`${ROW_CLS} ${selected ? 'row-selected' : 'hover:bg-muted'}`}
        >
          {tip.tip}
          <span className="mt-[0.3125rem] flex w-4 shrink-0 justify-center">
            {agent ? (
              <AgentAvatar agent={{ ...agent, color }} size={muted ? 16 : 18} />
            ) : (
              <Dot color={color} size={muted ? 8 : 9} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              {showTitle && session.metadata?.ticket && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{session.metadata.ticket}</span>
              )}
              <Truncate
                text={showTitle && session.metadata?.ticket ? session.title : label}
                dir={dirOf(label)}
                className={`min-w-0 flex-1 text-start leading-tight ${titleCls}`}
              />
              <span className="flex shrink-0 items-center gap-1.5">
                {watch && (
                  <Tip
                    label={
                      watch.errored
                        ? t('rail.listenerErrored')
                        : (watch.count > 1
                            ? t('rail.watchingSources', { n: watch.count })
                            : t('rail.watchingSource', { n: watch.count })) +
                          (watch.fired ? t('rail.firedSuffix', { n: watch.fired }) : '')
                    }
                  >
                    <span
                      className={`flex items-center gap-0.5 text-2xs leading-none tabular-nums ${
                        watch.errored ? 'pulse-yellow text-destructive' : 'text-muted-foreground'
                      }`}
                    >
                      {watch.errored ? <TriangleAlert className="size-3" /> : <Eye className="size-3" />}
                      {watch.count}
                    </span>
                  </Tip>
                )}
                {!isDesktop && session.statusSummary?.tldr && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => { e.stopPropagation(); tip.toggle(); }}
                    aria-label={t('rail.summary')}
                    className="text-muted-foreground"
                  >
                    <Info />
                  </Button>
                )}
                {/* LADDER1: quietly says the session is on a weaker rung (server-derived claude.ladder). */}
                <LadderBadge session={session} compact />
                {/* One indicator, by priority: needs you (pill) › waiting (badge) › working (spinner, on the meta line) › status word. */}
                {screenReq ? (
                  <NeedsYouPill title={t('rail.screenNeedsYou')} icon={Monitor}>{t('rail.screenNeedsYouShort')}</NeedsYouPill>
                ) : attention ? (
                  <NeedsYouPill title={t('rail.needsYourInput')}>{t('rail.needsYouPill')}</NeedsYouPill>
                ) : waiting?.length > 0 ? (
                  <WaitingBadge items={waiting} t={t} />
                ) : null}
              </span>
            </span>
            {/* The meta line, in scan order: RES1's health dot, the (spinner +)
                status word, the branch and PR chips, UX1's agent button ("whose
                job this is" — a click target, so it sits outside the truncating
                span), the port and the trigger bolt. */}
            <span className={META_CLS}>
              <HealthDot health={health} />
              {(working || restarting) && (
                <Tip label={restarting ? t('rail.restartingEllipsis') : t('rail.workingEllipsis')}>
                  <span className="host-spinner size-2.5 shrink-0" />
                </Tip>
              )}
              {statusWord && <StatusWord>{statusWord}</StatusWord>}
              {branch && (
                <Badge mono dir="ltr" className="min-w-0 max-w-[7.5rem] shrink truncate" data-row-branch="">
                  <bdi className="truncate">{branch}</bdi>
                </Badge>
              )}
              {pr && (
                <Badge mono className="tabular-nums" data-row-pr="">
                  #{String(pr).replace(/^#/, '')}
                </Badge>
              )}
              {/* UX1: born from an agent — the row wears its face AND says whose job
                  this is, so a work session never reads as "the agent itself". */}
              {agent && (
                <Tip label={t('session.bornFromTitle', { name: agent.name })}>
                  <button
                    type="button"
                    data-row-agent={agent.slug}
                    onClick={(e) => { e.stopPropagation(); openAgent(agent.slug); }}
                    className="shrink-0 cursor-pointer text-2xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {agent.name}
                  </button>
                </Tip>
              )}
              {port != null && <span className="shrink-0 tabular-nums">:{port}</span>}
              {session.metadata?.fromTriggerName && (
                <TriggerTag name={session.metadata.fromTriggerName} showName={false} className="shrink-0 text-2xs" />
              )}
            </span>
          </span>
          <span className={TRAIL_CLS}>
            <span className={TIME_CLS}>{relTime(session.updatedAt || session.createdAt)}</span>
            <DropdownMenu>
              <MoreButton label={t('rail.sessionActions')} className={TRAILING_BTN_CLS} />
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} data-row-menu="">
                <SessionMenuItems M={DD} {...menuProps} />
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-row-menu="">
        <SessionMenuItems M={CM} {...menuProps} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A collapsible section header (Team, Archived, Pending tasks): chevron + label
// + count, quiet, sentence case — the rail's own sections are not shouty.
function SectionToggle({ label, count, open, onToggle, title, className = '', children, ...props }) {
  return (
    <div className={`flex w-full items-center gap-1 pe-1 ${className}`}>
      <Tip label={title}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11"
          {...props}
        >
          <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : 'rtl:rotate-180'}`} />
          <span className="min-w-0 truncate">{label}</span>
          <span className="tabular-nums text-muted-foreground/80">{count}</span>
        </button>
      </Tip>
      {children}
    </div>
  );
}

// The agent menu items, shared by the row's ⋯ menu; `M` carries the parts so a
// test can render them without a Radix menu around them.
export function AgentMenuItems({ M, agent, onOpenAgent, t }) {
  return (
    <>
      <M.Item data-agent-menu-home onSelect={() => onOpenAgent?.(agent.slug, 'home')}>
        <Play /> {t('rail.teamHomeChat')}
      </M.Item>
      <M.Item data-agent-menu-runs onSelect={() => onOpenAgent?.(agent.slug, 'runs')}>
        <ListChecks /> {t('agent.page.tab.runs')}
      </M.Item>
      <M.Item onSelect={() => onOpenAgent?.(agent.slug, 'persona')}>
        <Bot /> {t('rail.teamOpenPage')}
      </M.Item>
      <M.Separator />
      <M.Item variant="destructive" data-agent-menu-delete onSelect={() => deleteAgentConfirmed(agent, t)}>
        <Trash2 /> {t('agent.page.delete')}
      </M.Item>
    </>
  );
}

// A1 — the Team section: one row per agent, BELOW folders/free
// sessions and above the archived group. Status: working when any live session
// born from the agent is mid-turn, else its WORK-session count / idle.
// A2: an idle agent with an enabled cron job shows its NEXT run instead
// ("⏰ in 3h"), read from the store's triggers (`agent` + `nextRunAt`).
// UX1: a row is a door to the agent SURFACE (#/agents/<slug>), whose Home tab is
// the DM chat — the home chat is not a session row anymore, so "click an agent"
// and "open a session" stopped looking like the same act. ⋯ still offers both
// doors explicitly (Home / the persona page).
export { nextCronFor };
export function TeamSection({ agents, sessions, triggers, onOpenAgent, onNewAgent, agentOpen, open, onToggle, waitingByAgent }) {
  const t = useT();
  const list = agents || [];
  const byAgent = new Map();
  for (const s of sessions || []) {
    if (s.archived || !s.metadata?.agent) continue;
    const l = byAgent.get(s.metadata.agent) || [];
    l.push(s);
    byAgent.set(s.metadata.agent, l);
  }
  // RES1 §4: a collapsed Team section hides every per-agent waiting badge —
  // roll the total up onto the header count, same idiom as a folder.
  const hiddenWaiting = open
    ? 0
    : [...(waitingByAgent?.values() || [])].reduce((n, items) => n + items.length, 0);
  return (
    <div data-rail-team className="mt-3">
      <SectionToggle
        label={t('rail.team')}
        count={`${list.length}${hiddenWaiting ? ` · !${hiddenWaiting > 1 ? hiddenWaiting : ''}` : ''}`}
        open={open}
        onToggle={onToggle}
        title={hiddenWaiting ? t('rail.waitingInsideClick', { n: hiddenWaiting }) : t('agent.oneLiner')}
      >
        <Tip label={t('rail.teamNewAgent')}>
          <Button
            variant="ghost"
            size="icon-xs"
            data-rail-team-new
            aria-label={t('rail.teamNewAgent')}
            onClick={onNewAgent}
            className="text-muted-foreground"
          >
            <Plus />
          </Button>
        </Tip>
      </SectionToggle>
      {open && list.length === 0 && (
        <div className="px-2.5 py-1.5 text-2xs text-muted-foreground">{t('rail.teamEmpty')}</div>
      )}
      {open && list.length > 0 && (
        <div className="px-2.5 pb-1 text-2xs leading-snug text-muted-foreground">{t('agent.oneLiner')}</div>
      )}
      {open &&
        list.map((a) => {
          const mine = byAgent.get(a.slug) || [];
          const working = mine.some((s) => s.claude?.state === 'working');
          // UX1: the count is WORK sessions — the home chat is the agent, not a job it is doing.
          const runs = mine.filter((s) => !s.metadata?.agentHome);
          const nextCron = runs.length === 0 ? nextCronFor(a.slug, triggers) : null;
          const surfaceOpen = agentOpen === a.slug;
          const mineWaiting = waitingByAgent?.get(a.slug) || [];
          return (
            <div
              key={a.slug}
              data-rail-agent={a.slug}
              role="button"
              tabIndex={0}
              onClick={() => onOpenAgent?.(a.slug, 'home')}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onOpenAgent?.(a.slug, 'home');
                }
              }}
              // The skills list left the row (detail); it lives in the tooltip now.
              title={a.skills?.length ? a.skills.join(' · ') : t('agent.oneLiner')}
              className={`${ROW_CLS} ${surfaceOpen ? 'row-selected' : 'hover:bg-muted'}`}
            >
              <span className="mt-px flex w-4 shrink-0 justify-center">
                <AgentAvatar agent={a} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <Truncate text={a.name} dir={dirOf(a.name)} className="min-w-0 flex-1 text-start text-sm font-medium leading-tight text-foreground" />
                  {mineWaiting.length > 0 && <WaitingBadge items={mineWaiting} t={t} />}
                </span>
                <span className={META_CLS}>
                  {working ? (
                    <>
                      <span className="host-spinner size-2.5 shrink-0" />
                      <StatusWord>{t('rail.teamWorking')}</StatusWord>
                    </>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1.5" {...(nextCron ? { 'data-agent-next-cron': String(nextCron), title: t('rail.teamNextCronTitle', { when: fmtDateTime(nextCron) }) } : {})}>
                      <StatusDot status={runs.length ? 'ok' : 'idle'} />
                      {nextCron ? t('rail.teamNextCron', { when: untilTime(nextCron, t) }) : runs.length === 0 ? t('rail.teamIdle') : runs.length === 1 ? t('rail.teamSession') : t('rail.teamSessions', { n: runs.length })}
                    </span>
                  )}
                </span>
              </span>
              <span className={TRAIL_CLS}>
                <DropdownMenu>
                  <MoreButton label={t('rail.teamActions')} className="coarse:col-auto" />
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} data-agent-menu="">
                    <AgentMenuItems M={DD} agent={a} onOpenAgent={onOpenAgent} t={t} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </div>
          );
        })}
    </div>
  );
}

// How far a row's neighbours part to open a drop slot (px). Roughly half a row
// so it reads as "space for the dragged item".
const GAP = 24;

// Insertion indicator: a thin neutral line with a leading dot, centered inside
// the gap the neighbouring rows opened for it (or hugging the edge when no gap
// animation is in play, e.g. the Pending list).
function DropLine({ pos, gap = 0 }) {
  const offset = gap ? gap / 2 - 1 : -2;
  return (
    <span
      className="pointer-events-none absolute inset-x-1 z-10 flex items-center"
      style={pos === 'before' ? { top: offset } : { bottom: offset }}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
      <span className="h-0.5 flex-1 rounded-full bg-foreground" />
    </span>
  );
}

// Which drop zone of the hovered row the pointer is in. Two-zone rows split
// 50/50 (pure reorder); three-zone rows reserve the middle 50% for "onto"
// (drop into / group with) with the outer quarters as insertion gaps.
//
// Measured against the row BODY (a fixed-height inner element tagged
// data-rowbody), never the wrapper — the wrapper grows as the gap opens, and
// measuring it would move the zone boundaries under the cursor and cause the
// indicator to jitter. The stable body keeps the zone rock-steady while the
// space animates open.
export function dropZone(e, withInto = false) {
  const body = e.currentTarget.querySelector('[data-rowbody]') || e.currentTarget;
  const r = body.getBoundingClientRect();
  const rel = (e.clientY - r.top) / Math.max(1, r.height);
  if (withInto) return rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'into';
  return rel < 0.5 ? 'before' : 'after';
}

// Reorder helper: move `from` so it sits before/after `target` in `ids`.
export function insertAt(ids, from, target, zone) {
  const next = ids.filter((x) => x !== from);
  const ti = next.indexOf(target);
  if (ti < 0) return ids;
  next.splice(zone === 'after' ? ti + 1 : ti, 0, from);
  return next;
}

function GroupHeader({ label, count }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <span className="tabular-nums text-muted-foreground/80">{count}</span>
    </div>
  );
}

// Folder actions, once for the ⋯ menu and the right-click menu.
function FolderMenuItems({ M, onRename, onMakeProject, onDelete }) {
  const t = useT();
  return (
    <>
      <M.Item onSelect={onRename}>
        <Pencil /> {t('rail.renameFolder')}
      </M.Item>
      {onMakeProject && (
        <M.Item onSelect={onMakeProject}>
          <FolderTree /> {t('rail.makeProjectFolder')}
        </M.Item>
      )}
      <M.Separator />
      <M.Item variant="destructive" onSelect={onDelete}>
        <Trash2 /> {t('rail.deleteFolder')}
      </M.Item>
    </>
  );
}

// Folder header row. Badge language (decision record §6): indicators next to
// the NAME belong to the folder's own session — in a PROJECT folder the header
// IS the controller (clicking the name selects it; the chevron collapses) —
// while delegated child indicators are rolled up on the count chip at the far
// edge, surfacing only while the folder is collapsed.
function FolderRow({
  folder,
  kids,
  controller,
  selectedId,
  onSelect,
  watchFor,
  waitingBySession,
  over,
  onToggle,
  onExpand,
  onRename,
  onMakeProject,
  onDelete,
}) {
  const t = useT();
  const collapsed = !!folder.collapsed;
  const isProject = !!controller;
  const ctlSelected = isProject && controller.id === selectedId;
  const attention = collapsed
    ? kids.filter((s) => needsAttention(s) && s.id !== selectedId).length
    : 0;
  // RES1 §4: a waiting badge hidden behind a collapsed folder would otherwise
  // vanish entirely — roll it up onto the count chip, same idiom as the
  // needsAttention rollup below.
  const waitingHidden = collapsed
    ? kids.reduce((n, s) => n + (waitingBySession?.get(s.id)?.length || 0), 0)
    : 0;
  const errored = collapsed && kids.some((s) => watchFor(s.id)?.errored);
  const working =
    collapsed && kids.some((s) => ['working', 'restarting'].includes(s.claude?.state));
  // The controller's OWN state renders exactly like a session row's badges —
  // solid, next to the name, visible expanded or collapsed (it has no row).
  const ctlAttention = isProject && needsAttention(controller) && !ctlSelected;
  const ctlWaiting = isProject ? waitingBySession?.get(controller.id) || [] : [];
  const ctlWorking = isProject && controller.claude?.state === 'working';
  const ctlRestarting = isProject && controller.claude?.state === 'restarting';
  const ctlColor = controller?.color || '#c4c4c4';
  // H4: a project header wears its controller's agent face at 22px (that big
  // avatar + "manager ·" on the meta line replaced the "manager" chip).
  const { agents } = useStore();
  const ctlAgent = controller?.metadata?.agent ? (agents || []).find((a) => a.slug === controller.metadata.agent) : null;

  // Two lines, like a session row: the name, then one meta line. A project
  // folder mirrors its controller session (the header IS that session); a
  // plain folder summarises its contents.
  const label = (s) => s.metadata?.ticket || s.title || s.id;
  const count = kids.length;
  const newest = kids.reduce(
    (t, s) => Math.max(t, +new Date(s.updatedAt || s.createdAt || 0)),
    0
  );
  const [ctlStatus, ctlTime] = isProject
    ? [statusLabel(controller.status), relTime(controller.updatedAt || controller.createdAt)]
    : ['', ''];
  const statusWord = isProject
    ? ctlRestarting
      ? t('rail.restarting')
      : ctlWorking
        ? t('rail.working')
        : ctlStatus
    : count
      ? count === 1
        ? t('rail.oneSession', { n: count })
        : t('rail.nSessions', { n: count })
      : t('rail.emptyFolder');
  const time = isProject ? ctlTime : newest ? relTime(new Date(newest).toISOString()) : '';
  // Folded secondary text: the controller's description, or — only while the
  // fold hides the rows — the members' names, so nothing disappears behind it.
  const descLine = collapsed && count ? kids.map(label).join(', ') : !isProject && !count ? t('rail.dropToGroup') : '';

  // A project folder's header IS the controller session — surface its tldr as
  // the same hover tip a normal session row gets.
  const tip = useHoverTip(controller?.statusSummary?.tldr);
  const hot = !!(attention || waitingHidden);
  const menuProps = { onRename, onMakeProject: isProject ? undefined : onMakeProject, onDelete };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={tip.ref}
          onMouseEnter={tip.show}
          onMouseLeave={tip.hide}
          data-rowbody
          onClick={() => (isProject ? onSelect(controller.id) : onToggle())}
          className={`group relative mb-px flex min-h-[2.25rem] cursor-pointer items-start gap-1.5 rounded-md py-1.5 ps-0.5 pe-1.5 coarse:min-h-11 ${
            ctlSelected ? 'row-selected' : 'hover:bg-muted'
          } ${over?.zone === 'into' ? 'ring-1 ring-foreground/40 ring-inset' : ''}`}
        >
          {tip.tip}
          <Tip label={collapsed ? t('rail.expandFolder') : t('rail.collapseFolder')}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={collapsed ? t('rail.expandFolder') : t('rail.collapseFolder')}
              aria-expanded={!collapsed}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="text-muted-foreground"
            >
              <ChevronRight className={`size-3.5 transition-transform ${collapsed ? 'rtl:rotate-180' : 'rotate-90'}`} />
            </Button>
          </Tip>
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
            {isProject ? (
              ctlAgent ? (
                <Tip label={t('rail.projectFolderHint')}>
                  <span className="flex">
                    <AgentAvatar agent={{ ...ctlAgent, color: ctlColor }} size={20} />
                  </span>
                </Tip>
              ) : (
                <Tip label={t('rail.projectFolderHint')}>
                  <span
                    className="flex size-5 items-center justify-center rounded-md"
                    style={{ background: `color-mix(in oklab, ${ctlColor} 18%, transparent)`, color: ctlColor }}
                  >
                    <FolderTree className="size-3.5" />
                  </span>
                </Tip>
              )
            ) : (
              <Folder className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <Truncate
                text={folder.name}
                dir={dirOf(folder.name)}
                className={`min-w-0 flex-1 text-start text-sm leading-tight ${isProject ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'}`}
              />
              <span className="flex shrink-0 items-center gap-1.5">
                {/* Per-kid dots exist to survive a fold — so they show only on a
                    collapsed folder, and not when the rollup chip already says
                    "N · ? · !" (redundant, and it starves the title of width). */}
                {collapsed && !hot && <StateDots kids={kids} />}
                {ctlAttention ? (
                  <NeedsYouPill title={t('rail.controllerNeedsInput')}>{t('rail.needsYouPill')}</NeedsYouPill>
                ) : ctlWaiting.length > 0 ? (
                  <WaitingBadge items={ctlWaiting} t={t} />
                ) : null}
                {errored && (
                  <Tip label={t('rail.folderListenerErrored')}>
                    <span className="text-destructive"><TriangleAlert className="size-3.5" /></span>
                  </Tip>
                )}
                {!attention && working && (
                  <Tip label={t('rail.folderSessionWorking')}>
                    <span className="host-spinner size-2.5" />
                  </Tip>
                )}
                <Tip
                  label={[
                    count === 1 ? t('rail.oneSession', { n: count }) : t('rail.nSessions', { n: count }),
                    attention ? t('rail.needsInputClick', { n: attention }) : null,
                    waitingHidden ? t('rail.waitingInsideClick', { n: waitingHidden }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExpand();
                    }}
                    className={cn(
                      badgeVariants({ variant: hot ? 'outline' : 'default' }),
                      'cursor-pointer tabular-nums',
                      hot && 'text-foreground',
                      !hot && 'bg-transparent',
                    )}
                  >
                    {hot && <StatusDot status="warn" />}
                    {count}
                    {attention ? ` · ?${attention > 1 ? attention : ''}` : ''}
                    {waitingHidden ? ` · !${waitingHidden > 1 ? waitingHidden : ''}` : ''}
                  </button>
                </Tip>
              </span>
            </span>
            <span className={META_CLS}>
              {(ctlWorking || ctlRestarting) && (
                <Tip label={ctlRestarting ? t('rail.controllerRestarting') : t('rail.controllerWorking')}>
                  <span className="host-spinner size-2.5 shrink-0" />
                </Tip>
              )}
              {isProject && <span className="shrink-0">{t('rail.managerChip')} ·</span>}
              {statusWord && <StatusWord>{statusWord}</StatusWord>}
              {descLine && <Truncate as="span" text={`· ${descLine}`} dir={dirOf(descLine)} className="min-w-0 text-start" />}
              {time && <span className="ms-auto shrink-0 tabular-nums">{time}</span>}
            </span>
          </span>
          <span className={TRAIL_CLS}>
            <DropdownMenu>
              <MoreButton label={t('rail.folderActions')} />
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <FolderMenuItems M={DD} {...menuProps} />
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FolderMenuItems M={CM} {...menuProps} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A queued, not-yet-a-session item. Click → ticket preview (no session yet);
// ▶ starts it (via startPending); ✕ dismisses (kept in the trigger's seen set).
// Draggable — the queue order IS the autoplay execution order.
function PendingRow({ item, onPreview, onDragStart, onDragEnd, onDragOver, onDrop, over }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const start = async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.post(`/pending/${item.id}/start`);
    } catch {
      setBusy(false);
    }
  };
  const dismiss = async (e) => {
    e.stopPropagation();
    try {
      await api.del(`/pending/${item.id}`);
      // Dismiss is destructive (the ticket is also marked 'seen' so it won't
      // reappear) and the ✕ sits right beside ▶ — offer a one-click undo.
      toast(t('rail.dismissedX', { x: item.ticket || t('rail.emptySessionName') }), {
        action: {
          label: t('rail.undo'),
          onClick: () => {
            const body = isEmpty
              ? { kind: 'empty', title: item.title, prompt: item.prompt, cwd: item.cwd, permissionMode: item.permissionMode }
              : { ticket: item.ticket, title: item.title, prompt: item.prompt };
            api.post('/pending', body).catch((err) => toastError(t('rail.couldntRestore', { msg: err?.message || err })));
          },
        },
      });
    } catch (err) {
      toastError(t('rail.couldntDismiss', { msg: err?.message || err }));
    }
  };
  const isEmpty = item.kind === 'empty';
  return (
    <div
      draggable
      data-pending-row={item.id}
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(e, item.id)}
      onDrop={(e) => onDrop(e, item.id)}
      onClick={() => onPreview(isEmpty ? `pending:${item.id}` : item.ticket)}
      title={isEmpty ? t('rail.clickPreviewItem') : t('rail.clickPreviewTicket')}
      className="group relative mb-px flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md ps-1 pe-0.5 hover:bg-muted coarse:min-h-11"
    >
      {over && <DropLine pos={over} />}
      <Tip label={t('rail.dragToReorder')}>
        <span className="shrink-0 cursor-grab text-muted-foreground/70"><GripVertical className="size-3.5" /></span>
      </Tip>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {isEmpty ? '◇' : item.ticket}
      </span>
      <Truncate text={item.title} className="min-w-0 flex-1 text-start text-sm text-foreground/85" />
      <Tip label={t('rail.fromX', { x: item.triggerName })}>
        <Badge className="max-w-[4.5rem] truncate">{item.triggerName}</Badge>
      </Tip>
      <Tip label={t('rail.startNow')}>
        <Button variant="ghost" size="icon-xs" onClick={start} disabled={busy} aria-label={t('rail.startNow')} className="text-foreground">
          <Play className="size-3.5" />
        </Button>
      </Tip>
      <Tip label={t('rail.dismiss')}>
        <Button variant="ghost" size="icon-xs" onClick={dismiss} aria-label={t('rail.dismiss')} className="text-muted-foreground hover:text-destructive">
          <X className="size-3.5" />
        </Button>
      </Tip>
    </div>
  );
}

// The desktop shell's machine switcher. Hidden in a browser (no
// window.__arigami) and hidden while "this computer" is the only machine —
// there is nothing to switch to, and a control that never does anything is
// worse than no control. The way to get a second machine is Settings › Host ›
// Machines, which opens the same window this chip does.
//
// Deliberately quiet: a dot in the machine's colour and the name in the dim
// foreground, not a filled pill. The 3px strip the shell paints across the top
// of the window is the loud signal; this is the label for it.
function MachineChip() {
  const t = useT();
  const shell = useShell();
  const machines = shell?.machines || [];
  if (!shell || machines.length < 2) return null;
  const cur = machines.find((m) => m.id === shell.current) || machines[0];
  return (
    <Tip label={t('rail.machines.switch')}>
      <Button
        variant="ghost"
        size="xs"
        onClick={openMachines}
        aria-label={t('rail.machines.switch')}
        className="ms-auto max-w-[8rem] min-w-0 text-muted-foreground"
      >
        <Dot color={shell.color || '#9CA3AF'} size={6} />
        <span className="truncate">{cur?.name || ''}</span>
        <ChevronDown aria-hidden="true" />
      </Button>
    </Tip>
  );
}

// Stuck to the bottom of the sidebar, always visible (even with no items) so the
// autoplay control is always reachable. Collapsible; header carries the triggers
// shortcut + autoplay ▶/⏸ + concurrency cap.
function PendingSection({ pending, queue, onPreview, onOpenTriggers }) {
  const t = useT();
  const isDesktop = useIsDesktop();
  // Desktop keeps the historical default-open; mobile starts collapsed so it
  // doesn't eat screen space on first load (still toggleable either way).
  const [open, setOpen] = useState(isDesktop);
  const [order, setOrder] = useState(pending);
  const dragId = useRef(null);
  const [over, setOver] = useState(null); // {id, zone: 'before'|'after'}
  useEffect(() => {
    setOrder(pending);
  }, [pending]);

  // Local echo for the concurrency field so typing doesn't get clamped/re-POSTed
  // on every keystroke (clearing it to type "10" no longer snaps to 1). Commit
  // on blur/Enter; keep in sync with the server value when not editing.
  const [maxDraft, setMaxDraft] = useState(String(queue.maxConcurrent));
  useEffect(() => {
    setMaxDraft(String(queue.maxConcurrent));
  }, [queue.maxConcurrent]);

  const onDragStart = (e, id) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragEnd = () => {
    setOver(null);
    dragId.current = null;
  };
  const onDragOver = (e, id) => {
    e.preventDefault();
    const zone = dropZone(e);
    setOver((prev) => (prev?.id === id && prev.zone === zone ? prev : { id, zone }));
  };
  const onDrop = (e, id) => {
    e.preventDefault();
    const from = dragId.current;
    const zone = dropZone(e);
    setOver(null);
    dragId.current = null;
    if (!from || from === id) return;
    const ids = insertAt(order.map((p) => p.id), from, id, zone);
    setOrder(ids.map((x) => order.find((p) => p.id === x)));
    api.post('/pending/reorder', { order: ids }).catch(() => {});
  };

  const toggleAutoplay = () =>
    api.patch('/queue', { autoplay: !queue.autoplay }).catch(() => {});
  const commitMax = () => {
    const n = Math.min(10, Math.max(1, Number(maxDraft) || 1));
    setMaxDraft(String(n));
    if (n !== queue.maxConcurrent)
      api.patch('/queue', { maxConcurrent: n }).catch((e) => toastError(t('rail.couldntSetConcurrency', { msg: e?.message || e })));
  };

  return (
    <div className="shrink-0 border-t border-border bg-rail" data-rail-pending>
      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <SectionToggle
          label={t('rail.pendingTasks')}
          count={pending.length}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          title={open ? t('rail.collapse') : t('rail.expand')}
          className="min-w-0 flex-1 !pe-0"
        />
        <Tip label={t('rail.manageTriggers')}>
          <Button variant="ghost" size="icon-sm" onClick={onOpenTriggers} aria-label={t('rail.manageTriggers')} data-rail-triggers className="text-muted-foreground">
            <Zap />
          </Button>
        </Tip>
        <Tip label={queue.autoplay ? t('rail.autoplayOnPause') : t('rail.autoplayOffStart')}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleAutoplay}
            aria-pressed={!!queue.autoplay}
            aria-label={queue.autoplay ? t('rail.autoplayOnPause') : t('rail.autoplayOffStart')}
            className={queue.autoplay ? 'bg-muted text-foreground' : 'text-muted-foreground'}
          >
            {queue.autoplay ? <Pause /> : <Play />}
          </Button>
        </Tip>
        <Tip label={t('rail.maxConcurrent')}>
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <span aria-hidden="true">×</span>
            <input
              type="number"
              min="1"
              max="10"
              aria-label={t('rail.maxConcurrent')}
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
              onBlur={commitMax}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="h-6 w-9 rounded-md border border-input bg-background px-1 text-center text-xs tabular-nums text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 coarse:h-11 coarse:w-12"
            />
          </span>
        </Tip>
      </div>
      {open && (
        <div className="thin-scroll max-h-[38vh] overflow-y-auto px-1.5 pb-2">
          {pending.length === 0 ? (
            <div className="px-2 py-2 text-center text-2xs text-muted-foreground">
              {t('rail.noPendingTasks')}{' '}
              {queue.autoplay ? t('rail.autoplayIsOn') : t('rail.autoplayIsOff')}
            </div>
          ) : (
            order.map((item) => (
              <PendingRow
                key={item.id}
                item={item}
                onPreview={onPreview}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOver={onDragOver}
                onDrop={onDrop}
                over={over?.id === item.id ? over.zone : null}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Footer profile dropdown — consolidates the former standalone footer buttons
// (setup / skills / brain / settings) behind one menu, fronted by the account
// the host is currently running as. Accounts, Integrations and Voice moved
// into Settings (SET): #/settings/connections, #/settings/voice. AUDIT2: sign
// out lives here (it left Settings › Host › danger zone) — the only logout.
function ProfileMenu({ active, onOpenSkills, onOpenBrain, onOpenSetup, onOpenSettings }) {
  const t = useT();
  const { auth } = useStore();
  const canLogout = !!auth && auth.authMode !== 'off';
  // "My browser": the owner's own profile. Sign in to a site here once; an agent
  // can then ASK for that one site (request_login) and you approve per site.
  // On Linux it opens on the shared desktop, so the global screen view shows it.
  const openMyBrowser = async () => {
    try {
      const r = await api.post('/browser/vault/open', {});
      if (r?.display) setScreenModal(true);
    } catch (e) {
      toastError(t('rail.myBrowserFailed', { error: e.message || e }));
    }
  };
  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    signOut();
  };
  const label = active?.label || t('rail.noAccount');
  const initial = (label.trim()[0] || '?').toUpperCase();
  return (
    <div className="min-w-0 flex-1">
      <DropdownMenu>
        <Tip label={t('rail.profileSettings')}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t('rail.profileSettings')} data-profile-menu className="w-full min-w-0 justify-start gap-2 px-1.5 text-muted-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-foreground">{initial}</span>
              <span className="min-w-0 flex-1 truncate text-start text-xs">{label}</span>
              <ChevronDown className="size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">{t('rail.runningAs')}</DropdownMenuLabel>
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-foreground">{initial}</span>
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onOpenSkills?.()}><Puzzle /> {t('rail.skills')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenBrain?.()}><Brain /> {t('rail.brain')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenSetup?.()}><Wrench /> {t('rail.setup')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={openMyBrowser}><Globe /> {t('rail.myBrowser')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenSettings?.()}><SettingsIcon /> {t('rail.settings')}</DropdownMenuItem>
          {canLogout && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={logout}><LogOut /> {t('auth.settings.logout')}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function Rail({
  sessions,
  selectedId,
  agentOpen,
  onSelect,
  onNew,
  onOpenSettings,
  onOpenSkills,
  onOpenBrain,
  onOpenSetup,
  searchRef,
  onArchive,
  onRestore,
  onRestart,
  onDelete,
  onEdit,
  config,
  conn,
  isDesktop = true,
  onClose,
  onPreviewTicket,
  onOpenTriggers,
  onOpenShortcuts,
  onOpenAgent,
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('flat'); // 'flat' | 'grouped'
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(true); // A1: the Team section
  const [folderDialog, setFolderDialog] = useState(null); // {type:'create'|'new'|'rename'|'delete', …}
  const [screenAvailable, setScreenAvailable] = useState(false);
  // Global (not per-session) screen-share — poll availability so the icon
  // hides itself cleanly instead of showing a button that fails on click
  // (e.g. before VNC setup runs on a machine, or if the service stops).
  useEffect(() => {
    let stop = false;
    const tick = () => api.get('/screen/status').then((r) => { if (!stop) setScreenAvailable(!!r?.available); }).catch(() => { if (!stop) setScreenAvailable(false); });
    tick();
    const iv = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(iv); };
  }, []);
  const { railWidth } = usePrefs();
  const { usage, listeners, pending, queue, accounts, accountUsage, folders, agents, triggers, health, waiting } = useStore();
  // RES1 §4: index waiting items to the row they belong to — the agent's row
  // when the blocked session was born from one (metadata.agent, carried as
  // `w.agent`), otherwise the session's own row.
  const waitingBySession = new Map();
  const waitingByAgent = new Map();
  for (const w of waiting || []) {
    if (w.agent) {
      const l = waitingByAgent.get(w.agent) || [];
      l.push(w);
      waitingByAgent.set(w.agent, l);
    } else {
      const l = waitingBySession.get(w.sessionId) || [];
      l.push(w);
      waitingBySession.set(w.sessionId, l);
    }
  }
  // The header reflects the ACTIVE account. Derive it from the per-account map so
  // switching accounts updates instantly instead of lagging on the generic
  // usage-updated broadcast (which only fires when the active usage changes).
  // P1-11: the active engine = the selected session's, else the host default.
  const selSession = selectedId ? sessions.find((s) => s.id === selectedId) : null;
  const activeEngine = selSession ? normalizeEngine(selSession.engine) : DEFAULT_ENGINE;
  const codexId = accounts?.activeIds?.codex;
  const activeUsage = activeEngine === 'codex'
    ? (codexId && (accountUsage?.[codexId] || snapshotUsage((accounts?.accounts || []).find((a) => a.id === codexId)))) || null
    : (accounts?.activeId && accountUsage?.[accounts.activeId]) || usage;
  const [dragging, setDragging] = useState(false);
  const sDragId = useRef(null); // flat-mode session drag
  const fDragId = useRef(null); // flat-mode folder drag
  const [sOver, setSOver] = useState(null); // {id, zone: 'before'|'after'} | {id:'__end'}

  // Per-session listener summary for the row badge (live listeners only).
  const watchFor = (id) => {
    const ls = (listeners || []).filter((l) => l.sessionId === id && l.status !== 'stopped');
    if (!ls.length) return null;
    return {
      count: ls.length,
      errored: ls.some((l) => l.status === 'errored'),
      fired: ls.reduce((n, l) => n + (l.firedCount || 0), 0),
    };
  };

  // Drag the inner edge to resize; clamp + persist to prefs.
  const startDrag = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
    const [lo, hi] = PREF_LIMITS.rail;
    const onMove = (ev) => {
      // RTL puts the rail on the right, so its width grows as the cursor moves
      // left — measure from the correct edge based on the live document dir.
      const rtl = document.documentElement.dir === 'rtl';
      const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
      const x = (rtl ? window.innerWidth - ev.clientX : ev.clientX) / scale;
      const w = Math.min(hi, Math.max(lo, x));
      setPrefs({ railWidth: w });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // UX1: the rail marks WHAT IS ON SCREEN. While an agent surface is open, the
  // selected thing is the AGENT — keeping the session row highlighted as well
  // lit up two rows at once and read as "both are open".
  const selectedRow = agentOpen ? null : selectedId;
  // UX1: an agent's home chat is the Home tab of its agent surface, not a row
  // here. It stays in the API, resumable and counted in the agent's ledger — it
  // just stops competing with the work sessions for the same list. Everything
  // below (search, folders, drag, archived) works off the filtered view; the
  // Team section still gets the FULL list so an agent that is mid-turn in its
  // home chat still reads as "working".
  const workSessions = sessions.filter((s) => !s.metadata?.agentHome);
  const active = workSessions.filter((s) => !s.archived && matches(s, q));
  const archived = workSessions.filter((s) => s.archived && matches(s, q));

  let sections = [];
  if (mode === 'grouped') {
    const byStatus = new Map();
    for (const s of active) {
      const key = s.status || t('rail.noStatus');
      if (!byStatus.has(key)) byStatus.set(key, []);
      byStatus.get(key).push(s);
    }
    sections = [...byStatus.entries()]
      .sort((a, b) => statusSort(a[0], b[0]))
      .map(([label, items]) => ({ label, items, hasHeader: true }));
  }

  // Canonical flat-mode layout: one root axis holding folders + free sessions
  // (both sort by sortOrder), plus per-folder child lists. Built from ALL
  // active sessions (not the search-filtered view) so drops/menu moves always
  // operate on the full model.
  const bySort = (a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9);
  const allActive = workSessions.filter((s) => !s.archived);
  const folderById = new Map((folders || []).map((f) => [f.id, f]));
  const sessionById = new Map(allActive.map((s) => [s.id, s]));
  const folderKids = new Map();
  const freeActive = [];
  for (const s of allActive) {
    const fid = s.folderId && folderById.has(s.folderId) ? s.folderId : null;
    if (fid) {
      if (!folderKids.has(fid)) folderKids.set(fid, []);
      folderKids.get(fid).push(s);
    } else freeActive.push(s);
  }
  for (const list of folderKids.values()) list.sort(bySort);
  const rootEntries = [
    ...(folders || []).map((f) => ({
      type: 'folder',
      id: f.id,
      folder: f,
      ord: f.sortOrder ?? 1e9,
    })),
    ...freeActive
      .sort(bySort)
      .map((s) => ({ type: 'session', id: s.id, session: s, ord: s.sortOrder ?? 1e9 })),
  ].sort((a, b) => a.ord - b.ord);

  // RAIL1 §4/§5 — "out of context, say the parent". A session reads as a
  // child inside its own folder's card (indented on the hairline); everywhere else
  // (search, grouped-by-status, or a PM child sitting free at root) nothing
  // says whose it is. Prefer the folder (the visible group), then fall back to
  // metadata.master (the PM/controller that spawned it, for children with no
  // folder at all) — a session can't be foldered AND unfoldered, so these
  // never conflict.
  const parentInfoFor = (s) => {
    if (s.folderId && folderById.has(s.folderId)) {
      const f = folderById.get(s.folderId);
      const ctl = f.controllerSessionId ? sessionById.get(f.controllerSessionId) : null;
      return { label: f.name, color: ctl?.color || '#9a9a9a', targetId: f.controllerSessionId || null };
    }
    if (s.metadata?.master) {
      const m = sessionById.get(String(s.metadata.master));
      if (m && m.id !== s.id) {
        return { label: m.metadata?.ticket || m.title || m.id, color: m.color, targetId: m.id };
      }
    }
    return null;
  };

  // Selecting a session hidden inside a collapsed folder (search hit, deep
  // link) auto-expands the folder so the selection is visible.
  useEffect(() => {
    const sel = sessions.find((s) => s.id === selectedId);
    const f = sel?.folderId ? (folders || []).find((x) => x.id === sel.folderId) : null;
    if (f?.collapsed) api.patch(`/folders/${f.id}`, { collapsed: false }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // B5: keep the selected row visible — a session created from the launcher
  // lands at the bottom of a long list (y=914 in a 693px window) with nothing
  // scrolling to it. Retry briefly: the row may render a beat after the id.
  const selectedRowMounted = !!selectedId && sessions.some((s) => s.id === selectedId);
  useEffect(() => {
    if (!selectedRowMounted || typeof document === 'undefined') return;
    let tries = 0;
    let timer = null;
    const tick = () => {
      const el = document.querySelector(`[data-session-row="${selectedId}"]`);
      if (el) { try { el.scrollIntoView({ block: 'nearest' }); } catch {} return; }
      if (++tries < 8) timer = setTimeout(tick, 60);
    };
    tick();
    return () => { if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedRowMounted]);

  // D3 (C): "Needs you" pinned on top of the flat list — sessions waiting for the
  // human (a question, a permission, a take-over request). Not while searching
  // and not in the status grouping; the selected row is already open.
  const needsList = mode === 'flat' && !q
    ? allActive.filter((s) => s.id !== selectedRow && (needsAttention(s) || hasOpenScreenRequest(s)))
    : [];

  // Flat-mode drag-to-reorder (disabled while searching — the list is filtered).
  const canDragSessions = mode === 'flat' && !q;
  const onSDragStart = (e, id) => {
    sDragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
    // Cross-component payload: dropping a session on a chat composer attaches
    // it as a reference (the reorder path ignores this and uses sDragId).
    const s = sessions.find((x) => x.id === id);
    try {
      e.dataTransfer.setData('application/x-arigami-session', JSON.stringify({ id, title: s?.title || '' }));
      e.dataTransfer.setData('text/plain', s?.title || id);
    } catch { /* older engines can be picky about custom types */ }
  };
  // Every drop is applied atomically: mutate a copy of the canonical layout,
  // diff folder membership into `moves`, POST the whole thing once. One
  // broadcast burst — no window where a session is in a folder but unplaced.
  const buildModel = () => ({
    root: rootEntries.map((e) => ({ type: e.type, id: e.id })),
    folders: Object.fromEntries(
      [...folderById.keys()].map((fid) => [
        fid,
        (folderKids.get(fid) || []).map((s) => s.id),
      ])
    ),
  });
  const pullSession = (model, sid) => {
    model.root = model.root.filter((x) => !(x.type === 'session' && x.id === sid));
    for (const fid of Object.keys(model.folders))
      model.folders[fid] = model.folders[fid].filter((x) => x !== sid);
  };
  const commitDrop = (mutate) => {
    const model = buildModel();
    const before = {};
    for (const [fid, ids] of Object.entries(model.folders))
      for (const sid of ids) before[sid] = fid;
    mutate(model);
    const after = {};
    for (const [fid, ids] of Object.entries(model.folders))
      for (const sid of ids) after[sid] = fid;
    const moves = [];
    for (const sid of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if ((before[sid] || null) !== (after[sid] || null))
        moves.push({ sessionId: sid, folderId: after[sid] || null });
    }
    api.post('/rail/reorder', { ...model, moves }).catch(() => {});
  };

  const clearDrag = () => {
    setSOver(null);
    sDragId.current = null;
    fDragId.current = null;
  };
  const onSDragEnd = clearDrag;

  // Hover a session row. Three zones when "into" means something: on a free
  // root session it groups (create-folder), on a foldered session it moves the
  // drag into that folder — unless the drag is already there.
  const onSDragOver = (e, s) => {
    const fromF = fDragId.current;
    const fromS = sDragId.current;
    if (!fromF && !fromS) return;
    if (fromF && s.folderId) return; // folders never drop inside folders
    if (fromS === s.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move'; // show the move cursor, not "no-drop"
    const from = fromS ? allActive.find((x) => x.id === fromS) : null;
    const three =
      !fromF && (s.folderId ? (from?.folderId || null) !== s.folderId : true);
    const zone = dropZone(e, three);
    setSOver((prev) => (prev?.id === s.id && prev.zone === zone ? prev : { id: s.id, zone }));
  };
  const onSDrop = (e, s) => {
    e.preventDefault();
    e.stopPropagation();
    const fromF = fDragId.current;
    const fromS = sDragId.current;
    clearDrag();
    if (fromF) {
      if (s.folderId) return;
      const zone = dropZone(e);
      commitDrop((m) => {
        m.root = m.root.filter((x) => !(x.type === 'folder' && x.id === fromF));
        const ti = m.root.findIndex((x) => x.type === 'session' && x.id === s.id);
        if (ti < 0) return;
        m.root.splice(zone === 'after' ? ti + 1 : ti, 0, { type: 'folder', id: fromF });
      });
      return;
    }
    if (!fromS || fromS === s.id) return;
    const from = allActive.find((x) => x.id === fromS);
    if (s.folderId && folderById.has(s.folderId)) {
      const sameFolder = (from?.folderId || null) === s.folderId;
      const zone = dropZone(e, !sameFolder);
      commitDrop((m) => {
        pullSession(m, fromS);
        const list = m.folders[s.folderId] || (m.folders[s.folderId] = []);
        if (zone === 'into') list.push(fromS);
        else {
          const ti = list.indexOf(s.id);
          list.splice(zone === 'after' ? ti + 1 : ti, 0, fromS);
        }
      });
      return;
    }
    const zone = dropZone(e, true);
    if (zone === 'into') {
      // Grouping is confirmed in a dialog — the drop itself changes nothing.
      if (from) setFolderDialog({ type: 'create', target: s, dragged: from });
      return;
    }
    commitDrop((m) => {
      pullSession(m, fromS);
      const ti = m.root.findIndex((x) => x.type === 'session' && x.id === s.id);
      if (ti < 0) return;
      m.root.splice(zone === 'after' ? ti + 1 : ti, 0, { type: 'session', id: fromS });
    });
  };

  // Folder header targets: gaps reorder the root; the middle moves a dragged
  // session into the folder (folders can't nest, so folder-drags get gaps only).
  const onFDragStart = (e, fid) => {
    fDragId.current = fid;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', folderById.get(fid)?.name || fid);
    } catch { /* ignore */ }
  };
  const onFDragOver = (e, fid) => {
    const fromF = fDragId.current;
    const fromS = sDragId.current;
    if (!fromF && !fromS) return;
    if (fromF === fid) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const zone = dropZone(e, !fromF);
    setSOver((prev) => (prev?.id === fid && prev.zone === zone ? prev : { id: fid, zone }));
  };
  const onFDrop = (e, fid) => {
    e.preventDefault();
    e.stopPropagation();
    const fromF = fDragId.current;
    const fromS = sDragId.current;
    clearDrag();
    if (fromF) {
      if (fromF === fid) return;
      const zone = dropZone(e);
      commitDrop((m) => {
        m.root = m.root.filter((x) => !(x.type === 'folder' && x.id === fromF));
        const ti = m.root.findIndex((x) => x.type === 'folder' && x.id === fid);
        if (ti < 0) return;
        m.root.splice(zone === 'after' ? ti + 1 : ti, 0, { type: 'folder', id: fromF });
      });
      return;
    }
    if (!fromS) return;
    const zone = dropZone(e, true);
    commitDrop((m) => {
      pullSession(m, fromS);
      if (zone === 'into') {
        (m.folders[fid] = m.folders[fid] || []).push(fromS);
        return;
      }
      const ti = m.root.findIndex((x) => x.type === 'folder' && x.id === fid);
      if (ti < 0) return;
      m.root.splice(zone === 'after' ? ti + 1 : ti, 0, { type: 'session', id: fromS });
    });
  };

  // Bare area below the rows = drop at the end of the root (also the drag-out
  // path for a foldered session).
  const onListDragOver = (e) => {
    if (!canDragSessions || e.target !== e.currentTarget) return;
    if (!sDragId.current && !fDragId.current) return;
    e.preventDefault();
    setSOver((prev) => (prev?.id === '__end' ? prev : { id: '__end' }));
  };
  const onListDrop = (e) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const fromF = fDragId.current;
    const fromS = sDragId.current;
    clearDrag();
    if (fromF) {
      commitDrop((m) => {
        m.root = m.root.filter((x) => !(x.type === 'folder' && x.id === fromF));
        m.root.push({ type: 'folder', id: fromF });
      });
    } else if (fromS) {
      commitDrop((m) => {
        pullSession(m, fromS);
        m.root.push({ type: 'session', id: fromS });
      });
    }
  };

  // ⋯ menu escape hatch for drag-out: back to the root, end of the list.
  const removeFromFolder = (s) => {
    commitDrop((m) => {
      pullSession(m, s.id);
      m.root.push({ type: 'session', id: s.id });
    });
  };
  // B36: always confirm — an empty folder used to vanish on a single click.
  const deleteFolder = (folder) => setFolderDialog({ type: 'delete', folder, kids: folderKids.get(folder.id) || [] });

  const rowProps = (s, { muted } = {}) => ({
    session: s,
    selected: s.id === selectedRow,
    onSelect,
    onArchive,
    onRestore,
    onRestart,
    onDelete,
    onEdit,
    onRemoveFromFolder: s.folderId ? removeFromFolder : undefined,
    watch: watchFor(s.id),
    health: health?.[s.id],
    waiting: waitingBySession.get(s.id),
    muted,
  });

  // One draggable session row (used by every view). Always draggable so a
  // session can be dropped into a chat composer as a reference; the reorder
  // targets only wire up in flat mode, where the layout is manual.
  // RAIL1: `mark` renders a child (indented, lighter, on the hairline)
  // as belonging to its folder card even scanning fast; `parent` (from
  // `parentInfoFor`) is the opposite case — a row shown OUTSIDE its group,
  // which gets a small chip naming that group instead.
  const sessionRowEl = (s, { mark, parent } = {}) => {
    const zone = sOver?.id === s.id ? sOver.zone : null;
    const before = zone === 'before';
    const after = zone === 'after';
    return (
      <div
        key={s.id}
        draggable
        onDragStart={(e) => onSDragStart(e, s.id)}
        onDragEnd={onSDragEnd}
        onDragOver={canDragSessions ? (e) => onSDragOver(e, s) : undefined}
        onDrop={canDragSessions ? (e) => onSDrop(e, s) : undefined}
        className={`relative rounded-md ${zone === 'into' ? 'ring-1 ring-foreground/40 ring-inset' : ''}`}
        style={{
          paddingTop: before ? GAP : 0,
          paddingBottom: after ? GAP : 0,
          transition: 'padding 140ms ease',
        }}
      >
        {before && <DropLine pos="before" gap={GAP} />}
        {/* data-rowbody: the fixed-height slice dropZone measures (see dropZone) */}
        <div
          data-rowbody
          /* RAIL1 follow-up / RAILUI (H4 V2): no per-child glyph or strip — the
             children sit indented under the header next to one neutral
             hairline (see the wrapper below); `data-rail-child` is what marks
             a row as a member. */
          {...(mark ? { 'data-rail-child': '' } : {})}
        >
          {parent && (
            <div className="px-2.5 pt-1">
              <ParentChip info={parent} onSelect={onSelect} t={t} />
            </div>
          )}
          <Row {...rowProps(s, { muted: !!mark })} />
        </div>
        {after && <DropLine pos="after" gap={GAP} />}
      </div>
    );
  };

  const proxyUp = !!config;
  const serverCount = sessions.filter((s) => !s.archived).length;
  const rtl = document.documentElement.dir === 'rtl';

  return (
    <div
      className={
        isDesktop
          ? 'relative flex shrink-0 flex-col border-e border-border bg-rail'
          // Phone: the rail fills the start-edge Sheet App wraps it in.
          : 'flex h-full min-h-0 w-full flex-col bg-rail'
      }
      // The stored width is at UI size medium; it follows --ui-scale like the rows do.
      style={isDesktop ? { width: `calc(${railWidth}px * var(--ui-scale, 1))` } : undefined}
      data-rail
    >
      {/* drag handle on the rail's inner edge (desktop only) */}
      {isDesktop && (
        <div
          onMouseDown={startDrag}
          title={t('rail.dragToResize')}
          className={`absolute top-0 z-30 h-full w-1 cursor-col-resize transition-colors ${
            rtl ? 'left-0' : 'right-0'
          } ${dragging ? 'bg-foreground/25' : 'hover:bg-foreground/15'}`}
          style={{ transform: rtl ? 'translateX(-2px)' : 'translateX(2px)' }}
        />
      )}
      {/* brand row: the origami mark + wordmark and — desktop shell only, and
          only once a second machine exists — the machine switcher, end-justified
          against the wordmark; the phone drawer's close button sits at the end. */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <Logo size="1.25rem" />
        <span className="text-sm font-semibold tracking-tight text-foreground">Arigami</span>
        <MachineChip />
        {!isDesktop && (
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('rail.closeSessions')} className="ms-auto text-muted-foreground">
            <X />
          </Button>
        )}
      </div>
      {/* new session + search */}
      <div className="flex flex-col gap-2 px-3 pt-2 pb-2">
        <Button variant="default" onClick={onNew} data-rail-new className="w-full justify-start gap-2 text-foreground">
          <Plus /> {t('rail.newSession')}
        </Button>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQ('');
                e.currentTarget.blur();
              }
            }}
            aria-label={t('rail.searchSessions')}
            placeholder={t('rail.searchSessions')}
            className="ps-8 pe-8 text-base sm:text-sm"
          />
          <Kbd className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 coarse:hidden">/</Kbd>
        </div>
      </div>

      {/* header row + new folder + flat/grouped toggle */}
      <div className="flex items-center gap-1.5 ps-4 pe-3 pt-2 pb-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {mode === 'grouped' ? t('rail.groupedByStatus') : t('rail.activeCount', { n: active.length })}
        </span>
        {mode === 'flat' && (
          <Tip label={t('rail.newFolder')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('rail.newFolder')} onClick={() => setFolderDialog({ type: 'new' })} className="text-muted-foreground">
              <FolderPlus />
            </Button>
          </Tip>
        )}
        <span role="group" aria-label={t('rail.flatList')} className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
          {[
            ['flat', Rows3, t('rail.flatList')],
            ['grouped', Layers, t('rail.groupByStatus')],
          ].map(([key, Glyph, title]) => (
            <Tip key={key} label={title}>
              <button
                type="button"
                aria-label={title}
                aria-pressed={mode === key}
                onClick={() => setMode(key)}
                className={`flex size-6 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring coarse:size-9 ${
                  mode === key ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Glyph className="size-3.5" />
              </button>
            </Tip>
          ))}
        </span>
      </div>

      {/* rows */}
      <div
        className="thin-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 py-0.5"
        onDragOver={onListDragOver}
        onDrop={onListDrop}
      >
        {mode === 'grouped' ? (
          sections.map((sec) => (
            <div key={sec.label}>
              {sec.hasHeader && <GroupHeader label={statusLabel(sec.label)} count={sec.items.length} />}
              {sec.items.map((s) => sessionRowEl(s, { parent: parentInfoFor(s) }))}
            </div>
          ))
        ) : q ? (
          // Search flattens the layout: matching folders appear as bare header
          // rows, matching sessions carry a folder breadcrumb.
          <>
            {(folders || [])
              .filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
              .map((f) => (
                <div
                  key={f.id}
                  className="mb-px flex items-center gap-2 rounded-md px-2.5 py-1.5"
                >
                  <Folder className="size-4 text-muted-foreground" aria-hidden="true" />
                  <Truncate
                    text={f.name}
                    dir={dirOf(f.name)}
                    className="min-w-0 flex-1 text-start text-sm font-medium leading-tight text-foreground/90"
                  />
                  <span className="shrink-0 px-1.5 text-2xs tabular-nums leading-4 text-muted-foreground">
                    {(folderKids.get(f.id) || []).length}
                  </span>
                </div>
              ))}
            {active.map((s) => sessionRowEl(s, { parent: parentInfoFor(s) }))}
          </>
        ) : (
          <>
            {/* D3: what needs you is pinned on top — the same sessions stay in
                their own folder / place below (nothing moves, nothing is lost). */}
            {needsList.length > 0 && (
              <div data-rail-needs className="mb-1">
                <GroupHeader label={t('rail.needsYouGroup')} count={needsList.length} />
                {needsList.map((s) => (
                  <div key={`needs-${s.id}`}>
                    {parentInfoFor(s) && (
                      <div className="px-2.5 pt-1">
                        <ParentChip info={parentInfoFor(s)} onSelect={onSelect} t={t} />
                      </div>
                    )}
                    <Row {...rowProps(s)} pinned />
                  </div>
                ))}
              </div>
            )}
            {rootEntries.map((entry) => {
              if (entry.type !== 'folder')
                return sessionRowEl(entry.session, { parent: parentInfoFor(entry.session) });
              // In a project folder the controller has no row of its own — the
              // header embodies it — so it's filtered out of the member list.
              const controller = entry.folder.controllerSessionId
                ? allActive.find((s) => s.id === entry.folder.controllerSessionId) || null
                : null;
              const kids = (folderKids.get(entry.id) || []).filter(
                (s) => s.id !== controller?.id
              );
              // RAIL2: the group's colour now lives only in FolderRow's own
              // header (icon tint + selected-row treatment) — no card fill or
              // border here, so 8+ folder colours never wash the whole rail.
              const intoWhole = sOver?.id === entry.id && sOver.zone === 'into';
              return (
                <div
                  key={entry.id}
                  data-rail-folder={entry.id}
                  className={`rounded-md ${intoWhole ? 'ring-1 ring-foreground/40 ring-inset' : ''}`}
                >
                  <div
                    draggable
                    onDragStart={(e) => onFDragStart(e, entry.id)}
                    onDragEnd={onSDragEnd}
                    onDragOver={(e) => onFDragOver(e, entry.id)}
                    onDrop={(e) => onFDrop(e, entry.id)}
                    className="relative"
                    style={{
                      paddingTop: sOver?.id === entry.id && sOver.zone === 'before' ? GAP : 0,
                      paddingBottom: sOver?.id === entry.id && sOver.zone === 'after' ? GAP : 0,
                      transition: 'padding 140ms ease',
                    }}
                  >
                    {sOver?.id === entry.id && sOver.zone === 'before' && (
                      <DropLine pos="before" gap={GAP} />
                    )}
                    {sOver?.id === entry.id && sOver.zone === 'after' && (
                      <DropLine pos="after" gap={GAP} />
                    )}
                    <FolderRow
                      folder={entry.folder}
                      kids={kids}
                      controller={controller}
                      selectedId={selectedRow}
                      onSelect={onSelect}
                      watchFor={watchFor}
                      waitingBySession={waitingBySession}
                      over={sOver?.id === entry.id ? sOver : null}
                      onToggle={() =>
                        api
                          .patch(`/folders/${entry.id}`, { collapsed: !entry.folder.collapsed })
                          .catch(() => {})
                      }
                      onExpand={() =>
                        api.patch(`/folders/${entry.id}`, { collapsed: false }).catch(() => {})
                      }
                      onRename={() => setFolderDialog({ type: 'rename', folder: entry.folder })}
                      onMakeProject={() => {
                        // Prefill: the members' most common cwd (server falls
                        // back to the same heuristic when left empty).
                        const counts = new Map();
                        for (const k of kids) counts.set(k.cwd, (counts.get(k.cwd) || 0) + 1);
                        const defaultCwd =
                          [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
                        setFolderDialog({ type: 'make-project', folder: entry.folder, defaultCwd });
                      }}
                      onDelete={() => deleteFolder(entry.folder)}
                    />
                  </div>
                  {!entry.folder.collapsed && (
                    <div className={KIDS_CLS}>
                      {kids.map((s) => sessionRowEl(s, { mark: true }))}
                      {kids.length === 0 && (
                        <div className="px-2.5 py-1.5 text-2xs text-muted-foreground">
                          {t('rail.emptyFolderDrop')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {canDragSessions && (
              // pointer-events-none so the bare-area detection on the scroll
              // container still sees drops here as "end of list".
              <div
                className="pointer-events-none relative"
                style={{
                  height: sOver?.id === '__end' ? GAP : 0,
                  transition: 'height 140ms ease',
                }}
              >
                {sOver?.id === '__end' && <DropLine pos="before" gap={GAP} />}
              </div>
            )}
          </>
        )}
        {active.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {q ? t('rail.noSessionsMatch') : t('rail.noActiveSessions')}
          </div>
        )}

        {/* A1: the Team section — below folders/free sessions, above archived */}
        {!q && (
          <TeamSection
            agents={agents}
            sessions={sessions}
            triggers={triggers}
            agentOpen={agentOpen}
            onOpenAgent={onOpenAgent}
            open={teamOpen}
            onToggle={() => setTeamOpen((v) => !v)}
            waitingByAgent={waitingByAgent}
            // UX2: no interview session — the button opens the same agent surface
            // an existing agent uses, just in create mode (AgentView, slug '__new__').
            onNewAgent={() => openAgent('__new__', 'persona')}
          />
        )}

        {/* archived: collapsed group at the bottom */}
        {archived.length > 0 && (
          <div className="mt-2">
            <SectionToggle
              label={t('rail.archived')}
              count={archived.length}
              open={archivedOpen}
              onToggle={() => setArchivedOpen((v) => !v)}
              data-rail-archived
            />
            {archivedOpen &&
              archived.map((s) => (
                // Dimmed: archived rows read as history (their menus are portaled, so they stay full strength).
                <div key={s.id} className="opacity-70">
                  <Row {...rowProps(s)} />
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Pending tasks — stuck to the bottom, always visible (autoplay control) */}
      {(serverCount > 0 || (pending || []).length > 0) && (
      <PendingSection
        pending={pending || []}
        queue={queue || { autoplay: false, maxConcurrent: 3 }}
        onPreview={(t) => onPreviewTicket?.(t)}
        onOpenTriggers={onOpenTriggers}
      />
      )}

      {/* usage charts (session / week) — compact, above the footer. Reflects the
          active account (see activeUsage above). F8: hidden until the first
          session exists — a percentage without context on the first screen. */}
      {serverCount > 0 && <UsageMini usage={activeUsage} provider={activeEngine} />}
      {/* what the machine is doing — the snapshot sessions read via host_resources — under the usage */}
      <MachineMini />

      {/* footer: proxy status line, then the profile menu with the small utilities */}
      <div className="border-t border-border px-2 pt-1 pb-2">
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-2xs text-muted-foreground" data-rail-proxy>
          <StatusDot status={proxyUp ? 'ok' : conn === 'open' ? 'warn' : 'idle'} />
          <span className="min-w-0 flex-1 truncate">
            {proxyUp ? t('rail.proxyUp', { n: serverCount }) : t('rail.proxyUnreachable')}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <ProfileMenu
            active={(accounts?.accounts || []).find((a) => a.active) || null}
            onOpenSkills={onOpenSkills}
            onOpenBrain={onOpenBrain}
            onOpenSetup={onOpenSetup}
            onOpenSettings={onOpenSettings}
          />
          {/* VOICE1: voice COMMANDS (switch/create sessions, settings…) — the
              composer mic dictates; this one goes through the router. */}
          <MicButton
            mode="command"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground coarse:size-11"
          />
          {screenAvailable && (
            <Tip label={t('rail.screen')}>
              <Button variant="ghost" size="icon-sm" onClick={() => setScreenModal(true)} aria-label={t('rail.screen')} className="text-muted-foreground">
                <Monitor />
              </Button>
            </Tip>
          )}
          {/* Keyboard shortcuts: nothing to press on a phone — desktop only. */}
          {onOpenShortcuts && isDesktop && (
            <Tip label={t('rail.keyboardShortcutsTitle')}>
              <Button variant="ghost" size="icon-sm" onClick={onOpenShortcuts} aria-label={t('rail.keyboardShortcuts')} className="text-muted-foreground">
                <span aria-hidden="true">?</span>
              </Button>
            </Tip>
          )}
        </div>
      </div>

      {/* folder dialogs */}
      {folderDialog?.type === 'create' && (
        <CreateFolderDialog
          target={folderDialog.target}
          dragged={folderDialog.dragged}
          onClose={() => setFolderDialog(null)}
        />
      )}
      {(folderDialog?.type === 'new' || folderDialog?.type === 'rename') && (
        <FolderNameDialog folder={folderDialog.folder} onClose={() => setFolderDialog(null)} />
      )}
      {folderDialog?.type === 'delete' && (
        <DeleteFolderDialog
          folder={folderDialog.folder}
          children={folderDialog.kids}
          onClose={() => setFolderDialog(null)}
        />
      )}
      {folderDialog?.type === 'make-project' && (
        <MakeProjectDialog
          folder={folderDialog.folder}
          defaultCwd={folderDialog.defaultCwd}
          onClose={() => setFolderDialog(null)}
        />
      )}
    </div>
  );
}
