import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { usePrefs, termViewFrom, setTermOverride } from '../lib/prefs.js';
import { useModels, refreshModels } from '../lib/models.js';
import { restartSession } from '../lib/store.js';
import { contextColor } from './ui.jsx';
import ContextModal from './ContextModal.jsx';
import { Icon } from '../lib/icons.js';
import { faGear, faRotateRight } from '@fortawesome/free-solid-svg-icons';

// Permission modes mirror server/claude.js PERMISSION_MODES.
const PERMISSION_OPTIONS = [
  { value: 'default', label: 'Default', desc: 'Ask before edits & commands' },
  { value: 'acceptEdits', label: 'Accept edits', desc: 'Auto-accept file edits; still ask for commands' },
  { value: 'plan', label: 'Plan mode', desc: 'Read & plan only — makes no changes' },
  { value: 'bypassPermissions', label: 'Bypass permissions', desc: 'Run everything without asking', danger: true },
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
  { value: 'auto', label: 'Auto', desc: 'Match the terminal output' },
  { value: 'ltr', label: 'Left → right', desc: 'Force LTR' },
  { value: 'rtl', label: 'Right → left', desc: 'Force RTL' },
];
const THEME_OPTIONS = [
  { value: 'light', label: 'Light', desc: 'Light terminal' },
  { value: 'dark', label: 'Dark', desc: 'Dark terminal' },
];

/* ---------- generic option-picker modal ----------------------------------- */

function OptionsModal({ title, subtitle, options, value, onSelect, onClose, footer, headerExtra }) {
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
                    {active && <span className="ml-1.5 font-mono text-[9.5px] font-normal text-fgdim">current</span>}
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
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- permission-mode picker (with stop-and-resume confirm) --------- */

function PermissionModal({ session, onClose }) {
  const current = session.claude?.permissionMode || session.claude?.capabilities?.permissionMode || 'default';
  const working = session.claude?.state === 'working';
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
        Claude is <b>working</b> in this session. Switching to{' '}
        <b>{PERMISSION_LABEL[pending]}</b> will <b>stop the current run</b> and resume the same
        conversation in this terminal with the new mode.
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => apply(pending)}
          className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[12px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50"
        >
          {busy ? 'Stopping…' : 'Stop & switch'}
        </button>
      </div>
    </div>
  );

  return (
    <OptionsModal
      title="Permission mode"
      subtitle={working ? 'Claude is working — switching will stop the current run.' : 'Applies to this terminal session.'}
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
  const current = session.claude?.modelChoice || 'default';
  const working = session.claude?.state === 'working';
  const [pending, setPending] = useState(null); // model awaiting "this will stop it" confirm
  const [busy, setBusy] = useState(false);
  const { models: options, loading } = useModels();
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
        Claude is <b>working</b> in this session. Switching to{' '}
        <b>{modelLabel[pending] || pending}</b> will <b>stop the current run</b> and resume the same
        conversation in this terminal with the new model.
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => apply(pending)}
          className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[12px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50"
        >
          {busy ? 'Stopping…' : 'Stop & switch'}
        </button>
      </div>
    </div>
  );

  return (
    <OptionsModal
      title="Model"
      subtitle={working ? 'Claude is working — switching will stop the current run.' : 'Applies to this terminal session.'}
      options={options}
      value={current}
      onSelect={pick}
      onClose={onClose}
      footer={confirmFooter}
      headerExtra={
        <button
          type="button"
          onClick={refreshModels}
          title="Re-fetch the model list from the claude CLI"
          disabled={loading}
          className="mt-0.5 shrink-0 cursor-pointer rounded-[6px] border-[1.5px] border-border bg-panel px-2 py-0.5 font-mono text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-50"
        >
          {loading ? '…' : <><Icon icon={faRotateRight} /> refresh</>}
        </button>
      }
    />
  );
}

/* ---------- the dropdown menu --------------------------------------------- */

function MenuRow({ label, value, danger, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12px] text-fg hover:bg-chip"
    >
      <span className="flex-1">{label}</span>
      <span className={`shrink-0 font-mono text-[10.5px] ${danger ? 'font-bold text-danger' : 'text-fgdim'}`}>
        {value}
      </span>
      <span className="shrink-0 text-[10px] text-fgdim">›</span>
    </button>
  );
}

export default function TermControls({ session }) {
  const prefs = usePrefs();
  const view = termViewFrom(prefs, session.id);
  const ctx = session.claude?.usage;
  const perm = session.claude?.permissionMode || session.claude?.capabilities?.permissionMode || 'default';
  // Model row: show the user's explicit pick, else what the running default resolved to.
  const { models: modelOptions } = useModels();
  const modelChoice = session.claude?.modelChoice || 'default';
  const reportedModel = session.claude?.model || session.claude?.capabilities?.model;
  const modelValue =
    modelChoice !== 'default'
      ? modelOptions.find((o) => o.value === modelChoice)?.label || modelChoice
      : prettyModel(reportedModel) || 'Default';
  const restarting = session.claude?.state === 'restarting';
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null); // 'context' | 'dir' | 'theme' | 'permission'
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
        title="Terminal controls"
        aria-label="Terminal controls"
        className={`flex h-[22px] items-center gap-1.5 rounded-full border-[1.5px] px-2 text-fgdim hover:border-ink hover:text-fg ${
          open ? 'border-ink text-fg' : 'border-border bg-bg'
        }`}
      >
        {ctx?.ctxPct != null && (
          <span className="font-mono text-[9.5px] font-bold tabular-nums" style={{ color: contextColor(ctx.ctxPct) }}>
            {ctx.ctxPct}%
          </span>
        )}
        <span className="text-[12px] leading-none"><Icon icon={faGear} /></span>
      </button>

      {open && (
        <div className="absolute top-[28px] right-0 z-30 w-[224px] overflow-hidden rounded-lg border-[1.5px] border-ink bg-panel shadow-[3px_3px_0_rgba(42,42,42,0.18)]">
          <MenuRow
            label="Context"
            value={ctx?.ctxPct != null ? `${ctx.ctxPct}%` : '—'}
            onClick={() => openModal('context')}
          />
          <span className="block h-px bg-hair" />
          <MenuRow label="Direction" value={view.dir} onClick={() => openModal('dir')} />
          <MenuRow label="Theme" value={view.theme} onClick={() => openModal('theme')} />
          <span className="block h-px bg-hair" />
          <MenuRow
            label="Permission mode"
            value={PERMISSION_LABEL[perm] || perm}
            danger={perm === 'bypassPermissions'}
            onClick={() => openModal('permission')}
          />
          <MenuRow label="Model" value={modelValue} onClick={() => openModal('model')} />
          <span className="block h-px bg-hair" />
          <MenuRow
            label={restarting ? 'Restarting…' : 'Restart session'}
            value={<Icon icon={faRotateRight} />}
            onClick={() => { setOpen(false); if (!restarting) restartSession(session); }}
          />
        </div>
      )}

      {modal === 'context' && <ContextModal usage={ctx} onClose={() => setModal(null)} />}
      {modal === 'dir' && (
        <OptionsModal
          title="Terminal direction"
          subtitle="Text flow for this terminal's output."
          options={DIR_OPTIONS}
          value={view.dir}
          onSelect={(v) => { setTermOverride(session.id, { dir: v }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'theme' && (
        <OptionsModal
          title="Terminal theme"
          subtitle="Light or dark for this terminal."
          options={THEME_OPTIONS}
          value={view.theme}
          onSelect={(v) => { setTermOverride(session.id, { theme: v }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'permission' && <PermissionModal session={session} onClose={() => setModal(null)} />}
      {modal === 'model' && <ModelModal session={session} onClose={() => setModal(null)} />}
    </span>
  );
}
