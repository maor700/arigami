import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { statusLabel } from '../lib/status.js';
import { relTime, fmtDateTime } from '../lib/time.js';
import { hasOpenScreenRequest, needsAttention, setScreenModal, signOut, useStore } from '../lib/store.js';
import { usePrefs, setPrefs, PREF_LIMITS } from '../lib/prefs.js';
import { api } from '../lib/api.js';
import { toast, toastError } from '../lib/toast.js';
import { Dot, tint, TriggerTag } from './ui.jsx';
import { Logo } from './Logo.jsx';
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
import { useT, dirOf } from '../lib/i18n.js';
import { useIsDesktop } from '../lib/useMedia.js';
import MicButton from './MicButton.jsx';
import { Icon } from '../lib/icons.js';
import {
  faBars,
  faBolt,
  faBoxArchive,
  faBrain,
  faCaretDown,
  faCaretRight,
  faCircleInfo,
  faDisplay,
  faEye,
  faFolder,
  faFolderPlus,
  faFolderTree,
  faGear,
  faRightFromBracket,
  faGripVertical,
  faListCheck,
  faPause,
  faPen,
  faPlay,
  faPuzzlePiece,
  faRotateLeft,
  faRotateRight,
  faTableCells,
  faToolbox,
  faTrash,
  faTriangleExclamation,
  faUserAstronaut,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

const STATUS_ORDER = ['Booting', 'In Progress', 'In Review', 'Blocked', 'Completed'];

// RES1 §4 — the supervisor's health dot. The badges beside it already say
// "working" and "needs you"; what the dot adds is the two states nothing else
// showed: a session the host is failing to recover (red) and one that has gone
// quiet with work still owed (also red — it is not fine, it is stuck).
const HEALTH_COLOR = { grey: '#9a9a9a', blue: '#2C6BD6', amber: '#CE8324', red: '#E0594F' };

function HealthDot({ health }) {
  const t = useT();
  // Grey means "nothing to report" — a dot on every row was noise, so only the
  // states the dot exists for (blue/amber/red) render.
  if (!health || !health.dot || health.dot === 'grey') return null;
  const color = HEALTH_COLOR[health.dot] || HEALTH_COLOR.grey;
  // An escalated session is not one the host is still working on — it is one it
  // gave up on, which is a different thing to tell the human.
  const label = health.escalated ? t('waiting.what.system') : t(`rail.health.${health.state}`);
  return (
    <span
      title={`${label} · ${health.reason}`}
      aria-label={label}
      className="inline-block h-[0.375rem] w-[0.375rem] shrink-0 rounded-full align-middle"
      style={{ background: color }}
    />
  );
}

// RES1 §4, toned down — and further, per direct feedback: no aggregated top
// section at all, just the row itself. A waiting item is a small, static
// badge on the row it actually belongs to: same size/shape/colour as the
// "needs you" `?` and screen take-over badges below (find `needsAttention` /
// `hasOpenScreenRequest`) — just without their pulse. Those two already cover
// the 'action'/'screen' waiting kinds on a session row; this is what shows for
// the rest (setup, review, merge, budget, system), for agent rows (which had
// no indicator at all), and rolled up (hollow, count-only) onto a collapsed
// folder or the collapsed Team header so nothing disappears behind a fold.
// Shows the count only once there's more than one thing waiting.
function WaitingBadge({ items, t }) {
  if (!items?.length) return null;
  const title = items
    .map((w) => `${t(`waiting.what.${w.kind}`)} · ${t(`waiting.do.${w.unblock}`)}`)
    .join('\n');
  return (
    <span
      title={title}
      className="flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full border border-ink bg-brand px-1 font-mono text-[0.6875rem] md:text-[0.625rem] font-bold text-[#1a1a1a]"
    >
      {items.length > 1 ? items.length : '!'}
    </span>
  );
}

// RAIL1 — a per-child rollup that survives a collapsed folder: one dot per
// kid (capped), coloured by its own state, so the header still answers "what's
// happening in here" without opening it. `needsAttention`/waiting map to the
// same amber as the row's own `?`/`!` badges; working reuses the brand blue.
function StateDots({ kids }) {
  if (!kids?.length) return null;
  const shown = kids.slice(0, 8);
  return (
    <span className="flex items-center gap-[0.1875rem]" aria-hidden="true">
      {shown.map((s) => {
        const attn = needsAttention(s);
        const working = ['working', 'restarting'].includes(s.claude?.state);
        const color = attn ? '#CE8324' : working ? '#2C6BD6' : '#9a9a9a';
        return (
          <span
            key={s.id}
            className="h-[0.3125rem] w-[0.3125rem] shrink-0 rounded-full"
            style={{ background: color }}
          />
        );
      })}
    </span>
  );
}

// RAIL1 §4/§5 — "out of context, say the parent". A small pill naming
// whichever folder/controller a session belongs to, shown wherever a row
// renders OUTSIDE its own group's card (search, grouped-by-status, a PM
// child sitting free at root) — `info` comes from `parentInfoFor`. Clicking
// it selects the parent (a plain folder with no controller has nothing
// selectable, so it renders as inert text instead of a button).
function ParentChip({ info, onSelect, t }) {
  if (!info) return null;
  const cls =
    'flex min-w-0 max-w-[8.125rem] shrink-0 items-center gap-1 truncate rounded-full border border-border px-1.5 py-px font-mono text-[0.6875rem] md:text-[0.5625rem] text-fgdim';
  const inner = (
    <>
      <Dot color={info.color} size={7} className="shrink-0" />
      <span className="min-w-0 truncate">{info.label}</span>
    </>
  );
  if (!info.targetId) {
    return (
      <span className={cls} title={t('rail.parentOf', { name: info.label })}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(info.targetId);
      }}
      title={t('rail.parentOf', { name: info.label })}
      className={`${cls} cursor-pointer hover:text-fg`}
    >
      {inner}
    </button>
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

function RowMenu({ session, onArchive, onRestore, onRestart, onDelete, onEdit, onRemoveFromFolder, onClose }) {
  const t = useT();
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-7 right-1.5 z-20 min-w-[10.25rem] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onEdit}
        className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
      >
        <span className="text-[0.6875rem] text-fgdim"><Icon icon={faPen} /></span> {t('rail.editDetails')}
      </button>
      {onRemoveFromFolder && (
        <button
          type="button"
          onClick={onRemoveFromFolder}
          className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
        >
          <span className="text-[0.6875rem] text-fgdim"><Icon icon={faFolder} /></span> {t('rail.removeFromFolder')}
        </button>
      )}
      {session.archived ? (
        <button
          type="button"
          onClick={onRestore}
          className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
        >
          <span className="text-[0.6875rem] text-fgdim"><Icon icon={faRotateLeft} /></span> {t('rail.restoreSession')}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={onRestart}
            className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
          >
            <span className="text-[0.6875rem] text-fgdim"><Icon icon={faRotateRight} /></span> {t('rail.restartSession')}
          </button>
          <button
            type="button"
            onClick={onArchive}
            className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
          >
            <span className="text-[0.6875rem] text-fgdim"><Icon icon={faBoxArchive} /></span> {t('rail.archiveSession')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full cursor-pointer items-center gap-2 bg-panel px-3 py-2 text-left text-xs text-danger hover:bg-danger/10"
      >
        <span className="text-[0.6875rem]"><Icon icon={faXmark} /></span> {t('rail.deletePermanently')}
      </button>
    </div>
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
          className="pointer-events-none fixed z-[70] max-w-[18.75rem] rounded-lg border-[1.5px] border-ink bg-panel px-3 py-2 text-[0.71875rem] leading-snug whitespace-pre-wrap text-fg shadow-[3px_3px_0_rgba(42,42,42,0.22)]"
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

// RAILUI — shared row vocabulary (rail-items-A-variants.html A1 +
// rail-h4-deep.html V2). One selected treatment for every kind of row: a
// neutral 6% fill and a 3px bar in the row's own colour drawn by ::before, so
// selecting never shifts the content the way a border did. The colour rides
// in on `--rail-c`. Port / ··· stay hidden until hover (always shown on touch).
const SEL_CLS =
  "bg-sel before:pointer-events-none before:absolute before:start-0 before:top-2 before:bottom-2 before:w-[0.1875rem] before:rounded-[3px] before:bg-(--rail-c) before:content-['']";
const HOVER_CLS = 'hover:bg-fg/[.035]';
const REVEAL_CLS = 'opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100';
const META_CLS = 'mt-[0.1875rem] flex items-center gap-1.5 text-[0.6875rem] leading-[1.3] text-fgdim';
const TIME_CLS = 'ms-auto shrink-0 font-mono text-[0.6875rem] md:text-[0.625rem] text-fgdim';
// H4 V2 — the children of a folder: 22px indent and one 1px vertical hairline
// (hair colour, never the project's) running down their side, no glyphs; 8px of
// air after each group (12px). Nest the same class again for depth 2 (+22px).
const KIDS_CLS =
  "relative mb-3 ps-[1.375rem] before:pointer-events-none before:absolute before:start-[0.9375rem] before:top-0.5 before:bottom-1.5 before:w-px before:bg-hair before:content-['']";
// The row's ⋯ menu. It painted at 17×17 — a coin-flip under a fingertip — so
// on a phone it keeps the same glyph and grows its padding to a ~32px box.
const DOTS_CLS =
  'shrink-0 cursor-pointer self-start rounded px-2 py-[0.4375rem] text-[0.8125rem] leading-none text-fgdim hover:text-fg md:px-0.5 md:py-0.5';
// The status word stays quiet (fgdim) — per feedback the only colour a row
// carries is its own dot/avatar; "needs you" and the working spinner are the
// two exceptions. Custom statuses are free text — truncate, never overflow.
function StatusWord({ children }) {
  return <span className="min-w-0 truncate">{children}</span>;
}

// "needs you" — the one loud element on a row (A1's pill). Same pulse and
// colours the `?` / screen badges had; only the shape changed.
function NeedsYouPill({ title, icon, children }) {
  return (
    <span
      title={title}
      className="pulse-yellow flex h-4 shrink-0 items-center gap-1 rounded-full border border-ink bg-brand px-1.5 font-sans text-[0.6875rem] md:text-[0.625rem] font-semibold leading-none text-[#1a1a1a]"
    >
      {icon && <Icon icon={icon} />}
      {children}
    </span>
  );
}

function Row({ session, selected, onSelect, menuOpen, setMenuFor, onArchive, onRestore, onRestart, onDelete, onEdit, onRemoveFromFolder, watch, health, waiting, muted }) {
  const t = useT();
  const color = session.color || '#c4c4c4';
  const label = session.metadata?.ticket || session.title || session.id;
  const showTitle = session.title && session.title !== label;
  const port = session.metadata?.port;
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
  // One meta line (A1): a single status word, coloured, picked by priority —
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
  // The title behind a ticket label folds into the meta line; the description
  // stays out of the rail altogether (it lives in the session's details).
  const secondary = showTitle ? session.title : null;
  // Child rows (inside a folder, `muted`) sit one step lighter than free rows:
  // 12.5/400 in fg2 with a 16px avatar; the selected child steps back up.
  const titleCls = muted
    ? selected
      ? 'text-[0.8125rem] font-medium text-fg'
      : 'text-[0.78125rem] font-normal text-fg2'
    : 'text-[0.8125rem] font-medium text-fg';
  return (
    <div
      ref={tip.ref}
      data-session-row={session.id}
      {...hoverProps}
      onClick={() => onSelect(session.id)}
      className={`group relative mb-[0.1875rem] grid cursor-pointer items-center gap-x-2 rounded-lg px-2 ${
        muted ? 'min-h-[2.5rem] grid-cols-[16px_1fr_auto] py-[0.4375rem]' : 'min-h-[2.875rem] grid-cols-[20px_1fr_auto] py-2'
      } ${selected ? SEL_CLS : HOVER_CLS}`}
      style={{ '--rail-c': color }}
    >
      {tip.tip}
      {agent ? (
        <AgentAvatar agent={{ ...agent, color }} size={muted ? 16 : 20} className="justify-self-center" />
      ) : (
        <Dot color={color} size={muted ? 8 : 9} className="justify-self-center" />
      )}
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <Truncate text={label} dir={dirOf(label)} className={`min-w-0 flex-1 text-left font-sans leading-tight [[dir=rtl]_&]:text-right ${titleCls}`} />
          {port != null && (
            <span className={`shrink-0 font-mono text-[0.6875rem] md:text-[0.65625rem] text-fgdim ${REVEAL_CLS}`}>:{port}</span>
          )}
          <span className="flex shrink-0 items-center gap-1.5">
            {watch && (
              <span
                title={
                  watch.errored
                    ? t('rail.listenerErrored')
                    : (watch.count > 1
                        ? t('rail.watchingSources', { n: watch.count })
                        : t('rail.watchingSource', { n: watch.count })) +
                      (watch.fired ? t('rail.firedSuffix', { n: watch.fired }) : '')
                }
                className={`flex items-center gap-0.5 font-mono text-[0.6875rem] md:text-[0.625rem] leading-none ${
                  watch.errored ? 'pulse-yellow text-danger' : 'text-fgdim'
                }`}
              >
                <span className="text-[0.6875rem]"><Icon icon={watch.errored ? faTriangleExclamation : faEye} /></span>
                {watch.count}
              </span>
            )}
            {!isDesktop && session.statusSummary?.tldr && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); tip.toggle(); }}
                title={t('rail.summary')}
                className="-my-2 flex h-[1.75rem] w-[1.75rem] shrink-0 items-center justify-center text-[0.6875rem] text-fgdim"
              >
                <Icon icon={faCircleInfo} />
              </button>
            )}
            {/* LADDER1: quietly says the session is on a weaker rung (server-derived claude.ladder). */}
            <LadderBadge session={session} compact />
            {/* One indicator, by priority: needs you (pill) › waiting (badge) › working (spinner, on the meta line) › status word. */}
            {screenReq ? (
              <NeedsYouPill title={t('rail.screenNeedsYou')} icon={faDisplay}>{t('rail.screenNeedsYouShort')}</NeedsYouPill>
            ) : attention ? (
              <NeedsYouPill title={t('rail.needsYourInput')}>{t('rail.needsYouPill')}</NeedsYouPill>
            ) : waiting?.length > 0 ? (
              <WaitingBadge items={waiting} t={t} />
            ) : null}
          </span>
        </span>
        {/* The meta line, in scan order: RES1's health dot, the (spinner +)
            status word, UX1's agent button ("whose job this is" — a click
            target, so it sits outside the truncating span), the folded
            secondary text, the trigger bolt, and the time pinned to the end. */}
        <span className={META_CLS}>
          <HealthDot health={health} />
          {(working || restarting) && (
            <span title={restarting ? t('rail.restartingEllipsis') : t('rail.workingEllipsis')} className="host-spinner h-[0.625rem] w-[0.625rem] shrink-0" />
          )}
          {statusWord && <StatusWord>{statusWord}</StatusWord>}
          {/* UX1: born from an agent — the row wears its face AND says whose job
              this is, so a work session never reads as "the agent itself". */}
          {agent && (
            <button
              type="button"
              data-row-agent={agent.slug}
              title={t('session.bornFromTitle', { name: agent.name })}
              onClick={(e) => { e.stopPropagation(); openAgent(agent.slug); }}
              className="shrink-0 cursor-pointer py-1.5 text-[0.6875rem] hover:underline md:py-0 md:text-[0.65625rem]"
              style={{ color: agent.color || undefined }}
            >
              · {agent.name}
            </button>
          )}
          {secondary && <Truncate as="span" text={`· ${secondary}`} dir={dirOf(secondary)} className="min-w-0 text-left [[dir=rtl]_&]:text-right" />}
          {session.metadata?.fromTriggerName && (
            <TriggerTag name={session.metadata.fromTriggerName} showName={false} className="shrink-0 text-[0.6875rem] md:text-[0.625rem]" />
          )}
          <span className={TIME_CLS}>{relTime(session.updatedAt || session.createdAt)}</span>
        </span>
      </span>
      <button
        type="button"
        title={t('rail.sessionActions')}
        onClick={(e) => {
          e.stopPropagation();
          setMenuFor(menuOpen ? null : session.id);
        }}
        className={`${DOTS_CLS} ${menuOpen ? '' : REVEAL_CLS}`}
      >
        ···
      </button>
      {menuOpen && (
        <RowMenu
          session={session}
          onClose={() => setMenuFor(null)}
          onRemoveFromFolder={
            onRemoveFromFolder
              ? () => {
                  setMenuFor(null);
                  onRemoveFromFolder(session);
                }
              : undefined
          }
          onEdit={() => {
            setMenuFor(null);
            onEdit(session);
          }}
          onArchive={() => {
            setMenuFor(null);
            onArchive(session);
          }}
          onRestore={() => {
            setMenuFor(null);
            onRestore(session);
          }}
          onRestart={() => {
            setMenuFor(null);
            onRestart(session);
          }}
          onDelete={() => {
            setMenuFor(null);
            onDelete(session);
          }}
        />
      )}
    </div>
  );
}

// A1 — the "צוות" (team) section: one row per agent, BELOW folders/free
// sessions and above the archived group. Status: working when any live session
// born from the agent is mid-turn, else its WORK-session count / idle.
// A2: an idle agent with an enabled cron job shows its NEXT run instead
// ("⏰ in 3h"), read from the store's triggers (`agent` + `nextRunAt`).
// UX1: a row is a door to the agent SURFACE (#/agents/<slug>), whose בית tab is
// the DM chat — the home chat is not a session row anymore, so "click an agent"
// and "open a session" stopped looking like the same act. ⋯ still offers both
// doors explicitly (בית / the persona page).
export { nextCronFor };
export function TeamSection({ agents, sessions, triggers, onOpenAgent, onNewAgent, agentOpen, open, onToggle, menuFor, setMenuFor, waitingByAgent }) {
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
  // roll the total up onto the header count, same hollow idiom as a folder.
  const hiddenWaiting = open
    ? 0
    : [...(waitingByAgent?.values() || [])].reduce((n, items) => n + items.length, 0);
  return (
    <div data-rail-team className="mt-2">
      <div className="flex w-full items-center gap-[0.4375rem] px-1.5 pt-[0.5625rem] pb-1">
        <button
          type="button"
          onClick={onToggle}
          title={hiddenWaiting ? t('rail.waitingInsideClick', { n: hiddenWaiting }) : t('agent.oneLiner')}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-[0.4375rem] py-1.5 md:py-0"
        >
          <span className={`text-[0.6875rem] md:text-[0.5625rem] text-fgdim ${open ? '' : 'mirror-rtl'}`}><Icon icon={open ? faCaretDown : faCaretRight} /></span>
          <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] tracking-[0.06em] text-fgdim uppercase">{t('rail.team')}</span>
          <span className={`font-mono text-[0.6875rem] md:text-[0.59375rem] ${hiddenWaiting ? 'font-bold text-fg' : 'text-fgdim'}`}>
            {list.length}
            {hiddenWaiting ? ` · !${hiddenWaiting > 1 ? hiddenWaiting : ''}` : ''}
          </span>
          <span className="h-px flex-1 bg-hair" />
        </button>
        <button
          type="button"
          data-rail-team-new
          onClick={onNewAgent}
          title={t('rail.teamNewAgent')}
          className="shrink-0 cursor-pointer rounded-md border border-border bg-panel px-[0.4375rem] py-2 font-mono text-[0.6875rem] leading-none text-fgdim hover:border-ink hover:text-fg md:py-[0.1875rem] md:text-[0.625rem]"
        >
          {t('rail.teamNewAgent')}
        </button>
      </div>
      {open && list.length === 0 && (
        <div className="px-2 py-1.5 text-[0.6875rem] md:text-[0.625rem] text-fgdim italic">{t('rail.teamEmpty')}</div>
      )}
      {open && list.length > 0 && (
        <div className="px-2 pb-1 text-[0.6875rem] md:text-[0.59375rem] leading-tight text-fgdim italic">{t('agent.oneLiner')}</div>
      )}
      {open &&
        list.map((a) => {
          const mine = byAgent.get(a.slug) || [];
          const working = mine.some((s) => s.claude?.state === 'working');
          // UX1: the count is WORK sessions — the home chat is the agent, not a job it is doing.
          const runs = mine.filter((s) => !s.metadata?.agentHome);
          const nextCron = runs.length === 0 ? nextCronFor(a.slug, triggers) : null;
          const surfaceOpen = agentOpen === a.slug;
          const menuOpen = menuFor === `agent:${a.slug}`;
          const mineWaiting = waitingByAgent?.get(a.slug) || [];
          return (
            <div
              key={a.slug}
              data-rail-agent={a.slug}
              onClick={() => onOpenAgent?.(a.slug, 'home')}
              // The skills list left the row (detail); it lives in the tooltip now.
              title={a.skills?.length ? a.skills.join(' · ') : t('agent.oneLiner')}
              className={`group relative mb-[0.1875rem] grid min-h-[2.875rem] cursor-pointer grid-cols-[20px_1fr_auto] items-center gap-x-2 rounded-lg px-2 py-2 ${surfaceOpen ? SEL_CLS : HOVER_CLS}`}
              style={{ '--rail-c': a.color }}
            >
              <AgentAvatar agent={a} size={20} className="justify-self-center" />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <Truncate text={a.name} dir={dirOf(a.name)} className="min-w-0 flex-1 text-left font-sans text-[0.8125rem] font-medium leading-tight text-fg [[dir=rtl]_&]:text-right" />
                  {mineWaiting.length > 0 && <WaitingBadge items={mineWaiting} t={t} />}
                </span>
                <span className={META_CLS}>
                  {working ? (
                    <>
                      <span title={t('rail.teamWorking')} className="host-spinner h-[0.625rem] w-[0.625rem] shrink-0" />
                      <StatusWord>{t('rail.teamWorking')}</StatusWord>
                    </>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1.5" {...(nextCron ? { 'data-agent-next-cron': String(nextCron), title: t('rail.teamNextCronTitle', { when: fmtDateTime(nextCron) }) } : {})}>
                      <span className="h-[0.4375rem] w-[0.4375rem] rounded-full" style={{ background: runs.length || nextCron ? a.color : '#c4c4c4', opacity: runs.length ? 1 : nextCron ? 0.55 : 1 }} />
                      {nextCron ? t('rail.teamNextCron', { when: untilTime(nextCron, t) }) : runs.length === 0 ? t('rail.teamIdle') : runs.length === 1 ? t('rail.teamSession') : t('rail.teamSessions', { n: runs.length })}
                    </span>
                  )}
                </span>
              </span>
              <button
                type="button"
                title={t('rail.teamActions')}
                onClick={(e) => { e.stopPropagation(); setMenuFor(menuOpen ? null : `agent:${a.slug}`); }}
                className={`${DOTS_CLS} ${menuOpen ? '' : REVEAL_CLS}`}
              >
                ···
              </button>
              {menuOpen && (
                <div onClick={(e) => e.stopPropagation()} className="absolute end-1 top-8 z-20 min-w-[9.375rem] rounded-[8px] border border-border bg-panel p-1 shadow-[3px_3px_0_#2a2a2a]">
                  <button type="button" data-agent-menu-home onClick={() => { setMenuFor(null); onOpenAgent?.(a.slug, 'home'); }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-start text-[0.71875rem] text-fg hover:bg-chip">
                    <span className="w-4 text-center text-fgdim"><Icon icon={faPlay} /></span> {t('rail.teamHomeChat')}
                  </button>
                  <button type="button" data-agent-menu-runs onClick={() => { setMenuFor(null); onOpenAgent?.(a.slug, 'runs'); }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-start text-[0.71875rem] text-fg hover:bg-chip">
                    <span className="w-4 text-center text-fgdim"><Icon icon={faListCheck} /></span> {t('agent.page.tab.runs')}
                  </button>
                  <button type="button" onClick={() => { setMenuFor(null); onOpenAgent?.(a.slug, 'persona'); }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-start text-[0.71875rem] text-fg hover:bg-chip">
                    <span className="w-4 text-center text-fgdim"><Icon icon={faUserAstronaut} /></span> {t('rail.teamOpenPage')}
                  </button>
                  <button
                    type="button"
                    data-agent-menu-delete
                    onClick={async () => { setMenuFor(null); await deleteAgentConfirmed(a, t); }}
                    className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded border-t border-hair px-2 py-1.5 pt-2 text-start text-[0.71875rem] text-danger hover:bg-danger/10"
                  >
                    <span className="w-4 text-center"><Icon icon={faTrash} /></span> {t('agent.page.delete')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

// How far a row's neighbours part to open a drop slot (px). Roughly half a row
// so it reads as "space for the dragged item".
const GAP = 24;

// Notion-style insertion indicator: a thin brand line with a leading dot,
// centered inside the gap the neighbouring rows opened for it (or hugging the
// edge when no gap animation is in play, e.g. the Pending list).
function DropLine({ pos, gap = 0 }) {
  const offset = gap ? gap / 2 - 1.25 : -2.5;
  return (
    <span
      className="pointer-events-none absolute inset-x-1 z-10 flex items-center"
      style={pos === 'before' ? { top: offset } : { bottom: offset }}
    >
      <span className="h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full border-2 border-brand bg-rail" />
      <span className="h-[0.15625rem] flex-1 rounded-full bg-brand" />
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
    <div className="flex items-center gap-[0.4375rem] px-1.5 pt-[0.5625rem] pb-1">
      <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] tracking-[0.06em] text-fgdim uppercase">
        {label}
      </span>
      <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] text-fgdim">{count}</span>
      <span className="h-px flex-1 bg-hair" />
    </div>
  );
}

function FolderMenu({ onRename, onMakeProject, onDelete, onClose }) {
  const t = useT();
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-7 right-1.5 z-20 min-w-[10.25rem] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onRename}
        className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
      >
        <span className="text-[0.6875rem] text-fgdim"><Icon icon={faPen} /></span> {t('rail.renameFolder')}
      </button>
      {onMakeProject && (
        <button
          type="button"
          onClick={onMakeProject}
          className="flex w-full cursor-pointer items-center gap-2 border-b border-hair bg-panel px-3 py-2 text-left text-xs text-fg hover:bg-chip"
        >
          <span className="text-[0.6875rem] text-fgdim"><Icon icon={faFolderTree} /></span> {t('rail.makeProjectFolder')}
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full cursor-pointer items-center gap-2 bg-panel px-3 py-2 text-left text-xs text-danger hover:bg-danger/10"
      >
        <span className="text-[0.6875rem]"><Icon icon={faXmark} /></span> {t('rail.deleteFolder')}
      </button>
    </div>
  );
}

// Folder header row. Badge language (decision record §6): indicators next to
// the NAME belong to the folder's own session — in a PROJECT folder the header
// IS the controller (clicking the name selects it; the chevron collapses) —
// while delegated child indicators are hollow / unfilled and live on the count
// chip at the far edge, surfacing only while the folder is collapsed.
function FolderRow({
  folder,
  kids,
  controller,
  selectedId,
  onSelect,
  watchFor,
  waitingBySession,
  over,
  menuOpen,
  setMenuFor,
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
  // vanish entirely — roll it up onto the count chip, same hollow idiom as
  // the needsAttention rollup below.
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

  return (
    <div
      ref={tip.ref}
      onMouseEnter={tip.show}
      onMouseLeave={tip.hide}
      data-rowbody
      onClick={() => (isProject ? onSelect(controller.id) : onToggle())}
      className={`group relative mb-[0.1875rem] grid min-h-[2.875rem] cursor-pointer grid-cols-[12px_22px_1fr_auto] items-center gap-x-2 rounded-lg px-2 py-2 ${
        ctlSelected ? SEL_CLS : HOVER_CLS
      } ${over?.zone === 'into' ? 'ring-1 ring-brand ring-inset' : ''}`}
      // RAIL2 — the group's colour lives only here, in the header (avatar
      // tint + selected bar); the children below carry a neutral hairline.
      style={{ '--rail-c': ctlColor }}
    >
      {tip.tip}
      <button
        type="button"
        title={collapsed ? t('rail.expandFolder') : t('rail.collapseFolder')}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="-mx-1.5 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-[0.6875rem] leading-none text-fgdim hover:text-fg md:h-6 md:w-6 md:text-[0.625rem]"
      >
        <span className={collapsed ? 'mirror-rtl' : undefined}>
          <Icon icon={collapsed ? faCaretRight : faCaretDown} />
        </span>
      </button>
      {isProject ? (
        ctlAgent ? (
          <span title={t('rail.projectFolderHint')} className="flex">
            <AgentAvatar agent={{ ...ctlAgent, color: ctlColor }} size={22} />
          </span>
        ) : (
          <span
            className="flex h-[1.375rem] w-[1.375rem] shrink-0 items-center justify-center rounded-full text-[0.6875rem]"
            style={{ background: `${ctlColor}22`, border: `1.5px solid ${ctlColor}`, color: ctlColor }}
            title={t('rail.projectFolderHint')}
            aria-hidden="true"
          >
            <Icon icon={faFolderTree} />
          </span>
        )
      ) : (
        <span className="justify-self-center text-[0.9375rem] text-fgdim" aria-hidden="true">
          <Icon icon={faFolder} />
        </span>
      )}
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <Truncate
            text={folder.name}
            dir={dirOf(folder.name)}
            className={`min-w-0 flex-1 text-left font-sans text-[0.875rem] leading-tight [[dir=rtl]_&]:text-right ${isProject ? 'font-semibold text-fg' : 'font-medium text-fg2'}`}
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
              <span
                title={t('rail.folderListenerErrored')}
                className="text-[0.6875rem] text-danger opacity-80"
              >
                <Icon icon={faTriangleExclamation} />
              </span>
            )}
            {!attention && working && (
              <span title={t('rail.folderSessionWorking')} className="host-spinner h-[0.625rem] w-[0.625rem]" />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onExpand();
              }}
              title={[
                count === 1 ? t('rail.oneSession', { n: count }) : t('rail.nSessions', { n: count }),
                attention ? t('rail.needsInputClick', { n: attention }) : null,
                waitingHidden ? t('rail.waitingInsideClick', { n: waitingHidden }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              className={`shrink-0 cursor-pointer rounded-full px-2 py-1.5 font-mono text-[0.6875rem] leading-4 md:px-1.5 md:py-0 md:text-[0.625rem] ${
                hot ? 'border border-brand bg-transparent font-semibold text-fg' : 'text-fgdim'
              }`}
            >
              {count}
              {attention ? ` · ?${attention > 1 ? attention : ''}` : ''}
              {waitingHidden ? ` · !${waitingHidden > 1 ? waitingHidden : ''}` : ''}
            </button>
          </span>
        </span>
        <span className={META_CLS}>
          {(ctlWorking || ctlRestarting) && (
            <span
              title={ctlRestarting ? t('rail.controllerRestarting') : t('rail.controllerWorking')}
              className="host-spinner h-[0.625rem] w-[0.625rem] shrink-0"
            />
          )}
          {isProject && <span className="shrink-0">{t('rail.managerChip')} ·</span>}
          {statusWord && <StatusWord>{statusWord}</StatusWord>}
          {descLine && <Truncate as="span" text={`· ${descLine}`} dir={dirOf(descLine)} className="min-w-0 text-left [[dir=rtl]_&]:text-right" />}
          {time && <span className={TIME_CLS}>{time}</span>}
        </span>
      </span>
      <button
        type="button"
        title={t('rail.folderActions')}
        onClick={(e) => {
          e.stopPropagation();
          setMenuFor(menuOpen ? null : folder.id);
        }}
        className={`${DOTS_CLS} ${menuOpen ? '' : REVEAL_CLS}`}
      >
        ···
      </button>
      {menuOpen && (
        <FolderMenu
          onClose={() => setMenuFor(null)}
          onRename={() => {
            setMenuFor(null);
            onRename();
          }}
          onMakeProject={
            isProject
              ? undefined
              : () => {
                  setMenuFor(null);
                  onMakeProject();
                }
          }
          onDelete={() => {
            setMenuFor(null);
            onDelete();
          }}
        />
      )}
    </div>
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
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(e, item.id)}
      onDrop={(e) => onDrop(e, item.id)}
      onClick={() => !isEmpty && onPreview(item.ticket)}
      title={isEmpty ? t('rail.emptySessionPlay') : t('rail.clickPreviewTicket')}
      className={`group relative mb-0.5 flex items-center gap-1.5 rounded-[7px] border border-dashed border-border px-2 py-1.5 ${
        isEmpty ? '' : 'cursor-pointer hover:bg-chip'
      }`}
    >
      {over && <DropLine pos={over} />}
      <span className="shrink-0 cursor-grab text-[0.6875rem] md:text-[0.625rem] leading-none text-fgdim" title={t('rail.dragToReorder')}>
        <Icon icon={faGripVertical} />
      </span>
      <span className="shrink-0 font-mono text-[0.6875rem] font-bold text-fgdim">
        {isEmpty ? '◇' : item.ticket}
      </span>
      <Truncate text={item.title} className="min-w-0 flex-1 text-[0.71875rem] text-fgdim" />
      <span
        title={t('rail.fromX', { x: item.triggerName })}
        className="max-w-[4.25rem] shrink-0 truncate rounded-[4px] bg-chip px-1.5 py-px text-[0.6875rem] md:text-[0.5625rem] text-fgdim"
      >
        {item.triggerName}
      </span>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        title={t('rail.startNow')}
        className="shrink-0 cursor-pointer rounded px-1 text-[0.75rem] leading-none text-[#3C9A4E] hover:bg-chip disabled:opacity-40"
      >
        <Icon icon={faPlay} />
      </button>
      <button
        type="button"
        onClick={dismiss}
        title={t('rail.dismiss')}
        className="shrink-0 cursor-pointer rounded px-1 text-[0.75rem] leading-none text-fgdim hover:text-danger"
      >
        <Icon icon={faXmark} />
      </button>
    </div>
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
    <div className="shrink-0 border-t border-hair bg-rail">
      <div className="flex items-center gap-[0.4375rem] px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-[0.4375rem] py-1.5 md:py-0"
          title={open ? t('rail.collapse') : t('rail.expand')}
        >
          <span className={`text-[0.6875rem] md:text-[0.5625rem] text-fgdim ${open ? '' : 'mirror-rtl'}`}><Icon icon={open ? faCaretDown : faCaretRight} /></span>
          <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] tracking-[0.06em] text-fgdim uppercase">
            {t('rail.pendingTasks')}
          </span>
          <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] text-fgdim">{pending.length}</span>
        </button>
        <button
          type="button"
          onClick={onOpenTriggers}
          title={t('rail.manageTriggers')}
          className="shrink-0 cursor-pointer rounded-[5px] border border-border px-1.5 py-1.5 text-[0.6875rem] text-fgdim hover:border-ink md:py-[0.125rem] md:text-[0.59375rem]"
        >
          <Icon icon={faBolt} /> {t('rail.triggers')}
        </button>
        <button
          type="button"
          onClick={toggleAutoplay}
          title={queue.autoplay ? t('rail.autoplayOnPause') : t('rail.autoplayOffStart')}
          className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border text-[0.6875rem] leading-none md:h-5 md:w-5 md:text-[0.625rem] ${
            queue.autoplay ? 'border-ink bg-brand text-fg' : 'border-border bg-panel text-fgdim hover:border-ink'
          }`}
        >
          <Icon icon={queue.autoplay ? faPause : faPlay} />
        </button>
        <span title={t('rail.maxConcurrent')} className="flex shrink-0 items-center gap-0.5 text-[0.6875rem] md:text-[0.59375rem] text-fgdim">
          <span>×</span>
          <input
            type="number"
            min="1"
            max="10"
            value={maxDraft}
            onChange={(e) => setMaxDraft(e.target.value)}
            onBlur={commitMax}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="w-8 rounded-[4px] border border-border bg-panel px-1 py-px text-center font-mono text-[0.6875rem] md:text-[0.625rem] outline-none focus:border-ink"
          />
        </span>
      </div>
      {open && (
        <div className="thin-scroll max-h-[38vh] overflow-y-auto px-[0.4375rem] pb-2">
          {pending.length === 0 ? (
            <div className="px-2 py-2.5 text-center text-[0.6875rem] text-fgdim">
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
  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    signOut();
  };
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const ref = useRef(null); // trigger wrapper
  const btnRef = useRef(null); // trigger button
  const menuRef = useRef(null); // portaled menu
  useEffect(() => {
    if (!open) return undefined;
    // The menu is portaled to <body>, so outside-click must accept clicks in
    // either the trigger or the menu itself.
    const onDoc = (e) => {
      if (ref.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((v) => !v);
  };

  const label = active?.label || t('rail.noAccount');
  const initial = (label.trim()[0] || '?').toUpperCase();
  const act = (fn) => () => { setOpen(false); fn?.(); };

  const Item = ({ icon, children, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] text-fg hover:bg-chip"
    >
      <span className="w-4 shrink-0 text-center text-[0.8125rem]"><Icon icon={icon} /></span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );

  const MENU_W = 208; // w-52
  const menu = open && rect
    ? createPortal(
        <div
          ref={menuRef}
          dir="auto"
          className="fixed z-[70] w-52 overflow-hidden rounded-[8px] border border-border bg-panel py-1 text-fg shadow-lg"
          style={{
            bottom: Math.round(window.innerHeight - rect.top + 6),
            left: Math.round(Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8))),
          }}
        >
          <div className="border-b border-hair px-2.5 pb-1 pt-1 text-[0.6875rem] md:text-[0.5625rem] tracking-[0.08em] text-fgdim uppercase">
            {t('rail.runningAs')}
          </div>
          <div className="flex items-center gap-2 border-b border-hair px-2.5 py-1.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-chip text-[0.6875rem] font-bold text-fg">{initial}</span>
            <span className="min-w-0 truncate text-[0.75rem] font-bold text-fg">{label}</span>
          </div>
          <Item icon={faPuzzlePiece} onClick={act(onOpenSkills)}>{t('rail.skills')}</Item>
          <Item icon={faBrain} onClick={act(onOpenBrain)}>{t('rail.brain')}</Item>
          <Item icon={faToolbox} onClick={act(onOpenSetup)}>{t('rail.setup')}</Item>
          <Item icon={faGear} onClick={act(onOpenSettings)}>{t('rail.settings')}</Item>
          {canLogout && (
            <div className="mt-1 border-t border-hair pt-1">
              <Item icon={faRightFromBracket} onClick={act(logout)}>{t('auth.settings.logout')}</Item>
            </div>
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={ref} className="relative me-auto">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={t('rail.profileSettings')}
        className="flex items-center gap-1.5 rounded-[6px] border border-border px-1.5 py-1 text-fgdim hover:border-ink hover:text-fg"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-chip text-[0.6875rem] md:text-[0.625rem] font-bold text-fg">{initial}</span>
        <span className="max-w-[5.25rem] truncate text-[0.6875rem] md:text-[0.65625rem]">{label}</span>
        <span className="text-[0.6875rem] md:text-[0.5625rem]"><Icon icon={faCaretDown} /></span>
      </button>
      {menu}
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
  mobileOpen = false,
  onClose,
  onPreviewTicket,
  onOpenTriggers,
  onOpenShortcuts,
  onOpenAgent,
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('flat'); // 'flat' | 'grouped'
  const [menuFor, setMenuFor] = useState(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(true); // A1: the "צוות" section
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
  const activeUsage = (accounts?.activeId && accountUsage?.[accounts.activeId]) || usage;
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
  // UX1: an agent's home chat is the בית tab of its agent surface, not a row
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
    menuOpen: menuFor === s.id,
    setMenuFor,
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
        className={`relative rounded-[8px] ${zone === 'into' ? 'ring-1 ring-brand ring-inset' : ''}`}
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
            <div className="px-2 pt-1">
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
      className={`flex shrink-0 flex-col border-e border-border bg-rail transition-transform md:relative md:z-auto md:translate-x-0 ${
        isDesktop
          ? 'relative'
          // The drawer lives on the START edge — the same edge the hamburger
          // that opens it sits on. `left-0`/`-translate-x-full` were physical,
          // so in Hebrew (RTL) the button was top-RIGHT and the drawer still
          // slid in from the LEFT, across the whole screen.
          : `fixed inset-y-0 start-0 z-50 w-[82%] max-w-[20rem] ${
              mobileOpen ? 'translate-x-0' : rtl ? 'translate-x-full' : '-translate-x-full'
            }`
      }`}
      // The stored width is at UI size medium; it follows --ui-scale like the rows do.
      style={isDesktop ? { width: `calc(${railWidth}px * var(--ui-scale, 1))` } : undefined}
    >
      {/* drag handle on the rail's inner edge (desktop only) */}
      {isDesktop && (
        <div
          onMouseDown={startDrag}
          title={t('rail.dragToResize')}
          className={`absolute top-0 z-30 h-full w-1 cursor-col-resize ${
            rtl ? 'left-0' : 'right-0'
          } ${dragging ? 'bg-brand' : 'hover:bg-brand/60'}`}
          style={{ transform: rtl ? 'translateX(-2px)' : 'translateX(2px)' }}
        />
      )}
      {/* brand row: the origami mark + wordmark (the tab bar's glyph moved here) */}
      <div className="flex items-center gap-2 px-[0.8125rem] pt-3 pb-1">
        <Logo size="1.25rem" />
        <span className="text-[0.8125rem] font-bold tracking-wide text-fg">Arigami</span>
      </div>
      {/* new session (+ mobile drawer close) + search */}
      <div className="border-b border-hair px-[0.8125rem] pt-2 pb-3">
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={onNew}
            className="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-ink bg-brand px-2.5 py-2 text-[0.8125rem] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[1px_1px_0_#2a2a2a]"
          >
            <span className="text-base leading-none">+</span> {t('rail.newSession')}
          </button>
          {!isDesktop && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('rail.closeSessions')}
              className="flex w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border-[1.5px] border-border bg-panel text-[0.8125rem] text-fgdim"
            >
              <Icon icon={faXmark} />
            </button>
          )}
        </div>
        <div className="mt-2.5 flex items-center gap-[0.4375rem] rounded-[7px] border-[1.5px] border-border bg-panel px-2 py-1.5 focus-within:border-fgdim">
          <span className="h-[0.6875rem] w-[0.6875rem] shrink-0 rounded-full border-[1.5px] border-fgdim" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQ('');
                e.currentTarget.blur();
              }
            }}
            placeholder={t('rail.searchSessions')}
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-fgdim sm:text-xs"
          />
          <span className="shrink-0 rounded-[3px] border border-border px-1 py-px font-mono text-[0.6875rem] md:text-[0.625rem] text-fgdim">
            /
          </span>
        </div>
      </div>

      {/* header row + flat/grouped toggle */}
      <div className="flex items-center gap-2 px-[0.8125rem] pt-[0.5625rem] pb-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] md:text-[0.65625rem] tracking-[0.08em] text-fgdim uppercase">
          {mode === 'grouped' ? t('rail.groupedByStatus') : t('rail.activeCount', { n: active.length })}
        </span>
        {mode === 'flat' && (
          <button
            type="button"
            title={t('rail.newFolder')}
            onClick={() => setFolderDialog({ type: 'new' })}
            className="shrink-0 cursor-pointer rounded-md border border-border bg-panel px-[0.4375rem] py-2 text-[0.6875rem] leading-none text-fgdim hover:border-ink hover:text-fg md:py-[0.1875rem]"
          >
            <Icon icon={faFolderPlus} />
          </button>
        )}
        <span className="flex shrink-0 overflow-hidden rounded-md border border-border">
          {[
            ['flat', faBars, t('rail.flatList')],
            ['grouped', faTableCells, t('rail.groupByStatus')],
          ].map(([key, glyph, title], i) => (
            <button
              key={key}
              type="button"
              title={title}
              onClick={() => setMode(key)}
              className={`cursor-pointer px-[0.5625rem] py-2 text-[0.6875rem] leading-none md:py-[0.1875rem] ${
                i ? 'border-s border-border' : ''
              } ${mode === key ? 'bg-ink text-white' : 'bg-panel text-fgdim'}`}
            >
              <Icon icon={glyph} />
            </button>
          ))}
        </span>
      </div>

      {/* rows */}
      <div
        className="thin-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[0.4375rem] py-0.5"
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
                  className="mb-0.5 flex items-center gap-[0.4375rem] rounded-[7px] p-2"
                >
                  <span className="text-[0.75rem] text-fgdim">
                    <Icon icon={faFolder} />
                  </span>
                  <Truncate
                    text={f.name}
                    dir={dirOf(f.name)}
                    className="min-w-0 flex-1 text-left font-sans text-[0.875rem] font-medium leading-tight text-fg2 [[dir=rtl]_&]:text-right"
                  />
                  <span className="shrink-0 px-1.5 font-mono text-[0.6875rem] md:text-[0.625rem] leading-4 text-fgdim">
                    {(folderKids.get(f.id) || []).length}
                  </span>
                </div>
              ))}
            {active.map((s) => sessionRowEl(s, { parent: parentInfoFor(s) }))}
          </>
        ) : (
          <>
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
                  className={`rounded-[10px] ${intoWhole ? 'ring-2 ring-brand ring-inset' : ''}`}
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
                      menuOpen={menuFor === entry.id}
                      setMenuFor={setMenuFor}
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
                        <div className="px-2 py-1.5 text-[0.6875rem] md:text-[0.625rem] text-fgdim italic">
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
          <div className="px-2 py-4 text-center text-[0.6875rem] text-fgdim">
            {q ? t('rail.noSessionsMatch') : t('rail.noActiveSessions')}
          </div>
        )}

        {/* A1: the team ("צוות") — below folders/free sessions, above archived */}
        {!q && (
          <TeamSection
            agents={agents}
            sessions={sessions}
            triggers={triggers}
            agentOpen={agentOpen}
            onOpenAgent={onOpenAgent}
            open={teamOpen}
            onToggle={() => setTeamOpen((v) => !v)}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            waitingByAgent={waitingByAgent}
            // UX2: no interview session — the button opens the same agent surface
            // an existing agent uses, just in create mode (AgentView, slug '__new__').
            onNewAgent={() => openAgent('__new__', 'persona')}
          />
        )}

        {/* archived: collapsed group at the bottom */}
        {archived.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-[0.4375rem] px-1.5 pt-[0.5625rem] pb-1 max-md:py-2.5"
            >
              <span className={`text-[0.6875rem] md:text-[0.5625rem] text-fgdim ${archivedOpen ? '' : 'mirror-rtl'}`}><Icon icon={archivedOpen ? faCaretDown : faCaretRight} /></span>
              <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] tracking-[0.06em] text-fgdim uppercase">
                {t('rail.archived')}
              </span>
              <span className="font-mono text-[0.6875rem] md:text-[0.59375rem] text-fgdim">{archived.length}</span>
              <span className="h-px flex-1 bg-hair" />
            </button>
            {archivedOpen &&
              archived.map((s) => (
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
      {serverCount > 0 && <UsageMini usage={activeUsage} />}

      {/* footer */}
      <div className="flex items-center gap-1.5 border-t border-hair px-[0.8125rem] py-2.5 font-mono text-[0.6875rem] md:text-[0.65625rem] text-fgdim">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: proxyUp ? '#3C9A4E' : conn === 'open' ? '#CE8324' : '#d2d2d2' }}
        />
        <span className="min-w-0 flex-1 truncate">
          {proxyUp ? t('rail.proxyUp', { n: serverCount }) : t('rail.proxyUnreachable')}
        </span>
        {/* VOICE1: voice COMMANDS (switch/create sessions, settings…) — the
            composer mic dictates; this one goes through the router. */}
        <MicButton
          mode="command"
          className="flex h-8 w-9 items-center justify-center rounded-[5px] border text-[0.6875rem] md:h-[1.375rem] md:w-[1.625rem]"
        />
        {screenAvailable && (
          <button
            type="button"
            onClick={() => setScreenModal(true)}
            title={t('rail.screen')}
            aria-label={t('rail.screen')}
            className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2 leading-[1.75rem] text-fgdim hover:border-ink hover:text-fg md:px-1.5 md:leading-[1.125rem]"
          >
            <Icon icon={faDisplay} />
          </button>
        )}
        {/* Keyboard shortcuts: nothing to press on a phone — desktop only. */}
        {onOpenShortcuts && isDesktop && (
          <button
            type="button"
            onClick={onOpenShortcuts}
            title={t('rail.keyboardShortcutsTitle')}
            aria-label={t('rail.keyboardShortcuts')}
            className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2 leading-[1.75rem] text-fgdim hover:border-ink hover:text-fg md:px-1.5 md:leading-[1.125rem]"
          >
            ?
          </button>
        )}
        <ProfileMenu
          active={(accounts?.accounts || []).find((a) => a.active) || null}
          onOpenSkills={onOpenSkills}
          onOpenBrain={onOpenBrain}
          onOpenSetup={onOpenSetup}
          onOpenSettings={onOpenSettings}
        />
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
