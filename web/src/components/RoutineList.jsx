// A2 — an agent's שגרה (routine): the cron jobs whose isolated runs are born
// from the agent (cronjob({agent}) / POST /__api/triggers {agent}) and the
// listeners its sessions armed. Presentational list (RoutineList — pure
// props, SSR-testable) + container (RoutinePanel — GET /__api/agents/:slug/routine,
// re-read whenever the store's triggers/listeners change). Enable / disable /
// run now / delete go through the existing trigger routes; listeners are
// cancelled through their session's route.
//
// A5 (#8 + trip-up #2): adding a job no longer forces a chat. The form here is the
// direct path (POST /__api/triggers {type:'cron', agent}); "Add via chat" opens the
// agent's EXISTING home chat with a prefilled draft instead of spawning a fresh
// session (and another cold start) on every click.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { useStore, setDraft } from '../lib/store.js';
import { relTime } from '../lib/time.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import * as setupApi from '../lib/setup-api.js';
import { faPlay, faTrash, faComments, faClock, faSatelliteDish, faPlus } from '@fortawesome/free-solid-svg-icons';

const btn = 'cursor-pointer rounded-md border border-border px-2 py-0.5 text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-40';

/** "in 3h" / "in 2d" — the forward twin of relTime, for next-run times. */
export function untilTime(ms, t) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  let v;
  if (s < 60) v = `<1${t('time.m')}`;
  else if (s < 3600) v = `${Math.floor(s / 60)}${t('time.m')}`;
  else if (s < 86400) v = `${Math.floor(s / 3600)}${t('time.h')}`;
  else v = `${Math.floor(s / 86400)}${t('time.d')}`;
  return t('time.in', { t: v });
}

/** The inline "add a scheduled job" form — schedule + prompt, nothing else. */
export function AddRoutineForm({ agent, busy = false, onCreate, onCancel }) {
  const t = useT();
  const [kind, setKind] = useState('cron');
  const [value, setValue] = useState('0 7 * * *');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const field = 'w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px] text-fg';
  const submit = (e) => {
    e?.preventDefault?.();
    if (!prompt.trim() || !value.trim()) return;
    onCreate?.({ name: name.trim() || prompt.trim().slice(0, 48), prompt: prompt.trim(), schedule: { kind, value: value.trim() } });
  };
  return (
    <form data-routine-form={agent.slug} onSubmit={submit} className="mb-2 flex flex-col gap-1.5 rounded-[8px] border border-hair p-2">
      <div className="flex items-center gap-1.5">
        <select aria-label={t('agent.routine.form.kind')} value={kind} onChange={(e) => setKind(e.target.value)} className={`${field} w-auto cursor-pointer`}>
          <option value="cron">{t('agent.routine.form.kindCron')}</option>
          <option value="interval">{t('agent.routine.form.kindInterval')}</option>
          <option value="at">{t('agent.routine.form.kindAt')}</option>
        </select>
        <input dir="ltr" data-routine-schedule value={value} onChange={(e) => setValue(e.target.value)} placeholder={t(`agent.routine.form.ph.${kind}`)} aria-label={t('agent.routine.form.schedule')} className={`${field} flex-1`} />
      </div>
      <input dir="auto" data-routine-name value={name} onChange={(e) => setName(e.target.value)} placeholder={t('agent.routine.form.name')} aria-label={t('agent.routine.form.name')} className={field} />
      <textarea dir="auto" data-routine-prompt rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('agent.routine.form.prompt', { name: agent.name })} aria-label={t('agent.routine.form.prompt', { name: agent.name })} className={`${field} resize-y`} />
      <div className="flex items-center gap-1.5">
        <button type="submit" data-routine-save disabled={busy || !prompt.trim() || !value.trim()} className={btn}>{t('agent.routine.form.save')}</button>
        <button type="button" onClick={onCancel} className={btn}>{t('agent.routine.form.cancel')}</button>
        <span className="text-[10px] text-fgdim">{t('agent.routine.form.hint')}</span>
      </div>
    </form>
  );
}

export function RoutineList({ agent, data, busy = false, adding = false, onToggle, onRun, onDelete, onCancelListener, onAdd, onAddViaChat, onCreate, onCancelAdd }) {
  const t = useT();
  const cron = data?.cron || [];
  const listeners = (data?.listeners || []).filter((l) => l.status !== 'stopped');
  return (
    <div data-agent-routine={agent.slug} className="flex flex-col gap-3">
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase"><Icon icon={faClock} /> {t('agent.routine.cron')} · {cron.length}</span>
          <button type="button" data-routine-add onClick={onAdd} className={`ms-auto ${btn}`}><Icon icon={faPlus} /> {t('agent.routine.addForm')}</button>
          <button type="button" data-routine-add-chat onClick={onAddViaChat} className={btn}><Icon icon={faComments} /> {t('agent.routine.add')}</button>
        </div>
        {adding && <AddRoutineForm agent={agent} busy={busy} onCreate={onCreate} onCancel={onCancelAdd} />}
        {cron.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.routine.empty')}</div>}
        {cron.map((c) => (
          <div key={c.id} data-routine-cron={c.id} data-enabled={c.enabled ? '1' : '0'} className={`flex items-center gap-2 border-b border-hair py-1.5 text-[11.5px] last:border-b-0 ${c.enabled ? '' : 'opacity-60'}`}>
            <button type="button" role="switch" aria-checked={c.enabled} title={c.enabled ? t('launcher.trigger.on') : t('launcher.trigger.off')} disabled={busy} onClick={() => onToggle?.(c)}
              className={`h-[16px] w-[28px] shrink-0 cursor-pointer rounded-full border border-ink p-px ${c.enabled ? 'bg-brand' : 'bg-chip'}`}>
              <span className={`block h-[12px] w-[12px] rounded-full bg-ink transition-transform ${c.enabled ? 'translate-x-[12px] rtl:-translate-x-[12px]' : ''}`} />
            </button>
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate font-mono font-bold">{c.name}</span>
              <span dir="ltr" className="block truncate font-mono text-[10px] text-fgdim">
                {c.schedule?.kind}: {c.schedule?.value}
                {c.enabled && c.nextRunAt ? ` · ${t('launcher.cron.metaNextRun')} ${untilTime(c.nextRunAt, t)}` : ''}
                {c.lastRun ? ` · ${t('launcher.cron.metaLastRun')} ${relTime(c.lastRun)}` : ''}
              </span>
            </span>
            <button type="button" title={t('launcher.cron.runNow')} disabled={busy} onClick={() => onRun?.(c)} className={btn}><Icon icon={faPlay} /></button>
            <button type="button" title={t('launcher.trigger.deleteTitle')} disabled={busy} onClick={() => onDelete?.(c)} className={`${btn} hover:text-[#9c3b33]`}><Icon icon={faTrash} /></button>
          </div>
        ))}
      </div>
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase"><Icon icon={faSatelliteDish} /> {t('agent.routine.listeners')} · {listeners.length}</div>
        {listeners.length === 0 && <div className="text-[11px] text-fgdim">{t('agent.routine.noListeners')}</div>}
        {listeners.map((l) => (
          <div key={l.id} data-routine-listener={l.id} className="flex items-center gap-2 border-b border-hair py-1.5 text-[11.5px] last:border-b-0">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: l.status === 'errored' ? '#9c3b33' : agent.color }} />
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate font-mono font-bold">{l.label}</span>
              <span dir="ltr" className="block truncate font-mono text-[10px] text-fgdim">{l.type} · {l.status}{l.firedCount ? ` · ×${l.firedCount}` : ''}</span>
            </span>
            <button type="button" disabled={busy} onClick={() => onCancelListener?.(l)} className={`${btn} hover:text-[#9c3b33]`}>{t('agent.routine.cancelListener')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RoutinePanel({ agent, onOpenSession }) {
  const t = useT();
  const { triggers, listeners } = useStore();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    setupApi.agentRoutine(agent.slug).then(setData).catch((e) => toastError(String(e?.message || e)));
  }, [agent.slug]);
  useEffect(() => { load(); }, [load, triggers, listeners]);
  const run = (fn) => async () => {
    setBusy(true);
    try { await fn(); load(); } catch (e) { toastError(e?.body?.error || e?.message || String(e)); } finally { setBusy(false); }
  };
  // A5 (#8): the agent's EXISTING home chat, with the ask prefilled in its
  // composer — one click used to spawn a brand-new session (and cold start).
  const addViaChat = async () => {
    try {
      const r = await api.get(`/agents/${agent.slug}/home`);
      const sid = r?.session?.id;
      if (!sid) return;
      setDraft(sid, { text: t('agent.routine.addPrompt', { name: agent.name }) });
      onOpenSession?.(sid);
    } catch (e) { toastError(e?.body?.error || e?.message || String(e)); }
  };
  const create = async (input) => {
    setBusy(true);
    try {
      await api.post('/triggers', { type: 'cron', agent: agent.slug, ...input });
      setAdding(false);
      toastSuccess(t('agent.routine.form.created', { name: input.name }));
      load();
    } catch (e) {
      toastError(e?.body?.error || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  return (
    <RoutineList
      agent={agent}
      data={data}
      busy={busy}
      adding={adding}
      onAdd={() => setAdding((v) => !v)}
      onAddViaChat={addViaChat}
      onCreate={create}
      onCancelAdd={() => setAdding(false)}
      onToggle={(c) => run(() => api.patch(`/triggers/${c.id}`, { enabled: !c.enabled }))()}
      onRun={(c) => run(() => api.post(`/triggers/${c.id}/run`, {}))()}
      onDelete={(c) => { if (window.confirm(t('agent.routine.deleteConfirm', { name: c.name }))) run(() => api.del(`/triggers/${c.id}`))(); }}
      onCancelListener={(l) => run(() => api.del(`/sessions/${l.sessionId}/listeners/${l.id}`))()}
    />
  );
}
