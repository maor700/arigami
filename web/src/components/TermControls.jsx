import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { usePrefs, termViewFrom, setTermOverride } from '../lib/prefs.js';
import { useModels, refreshModels } from '../lib/models.js';
import { modelOptionsFor, effortOptionsFor, effortLabelFor, engineLabel, normalizeEngine, hasPermissionModes } from '../lib/engines.js';
import { restartSession, clearSessionConversation } from '../lib/store.js';
import { contextColor } from './ui.jsx';
import ContextModal from './ContextModal.jsx';
import { t, useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faGear, faRotateRight, faBroom } from '@fortawesome/free-solid-svg-icons';

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
  return String(m);
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
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,22,0.5)] p-5" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]"
      >
        <div className="flex items-start justify-between gap-2 border-b border-hair px-[18px] py-3">
          <div>
            <div className="text-[15px] font-bold">{title}</div>
            {subtitle && <div className="mt-0.5 text-[11.5px] text-fgdim">{subtitle}</div>}
          </div>
          {headerExtra}
        </div>
        <div className="flex flex-col gap-1.5 px-3.5 py-3.5">
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onSelect(o.value)}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border-[1.5px] px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-ink bg-chip' : 'border-border bg-bg hover:border-fgdim'
                }`}
              >
                <span
                  className={`mt-[3px] flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border-[1.5px] ${
                    active ? 'border-ink' : 'border-border'
                  }`}
                >
                  {active && <span className="h-[7px] w-[7px] rounded-full bg-brand" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] ${o.danger ? 'font-bold text-danger' : 'font-bold text-fg'}`}>
                    {o.label}
                    {active && <span className="ml-1.5 font-mono text-[9.5px] font-normal text-fgdim">{t('rail.current')}</span>}
                  </span>
                  {o.desc && <span className="mt-px block text-[11px] text-fgdim">{o.desc}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {footer}
        {!footer && (
          <div className="flex justify-end border-t border-hair px-[18px] py-2.5">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
            >
              {t('rail.close')}
            </button>
          </div>
        )}
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

  const pick = (mode) => {
    if (mode === current) return onClose(); // already this mode → do nothing
    if (working) return setPending(mode); // mid-run → must confirm the interruption
    apply(mode); // idle → switch in place immediately
  };

  // Confirmation step: a turn is in flight and the user picked a different mode.
  const confirmFooter = pending && (
    <div className="border-t-2 border-ink bg-chip px-[18px] py-3">
      <div className="text-[12.5px] text-[#4a3f12]">
        {t('rail.switchModeWarnBefore', { engine })}<b>{PERMISSION_LABEL[pending]}</b>{t('rail.switchModeWarnAfter')}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
        >
          {t('rail.cancelBtn')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => apply(pending)}
          className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[12px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50"
        >
          {busy ? t('rail.stopping') : t('rail.stopAndSwitch')}
        </button>
      </div>
    </div>
  );

  return (
    <OptionsModal
      title={t('rail.permissionMode')}
      subtitle={working ? t('rail.claudeWorkingSwitch', { engine }) : t('rail.appliesToTerminal')}
      options={PERMISSION_OPTIONS}
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
    <div className="border-t-2 border-ink bg-chip px-[18px] py-3">
      <div className="text-[12.5px] text-[#4a3f12]">
        {t('rail.switchModelWarnBefore', { engine })}<b>{modelLabel[pending] || pending}</b>{t('rail.switchModelWarnAfter')}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
        >
          {t('rail.cancelBtn')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => apply(pending)}
          className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[12px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50"
        >
          {busy ? t('rail.stopping') : t('rail.stopAndSwitch')}
        </button>
      </div>
    </div>
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
        <span className="flex shrink-0 items-center gap-1.5">
          {cliUpdate?.updateAvailable && (
            // UPD1: a newer `claude` CLI (= a newer model list) is waiting — one
            // click to Settings › Host, where "update now" lives.
            <a
              href="#/settings/host/host"
              onClick={onClose}
              title={t('rail.cliUpdate.hint', { v: cliUpdate.latest })}
              className="mt-0.5 rounded-full border border-[#CE8324] bg-[#FFF4E5] px-2 py-0.5 font-mono text-[9.5px] font-bold text-[#8a5210] no-underline hover:bg-[#ffe9c7]"
              dir="ltr"
            >
              {t('rail.cliUpdate', { v: cliUpdate.latest })}
            </a>
          )}
          <button
            type="button"
            onClick={refreshModels}
            title={t('rail.refetchModelList')}
            disabled={loading}
            className="mt-0.5 shrink-0 cursor-pointer rounded-[6px] border-[1.5px] border-border bg-panel px-2 py-0.5 font-mono text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-50"
          >
            {loading ? '…' : <><Icon icon={faRotateRight} /> {t('rail.refresh')}</>}
          </button>
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
    } catch {
      /* swallow — state reconciles via WS */
    }
    onClose();
  };

  const pick = (effort) => {
    if (effort === current) return onClose();
    if (working) return setPending(effort);
    apply(effort);
  };

  const confirmFooter = pending && (
    <div className="border-t-2 border-ink bg-chip px-[18px] py-3">
      <div className="text-[12.5px] text-[#4a3f12]">
        {t('rail.switchEffortWarnBefore', { engine })}<b>{effortLabelFor(session.engine, session.claude?.modelChoice, pending)}</b>{t('rail.switchEffortWarnAfter')}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
        >
          {t('rail.cancelBtn')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => apply(pending)}
          className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[12px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50"
        >
          {busy ? t('rail.stopping') : t('rail.stopAndSwitch')}
        </button>
      </div>
    </div>
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
    <div className="w-full px-3 py-2 text-start text-[12px] text-fg">
      <div className="flex items-center gap-2">
        <span className="flex-1">{label}</span>
        <span className={`shrink-0 font-mono text-[10.5px] ${danger ? 'font-bold text-danger' : 'text-fgdim'}`}>
          {value}
        </span>
      </div>
      {note && <div className="mt-0.5 text-[10.5px] leading-snug text-fgdim">{note}</div>}
    </div>
  );
}

function MenuRow({ label, value, danger, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-start text-[12px] text-fg hover:bg-chip"
    >
      <span className="flex-1">{label}</span>
      <span className={`shrink-0 font-mono text-[10.5px] ${danger ? 'font-bold text-danger' : 'text-fgdim'}`}>
        {value}
      </span>
      <span className="shrink-0 text-[10px] text-fgdim rtl:-scale-x-100">›</span>
    </button>
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
  const restarting = session.claude?.state === 'restarting';
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null); // 'context' | 'dir' | 'theme' | 'permission' | 'effort'
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const openModal = (kind) => { setOpen(false); setModal(kind); };

  return (
    <span ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('rail.terminalControls')}
        aria-label={t('rail.terminalControls')}
        className={`flex h-[30px] items-center gap-1.5 rounded-full border-[1.5px] px-2 text-fgdim hover:border-ink hover:text-fg md:h-[22px] ${
          open ? 'border-ink text-fg' : 'border-border bg-bg'
        }`}
      >
        {ctx?.ctxPct != null && (
          <span className="font-mono text-[11px] font-bold tabular-nums md:text-[9.5px]" style={{ color: contextColor(ctx.ctxPct) }}>
            {ctx.ctxPct}%
          </span>
        )}
        <span className="text-[12px] leading-none"><Icon icon={faGear} /></span>
      </button>

      {open && (
        <div className="absolute top-[28px] end-0 z-30 w-[224px] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
          <MenuRow
            label={t('rail.context')}
            value={ctx?.ctxPct != null ? `${ctx.ctxPct}%` : '—'}
            onClick={() => openModal('context')}
          />
          <span className="block h-px bg-hair" />
          <MenuRow label={t('rail.direction')} value={view.dir} onClick={() => openModal('dir')} />
          <MenuRow label={t('rail.theme')} value={view.theme} onClick={() => openModal('theme')} />
          <span className="block h-px bg-hair" />
          {permModes ? (
            <MenuRow
              label={t('rail.permissionMode')}
              value={PERMISSION_LABEL[perm] || perm}
              danger={perm === 'bypassPermissions'}
              onClick={() => openModal('permission')}
            />
          ) : (
            <StaticRow
              label={t('rail.permissionMode')}
              value="bypassPermissions"
              note={t('rail.noPermissionModes', { engine: engineLabel(session.engine) })}
              danger
            />
          )}
          <MenuRow label={t('rail.model')} value={modelValue} onClick={() => openModal('model')} />
          <MenuRow label={t('rail.effort')} value={effortValue} onClick={() => openModal('effort')} />
          <span className="block h-px bg-hair" />
          <MenuRow
            label={restarting ? t('rail.restartingEllipsis') : t('rail.restartSession')}
            value={<Icon icon={faRotateRight} />}
            onClick={() => { setOpen(false); if (!restarting) restartSession(session); }}
          />
          <MenuRow
            label={t('rail.clearConversation')}
            value={<Icon icon={faBroom} />}
            danger
            onClick={() => { setOpen(false); if (!restarting) clearSessionConversation(session); }}
          />
        </div>
      )}

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
