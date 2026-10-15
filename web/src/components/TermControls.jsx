import { useState } from 'react';
import { api } from '../lib/api.js';
import { usePrefs, termViewFrom, setTermOverride } from '../lib/prefs.js';
import { useModels, refreshModels } from '../lib/models.js';
import { modelOptionsFor, effortOptionsFor, effortLabelFor, engineLabel, normalizeEngine, hasPermissionModes, permissionModesFor, codexModel } from '../lib/engines.js';
import { restartSession, clearSessionConversation } from '../lib/store.js';
import { toastError } from '../lib/toast.js';
import { contextColor } from './ui.jsx';
import ContextModal from './ContextModal.jsx';
import { t, useT } from '../lib/i18n.js';
import { ChevronRight, Eraser, Gauge, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Tip } from './ui/tooltip.jsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.jsx';
import { ChatModeItems, ChatTextSizeSub } from './ChatReadingMenu.jsx';
import { chatModeOf } from '../lib/chatMode.js';
import { useIsDesktop } from '../lib/useMedia.js';

// Permission modes mirror server/claude.js PERMISSION_MODES.
const PERMISSION_OPTIONS = [
  { value: 'default', label: t('rail.permDefault'), desc: t('rail.permDefaultDesc') },
  { value: 'acceptEdits', label: t('rail.permAcceptEdits'), desc: t('rail.permAcceptEditsDesc') },
  { value: 'plan', label: t('rail.permPlan'), desc: t('rail.permPlanDesc') },
  { value: 'bypassPermissions', label: t('rail.permBypass'), desc: t('rail.permBypassDesc'), danger: true },
];
const PERMISSION_LABEL = Object.fromEntries(PERMISSION_OPTIONS.map((o) => [o.value, o.label]));

// Model options come from useModels() (web/src/lib/models.js) — the server's
// cache of the `claude` CLI's own model list, refreshed once/day + on manual
// refresh, so a new model shows up here without a code change.

// Friendly short name for a reported model id (e.g. "claude-opus-4-8" → "Opus")
// so the menu can show what the default actually resolved to.
function prettyModel(m) {
  if (!m) return '';
  const s = String(m).toLowerCase();
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('fable')) return 'Fable';
  return codexModel(String(m))?.label || String(m);
}

const DIR_OPTIONS = [
  { value: 'auto', label: t('rail.dirAuto'), desc: t('rail.dirAutoDesc') },
  { value: 'ltr', label: t('rail.dirLtr'), desc: t('rail.dirLtrDesc') },
  { value: 'rtl', label: t('rail.dirRtl'), desc: t('rail.dirRtlDesc') },
];
const THEME_OPTIONS = [
  { value: 'light', label: t('rail.themeLight'), desc: t('rail.themeLightDesc') },
  { value: 'dark', label: t('rail.themeDark'), desc: t('rail.themeDarkDesc') },
];

/* ---------- generic option-picker modal ----------------------------------- */

function OptionsModal({ title, subtitle, options, value, onSelect, onClose, footer, headerExtra }) {
  const t = useT();
  // Radix Dialog: focus trap + restore, Esc and outside-click close.
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[min(26rem,calc(100vw-1.5rem))] gap-0 p-0" showClose={false}>
        <DialogHeader className="flex-row items-start justify-between gap-2 border-b border-border px-5 py-3.5 pe-5">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">{subtitle || '\u00a0'}</DialogDescription>
          </div>
          {headerExtra}
        </DialogHeader>
        <div role="radiogroup" aria-label={title} className="flex flex-col gap-1 p-3">
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelect(o.value)}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-start outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring coarse:min-h-11 ${
                  active ? 'bg-muted' : 'hover:bg-muted/60'
                }`}
              >
                <span
                  className={`mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
                    active ? 'border-foreground' : 'border-input'
                  }`}
                >
                  {active && <span className="size-1.5 rounded-full bg-foreground" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${o.danger ? 'text-destructive' : 'text-foreground'}`}>
                    {o.label}
                    {active && <span className="ms-1.5 text-2xs font-normal text-muted-foreground">{t('rail.current')}</span>}
                  </span>
                  {o.desc && <span className="mt-px block text-xs text-muted-foreground">{o.desc}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {footer}
        {!footer && (
          <div className="flex justify-end border-t border-border px-5 py-3">
            <Button variant="outline" onClick={onClose}>{t('rail.close')}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The "a turn is in flight — this will stop it" step shared by the three pickers.
function ConfirmFooter({ message, busy, onCancel, onConfirm }) {
  const t = useT();
  return (
    <div className="border-t border-border bg-muted/50 px-5 py-3">
      <div className="text-sm text-foreground">{message}</div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('rail.cancelBtn')}</Button>
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? t('rail.stopping') : t('rail.stopAndSwitch')}
        </Button>
      </div>
    </div>
  );
}

/* ---------- permission-mode picker (with stop-and-resume confirm) --------- */

function PermissionModal({ session, onClose }) {
  const t = useT();
  const current = session.claude?.permissionMode || session.claude?.capabilities?.permissionMode || 'default';
  const working = session.claude?.state === 'working';
  const engine = engineLabel(session.engine); // "X is working" names THIS session's engine
  const [pending, setPending] = useState(null); // mode awaiting "this will stop it" confirm
  const [busy, setBusy] = useState(false);

  const apply = async (mode) => {
    setBusy(true);
    try {
      await api.post(`/sessions/${session.id}/permission-mode`, { mode });
    } catch {
      /* swallow — state reconciles via WS */
    }
    onClose();
  };

  const codex = normalizeEngine(session.engine) === 'codex';
  // Codex app-server applies the mode on its next turn — nothing to stop.
  const options = PERMISSION_OPTIONS.filter((o) => permissionModesFor(session.engine).includes(o.value)).map((o) =>
    codex ? { ...o, desc: t(o.value === 'default' ? 'rail.permCodexAskDesc' : 'rail.permCodexBypassDesc') } : o
  );
  const pick = (mode) => {
    if (mode === current) return onClose(); // already this mode → do nothing
    if (working && !codex) return setPending(mode); // mid-run → must confirm the interruption
    apply(mode); // idle → switch in place immediately
  };

  // Confirmation step: a turn is in flight and the user picked a different mode.
  const confirmFooter = pending && (
    <ConfirmFooter
      busy={busy}
      onCancel={onClose}
      onConfirm={() => apply(pending)}
      message={<>{t('rail.switchModeWarnBefore', { engine })}<b>{PERMISSION_LABEL[pending]}</b>{t('rail.switchModeWarnAfter')}</>}
    />
  );

  return (
    <OptionsModal
      title={t('rail.permissionMode')}
      subtitle={working ? t('rail.claudeWorkingSwitch', { engine }) : t('rail.appliesToTerminal')}
      options={options}
      value={current}
      onSelect={pick}
      onClose={onClose}
      footer={confirmFooter}
    />
  );
}

/* ---------- model picker (same stop-and-resume UX as permission mode) ------ */

function ModelModal({ session, onClose }) {
  const t = useT();
  const current = session.claude?.modelChoice || 'default';
  const working = session.claude?.state === 'working';
  const engine = engineLabel(session.engine); // "X is working" names THIS session's engine
  const [pending, setPending] = useState(null); // model awaiting "this will stop it" confirm
  const [busy, setBusy] = useState(false);
  // A running session's list follows ITS engine, not the cockpit's default:
  // a Codex session must never be offered a Claude alias (see lib/engines.js).
  const { models: claudeModels, loading, cliUpdate } = useModels();
  const options = modelOptionsFor(session.engine, claudeModels);
  const isClaude = normalizeEngine(session.engine) === 'claude';
  const modelLabel = Object.fromEntries(options.map((o) => [o.value, o.label]));

  const apply = async (model) => {
    setBusy(true);
    try {
      await api.post(`/sessions/${session.id}/model`, { model });
    } catch {
      /* swallow — state reconciles via WS */
    }
    onClose();
  };

  const pick = (model) => {
    if (model === current) return onClose(); // already this model → do nothing
    if (working) return setPending(model); // mid-run → must confirm the interruption
    apply(model); // idle → switch in place immediately
  };

  // Confirmation step: a turn is in flight and the user picked a different model.
  const confirmFooter = pending && (
    <ConfirmFooter
      busy={busy}
      onCancel={onClose}
      onConfirm={() => apply(pending)}
      message={<>{t('rail.switchModelWarnBefore', { engine })}<b>{modelLabel[pending] || pending}</b>{t('rail.switchModelWarnAfter')}</>}
    />
  );

  return (
    <OptionsModal
      title={t('rail.model')}
      subtitle={working ? t('rail.claudeWorkingSwitch', { engine }) : t('rail.appliesToTerminal')}
      options={options}
      value={current}
      onSelect={pick}
      onClose={onClose}
      footer={confirmFooter}
      // Both of these are about the `claude` CLI specifically: "refresh" re-runs
      // its model handshake, and the update chip points at ITS installed
      // version. Codex's list is static (lib/engines.js) and its CLI is
      // updated elsewhere — showing either on a Codex session would offer a
      // button that does nothing and a version that isn't the one running.
      headerExtra={
        isClaude && (
        <span className="flex shrink-0 items-center gap-1.5 pe-1">
          {cliUpdate?.updateAvailable && (
            // UPD1: a newer `claude` CLI (= a newer model list) is waiting — one
            // click to Settings › Host, where "update now" lives.
            <Tip label={t('rail.cliUpdate.hint', { v: cliUpdate.latest })}>
              <a
                href="#/settings/host/host"
                onClick={onClose}
                className="inline-flex h-[1.125rem] items-center gap-1.5 rounded-sm bg-muted px-1.5 text-2xs font-medium text-foreground no-underline hover:bg-[var(--hb-hover)]"
                dir="ltr"
              >
                <span className="size-1.5 rounded-full bg-warn" aria-hidden="true" />
                {t('rail.cliUpdate', { v: cliUpdate.latest })}
              </a>
            </Tip>
          )}
          <Tip label={t('rail.refetchModelList')}>
            <Button variant="outline" size="xs" onClick={refreshModels} disabled={loading}>
              {loading ? '…' : <><RefreshCw /> {t('rail.refresh')}</>}
            </Button>
          </Tip>
        </span>
        )
      }
    />
  );
}

/* ---------- effort picker (same stop-and-resume UX as model) -------------- */

function EffortModal({ session, onClose }) {
  const t = useT();
  // Codex's ladder is per-model (and has an `ultra` rung Claude lacks), so the
  // session's own model decides the options — not one shared list.
  const options = effortOptionsFor(session.engine, session.claude?.modelChoice);
  const current = session.claude?.effort || 'default';
  const working = session.claude?.state === 'working';
  const engine = engineLabel(session.engine); // "X is working" names THIS session's engine
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  const apply = async (effort) => {
    setBusy(true);
    try {
      await api.post(`/sessions/${session.id}/effort`, { effort });
    } catch (e) {
      toastError(e?.body?.error || e?.message || String(e));
    }
    onClose();
  };

  const pick = (effort) => {
    if (effort === current) return onClose();
    if (working) return setPending(effort);
    apply(effort);
  };

  const confirmFooter = pending && (
    <ConfirmFooter
      busy={busy}
      onCancel={onClose}
      onConfirm={() => apply(pending)}
      message={<>{t('rail.switchEffortWarnBefore', { engine })}<b>{effortLabelFor(session.engine, session.claude?.modelChoice, pending)}</b>{t('rail.switchEffortWarnAfter')}</>}
    />
  );

  return (
    <OptionsModal
      title={t('rail.effort')}
      subtitle={working ? t('rail.claudeWorkingSwitch', { engine }) : t('rail.appliesToTerminal')}
      options={options}
      value={current}
      onSelect={pick}
      onClose={onClose}
      footer={confirmFooter}
    />
  );
}

/* ---------- the dropdown menu --------------------------------------------- */

/**
 * A row that states a fact instead of opening a picker. Used where an engine
 * has no choice to offer — showing a clickable picker there would tell the
 * human they had constrained the session when nothing changed.
 */
function StaticRow({ label, value, note, danger }) {
  return (
    <div className="px-2 py-1.5 text-sm text-foreground">
      <div className="flex items-center gap-2">
        <span className="flex-1">{label}</span>
        <span className={`shrink-0 text-xs ${danger ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
          {value}
        </span>
      </div>
      {note && <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">{note}</div>}
    </div>
  );
}

// A menu row that opens a picker: label at the start, the current value at the end.
function MenuRow({ label, value, danger, onSelect, children, ...props }) {
  return (
    <DropdownMenuItem onSelect={onSelect} {...props}>
      <span className="flex-1 whitespace-nowrap">{label}</span>
      <span className={`shrink-0 whitespace-nowrap text-xs ${danger ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
        {value}
      </span>
      {children || <ChevronRight className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" />}
    </DropdownMenuItem>
  );
}

// The context figure is quiet until the window is getting full.
const ctxTone = (pct) => (pct >= 75 ? contextColor(pct) : undefined);

import { useComposerPillMounted, openComposerPill } from '../lib/composerPill.js';

// D10: the header carries ONE chip instead of the gear: the context meter. It opens the
// Context / Compact dialog. Restart, Clear and the per-chat display overrides live in the
// header "…" menu (ChatDisplayItems below); defaults for direction and theme in Settings.
export function ContextChip({ session }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ctx = session.claude?.usage;
  return (
    <>
      <Tip label={t('rail.context')}>
        <Button variant="ghost" size="sm" data-context-chip aria-label={`${t('rail.context')} ${ctx?.ctxPct != null ? ctx.ctxPct + '%' : ''}`} onClick={() => setOpen(true)} className="gap-1.5 px-1.5 text-muted-foreground">
          <span className="text-xs font-medium tabular-nums" style={{ color: ctx?.ctxPct != null ? ctxTone(ctx.ctxPct) : undefined }}>{ctx?.ctxPct != null ? `${ctx.ctxPct}%` : '—'}</span>
          <Gauge />
        </Button>
      </Tip>
      {open && <ContextModal session={session} usage={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

// "This chat" display overrides (direction, theme) as radio groups for a dropdown menu.
export function ChatDisplayItems({ M, session }) {
  const t = useT();
  const prefs = usePrefs();
  const view = termViewFrom(prefs, session.id);
  const group = (title, key, opts) => (
    <M.Group aria-label={title}>
      <M.Label>{title}</M.Label>
      <M.RadioGroup value={view[key]} onValueChange={(v) => setTermOverride(session.id, { [key]: v })}>
        {opts.map((o) => <M.RadioItem key={o} value={o}>{t(`common.${o}`)}</M.RadioItem>)}
      </M.RadioGroup>
    </M.Group>
  );
  return (
    <>
      {group(`${t('rail.direction')} · ${t('rail.thisChat')}`, 'dir', ['auto', 'ltr', 'rtl'])}
      {group(`${t('rail.chatTheme')} · ${t('rail.thisChat')}`, 'theme', ['light', 'dark'])}
    </>
  );
}

export default function TermControls({ session }) {
  const t = useT();
  const prefs = usePrefs();
  const view = termViewFrom(prefs, session.id);
  const ctx = session.claude?.usage;
  const perm = session.claude?.permissionMode || session.claude?.capabilities?.permissionMode || 'default';
  const permModes = hasPermissionModes(session.engine); // see lib/engines.js
  // Model row: show the user's explicit pick, else what the running default resolved to.
  const { models: claudeModels } = useModels();
  const modelOptions = modelOptionsFor(session.engine, claudeModels);
  const modelChoice = session.claude?.modelChoice || 'default';
  const reportedModel = session.claude?.model || session.claude?.capabilities?.model;
  const modelValue =
    modelChoice !== 'default'
      ? modelOptions.find((o) => o.value === modelChoice)?.label || modelChoice
      : prettyModel(reportedModel) || t('rail.permDefault');
  const effortValue = effortLabelFor(session.engine, modelChoice, session.claude?.effort);
  const pillOwns = useComposerPillMounted();
  const restarting = session.claude?.state === 'restarting';
  const isDesktop = useIsDesktop();
  const chatMode = chatModeOf(session, isDesktop);
  const [modal, setModal] = useState(null); // 'context' | 'dir' | 'theme' | 'permission' | 'model' | 'effort'

  // A picker opens after the menu has finished closing (Radix returns focus to
  // the trigger on close — opening the dialog in the same tick would lose it).
  const openModal = (kind) => () => setTimeout(() => setModal(kind), 0);

  return (
    <span className="relative flex items-center">
      <DropdownMenu>
        <Tip label={t('rail.readingControls')}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t('rail.readingControls')} data-term-controls className="gap-1.5 px-1.5 text-muted-foreground aria-expanded:text-foreground">
              {ctx?.ctxPct != null && (
                <span className="text-xs font-medium tabular-nums" style={{ color: ctxTone(ctx.ctxPct) }}>
                  {ctx.ctxPct}%
                </span>
              )}
              <SettingsIcon />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="w-64">
          {/* one "reading" group: chat view, text size, direction, theme — the same
              controls (and ⌘+ / ⌘− / ⌘0 for the size) as Settings → General */}
          <ChatModeItems
            M={{ Group: DropdownMenuGroup, Label: DropdownMenuLabel, RadioGroup: DropdownMenuRadioGroup, RadioItem: DropdownMenuRadioItem }}
            session={session}
            mode={chatMode}
          />
          <ChatTextSizeSub />
          <MenuRow label={t('rail.direction')} value={t(`common.${view.dir}`)} onSelect={openModal('dir')} />
          <MenuRow label={t('rail.chatTheme')} value={t(`common.${view.theme}`)} onSelect={openModal('theme')} />
          <DropdownMenuSeparator />
          <MenuRow
            label={t('rail.context')}
            value={ctx?.ctxPct != null ? `${ctx.ctxPct}%` : '—'}
            onSelect={openModal('context')}
          />
          <DropdownMenuSeparator />
          {pillOwns ? (
            <MenuRow
              label={t('rail.modelEffortPerm')}
              value={modelValue}
              data-term-open-pill
              onSelect={() => setTimeout(openComposerPill, 0)}
            />
          ) : permModes ? (
            <MenuRow
              label={t('rail.permissionMode')}
              value={PERMISSION_LABEL[perm] || perm}
              danger={perm === 'bypassPermissions'}
              onSelect={openModal('permission')}
            />
          ) : (
            <StaticRow
              label={t('rail.permissionMode')}
              value="bypassPermissions"
              note={t('rail.noPermissionModes', { engine: engineLabel(session.engine) })}
              danger
            />
          )}
          {!pillOwns && <MenuRow label={t('rail.model')} value={modelValue} onSelect={openModal('model')} />}
          {!pillOwns && <MenuRow label={t('rail.effort')} value={effortValue} onSelect={openModal('effort')} />}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { if (!restarting) restartSession(session); }}>
            <RefreshCw /> {restarting ? t('rail.restartingEllipsis') : t('rail.restartSession')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => { if (!restarting) clearSessionConversation(session); }}>
            <Eraser /> {t('rail.clearConversation')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {modal === 'context' && <ContextModal session={session} usage={ctx} onClose={() => setModal(null)} />}
      {modal === 'dir' && (
        <OptionsModal
          title={t('rail.terminalDirection')}
          subtitle={t('rail.textFlowOutput')}
          options={DIR_OPTIONS}
          value={view.dir}
          onSelect={(v) => { setTermOverride(session.id, { dir: v }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'theme' && (
        <OptionsModal
          title={t('rail.terminalTheme')}
          subtitle={t('rail.lightOrDark')}
          options={THEME_OPTIONS}
          value={view.theme}
          onSelect={(v) => { setTermOverride(session.id, { theme: v }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'permission' && <PermissionModal session={session} onClose={() => setModal(null)} />}
      {modal === 'model' && <ModelModal session={session} onClose={() => setModal(null)} />}
      {modal === 'effort' && <EffortModal session={session} onClose={() => setModal(null)} />}
    </span>
  );
}
