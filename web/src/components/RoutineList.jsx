// A2 — an agent's routine: the cron jobs whose isolated runs are born
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
import { useStore, setDraft } from '../lib/store.js';
import { relTime } from '../lib/time.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import * as setupApi from '../lib/setup-api.js';
import { EngineToggle } from './EngineToggle.jsx';
import { engineLabel } from '../lib/engines.js';
import { Clock, MessageSquare, Play, Plus, Radio, Trash2 } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Input, Textarea } from './ui/input.jsx';
import { Switch } from './ui/switch.jsx';
import { StatusDot } from './ui/badge.jsx';
import { Hint, NativeSelect } from './EngineToggle.jsx';

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

/**
 * The soonest next run of an ENABLED cron job born from `slug` (ms), or null.
 * Shown as the agent's status in the rail row and on the agent surface header.
 */
export function nextCronFor(slug, triggers) {
  let next = null;
  for (const x of triggers || []) {
    if (x.type !== 'cron' || x.agent !== slug || !x.enabled || !x.nextRunAt) continue;
    if (next === null || x.nextRunAt < next) next = x.nextRunAt;
  }
  return next;
}

/**
 * The form state → the POST /__api/triggers body, or null when it is not
 * postable yet (a job with no prompt or no schedule is not a job).
 */
export function routinePayload({ kind, value, name, prompt, engine }) {
  const p = String(prompt || '').trim();
  const v = String(value || '').trim();
  if (!p || !v) return null;
  return { name: String(name || '').trim() || p.slice(0, 48), prompt: p, schedule: { kind: kind || 'cron', value: v }, ...(engine ? { engine } : {}) };
}

/** The inline "add a scheduled job" form — schedule + prompt + engine ('' = the agent's, else the host default). */
export function AddRoutineForm({ agent, busy = false, onCreate, onCancel }) {
  const t = useT();
  const [kind, setKind] = useState('cron');
  const [value, setValue] = useState('0 7 * * *');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState(agent.engine || '');
  const submit = (e) => {
    e?.preventDefault?.();
    const payload = routinePayload({ kind, value, name, prompt, engine });
    if (payload) onCreate?.(payload);
  };
  return (
    <form data-routine-form={agent.slug} onSubmit={submit} className="mb-3 flex flex-col gap-2.5 rounded-lg border border-hair p-3">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label={t('agent.routine.form.kind')} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="cron">{t('agent.routine.form.kindCron')}</option>
          <option value="interval">{t('agent.routine.form.kindInterval')}</option>
          <option value="at">{t('agent.routine.form.kindAt')}</option>
        </NativeSelect>
        <Input dir="ltr" data-routine-schedule value={value} onChange={(e) => setValue(e.target.value)} placeholder={t(`agent.routine.form.ph.${kind}`)} aria-label={t('agent.routine.form.schedule')} className="min-w-40 flex-1 text-start font-mono" />
      </div>
      <Input dir="auto" data-routine-name value={name} onChange={(e) => setName(e.target.value)} placeholder={t('agent.routine.form.name')} aria-label={t('agent.routine.form.name')} />
      <EngineToggle data-routine-engine options={{ engine }} onChange={(o) => setEngine(o.engine || '')} />
      <Textarea dir="auto" data-routine-prompt rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('agent.routine.form.prompt', { name: agent.name })} aria-label={t('agent.routine.form.prompt', { name: agent.name })} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" data-routine-save disabled={busy || !prompt.trim() || !value.trim()}>{t('agent.routine.form.save')}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t('agent.routine.form.cancel')}</Button>
        <span className="min-w-0 text-xs text-muted-foreground">{t('agent.routine.form.hint')}</span>
      </div>
    </form>
  );
}

const sectionHead = 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5';

export function RoutineList({ agent, data, busy = false, adding = false, onToggle, onRun, onDelete, onCancelListener, onAdd, onAddViaChat, onCreate, onCancelAdd }) {
  const t = useT();
  const cron = data?.cron || [];
  const listeners = (data?.listeners || []).filter((l) => l.status !== 'stopped');
  return (
    <div data-agent-routine={agent.slug} className="flex flex-col gap-4">
      <div className="rounded-lg border border-hair p-3.5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className={sectionHead}><Clock aria-hidden="true" /> {t('agent.routine.cron')} · <span className="tabular-nums">{cron.length}</span></span>
          <Button variant="outline" size="sm" data-routine-add onClick={onAdd} className="ms-auto"><Plus /> {t('agent.routine.addForm')}</Button>
          <Button variant="outline" size="sm" data-routine-add-chat onClick={onAddViaChat}><MessageSquare /> {t('agent.routine.add')}</Button>
        </div>
        {adding && <AddRoutineForm agent={agent} busy={busy} onCreate={onCreate} onCancel={onCancelAdd} />}
        {cron.length === 0 && <div className="text-xs text-muted-foreground">{t('agent.routine.empty')}</div>}
        {cron.map((c) => (
          <div key={c.id} data-routine-cron={c.id} data-enabled={c.enabled ? '1' : '0'} className={`flex min-h-11 items-center gap-3 border-b border-hair py-2 text-xs last:border-b-0 ${c.enabled ? '' : 'opacity-60'}`}>
            <Hint label={c.enabled ? t('launcher.trigger.on') : t('launcher.trigger.off')}>
              <Switch aria-label={c.enabled ? t('launcher.trigger.on') : t('launcher.trigger.off')} checked={!!c.enabled} disabled={busy} onCheckedChange={() => onToggle?.(c)} />
            </Hint>
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate text-sm font-medium text-foreground">{c.name}</span>
              <span dir="ltr" className="block truncate text-start text-xs text-muted-foreground tabular-nums">
                {c.schedule?.kind}: {c.schedule?.value}
                {c.engine ? ` · ${engineLabel(c.engine)}` : ''}
                {c.enabled && c.nextRunAt ? ` · ${t('launcher.cron.metaNextRun')} ${untilTime(c.nextRunAt, t)}` : ''}
                {c.lastRun ? ` · ${t('launcher.cron.metaLastRun')} ${relTime(c.lastRun)}` : ''}
              </span>
            </span>
            <Hint label={t('launcher.cron.runNow')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('launcher.cron.runNow')} disabled={busy} onClick={() => onRun?.(c)}><Play /></Button>
            </Hint>
            <Hint label={t('launcher.trigger.deleteTitle')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('launcher.trigger.deleteTitle')} disabled={busy} onClick={() => onDelete?.(c)} className="hover:text-destructive"><Trash2 /></Button>
            </Hint>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-hair p-3.5">
        <div className={`mb-3 ${sectionHead}`}><Radio aria-hidden="true" /> {t('agent.routine.listeners')} · <span className="tabular-nums">{listeners.length}</span></div>
        {listeners.length === 0 && <div className="text-xs text-muted-foreground">{t('agent.routine.noListeners')}</div>}
        {listeners.map((l) => (
          <div key={l.id} data-routine-listener={l.id} className="flex min-h-11 items-center gap-3 border-b border-hair py-2 text-xs last:border-b-0">
            <StatusDot status={l.status === 'errored' ? 'err' : 'ok'} />
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate text-sm font-medium text-foreground">{l.label}</span>
              <span dir="ltr" className="block truncate text-start text-xs text-muted-foreground tabular-nums">{l.type} · {l.status}{l.firedCount ? ` · ×${l.firedCount}` : ''}</span>
            </span>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onCancelListener?.(l)} className="hover:text-destructive">{t('agent.routine.cancelListener')}</Button>
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
  if (!data) return <div className="text-xs text-muted-foreground">{t('dialogs.loading')}</div>;
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
