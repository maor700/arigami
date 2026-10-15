// The composer's ONE settings pill: model + effort + permission mode in a single
// popover (decision D7). It drives the same endpoints as the terminal-controls
// gear (POST /sessions/:id/model | /effort | /permission-mode) and keeps the
// same rule: while a turn is running a change must be confirmed, because it
// stops and resumes the session.
import { useEffect, useState } from 'react';
import { CheckIcon, ChevronDownIcon, RefreshCwIcon, SlidersHorizontalIcon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useModels, refreshModels } from '../lib/models.js';
import { modelOptionsFor, effortOptionsFor, effortLabelFor, engineLabel, normalizeEngine, hasPermissionModes, permissionModesFor, codexModel } from '../lib/engines.js';
import { toastError } from '../lib/toast.js';
import { registerComposerPill } from '../lib/composerPill.js';
import { Button, Popover, PopoverContent, PopoverTrigger, StatusDot, Tip, TooltipProvider } from './ui/index.js';

const PERM = [
  { value: 'default', label: 'rail.permDefault', desc: 'rail.permDefaultDesc' },
  { value: 'acceptEdits', label: 'rail.permAcceptEdits', desc: 'rail.permAcceptEditsDesc' },
  { value: 'plan', label: 'rail.permPlan', desc: 'rail.permPlanDesc' },
  { value: 'bypassPermissions', label: 'rail.permBypass', desc: 'rail.permBypassDesc', danger: true },
];
const PERM_DOT = { default: null, acceptEdits: 'warn', plan: 'info', bypassPermissions: 'err' };

// Friendly short name for a reported model id (e.g. "claude-opus-4-8" → "Opus").
function prettyModel(m) {
  if (!m) return '';
  const s = String(m).toLowerCase();
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('fable')) return 'Fable';
  return codexModel(String(m))?.label || String(m);
}

function Section({ title, children, extra }) {
  return (
    <div className="py-1" role="group" aria-label={title}>
      <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-1">
        <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

function Option({ selected, label, desc, danger, onClick }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-selected={selected ? '' : undefined}
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-muted focus-visible:bg-muted coarse:min-h-11"
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{selected && <CheckIcon className="size-3.5" />}</span>
      <span className="min-w-0 flex-1">
        <span className={`block ${danger ? 'text-destructive' : 'text-foreground'}`}>{label}</span>
        {desc && <span className="block text-xs leading-snug text-muted-foreground">{desc}</span>}
      </span>
    </button>
  );
}

export default function ComposerPill({ session }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(null); // { kind, value, label } awaiting "this will stop it" confirm
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const un = registerComposerPill();
    const onOpen = () => setOpen(true);
    window.addEventListener('arigami:open-composer-pill', onOpen);
    return () => { un(); window.removeEventListener('arigami:open-composer-pill', onOpen); };
  }, []);
  const claude = session.claude || {};
  const working = claude.state === 'working';
  const codex = normalizeEngine(session.engine) === 'codex';
  const engine = engineLabel(session.engine);
  const { models: claudeModels, loading, cliUpdate } = useModels();
  const modelOpts = modelOptionsFor(session.engine, claudeModels);
  const modelChoice = claude.modelChoice || 'default';
  const reported = claude.model || claude.capabilities?.model;
  const modelLabel = modelChoice !== 'default' ? modelOpts.find((o) => o.value === modelChoice)?.label || modelChoice : prettyModel(reported) || t('rail.permDefault');
  const effortOpts = effortOptionsFor(session.engine, claude.modelChoice);
  const effort = claude.effort || 'default';
  const effortLabel = effortLabelFor(session.engine, modelChoice, claude.effort);
  const perm = claude.permissionMode || claude.capabilities?.permissionMode || 'default';
  const permOpts = PERM.filter((o) => permissionModesFor(session.engine).includes(o.value)).map((o) => ({
    ...o,
    label: t(o.label),
    desc: codex ? t(o.value === 'default' ? 'rail.permCodexAskDesc' : 'rail.permCodexBypassDesc') : t(o.desc),
  }));
  const permLabel = permOpts.find((o) => o.value === perm)?.label || perm;

  const apply = async (kind, value) => {
    setBusy(true);
    try {
      if (kind === 'model') await api.post(`/sessions/${session.id}/model`, { model: value });
      else if (kind === 'effort') await api.post(`/sessions/${session.id}/effort`, { effort: value });
      else await api.post(`/sessions/${session.id}/permission-mode`, { mode: value });
    } catch (e) {
      if (kind === 'effort') toastError(e?.body?.error || e?.message || String(e));
      /* model / mode: swallow — state reconciles via WS */
    }
    setBusy(false);
    setPending(null);
    setOpen(false);
  };
  const pick = (kind, value, label, current) => {
    if (value === current) { setOpen(false); return; } // already this → do nothing
    // Codex applies a permission mode on its next turn — nothing to stop.
    if (working && !(kind === 'perm' && codex)) { setPending({ kind, value, label }); return; }
    apply(kind, value);
  };
  const warn = pending && (
    {
      model: ['rail.switchModelWarnBefore', 'rail.switchModelWarnAfter'],
      effort: ['rail.switchEffortWarnBefore', 'rail.switchEffortWarnAfter'],
      perm: ['rail.switchModeWarnBefore', 'rail.switchModeWarnAfter'],
    }[pending.kind]
  );
  const dot = PERM_DOT[perm];
  // the effort rides in the label only when one was chosen (a default effort adds no information)
  const summary = effort && effort !== 'default' ? `${modelLabel} · ${effortLabel}` : modelLabel;

  return (
    <TooltipProvider>
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPending(null); }}>
      <Tip label={t('rail.model') + ' · ' + t('rail.effort') + ' · ' + t('rail.permissionMode')}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" data-composer-pill aria-label={`${summary} · ${permLabel}`} className="max-w-[11rem] min-w-0 shrink gap-1.5 px-2 font-normal">
            {dot ? <StatusDot status={dot} /> : <SlidersHorizontalIcon className="size-3.5" />}
            <span dir="auto" className="truncate">{summary}</span>
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent side="top" align="start" className="w-80 p-1.5" data-composer-pill-menu>
        {pending ? (
          <div className="p-2" role="alertdialog" aria-label={t('rail.stopAndSwitch')}>
            <p className="text-sm text-foreground">
              {t(warn[0], { engine })}<b>{pending.label}</b>{t(warn[1])}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setPending(null)}>{t('rail.cancelBtn')}</Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => apply(pending.kind, pending.value)}>
                {busy ? t('rail.stopping') : t('rail.stopAndSwitch')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="thin-scroll max-h-[60vh] overflow-y-auto">
            <Section
              title={t('rail.model')}
              extra={normalizeEngine(session.engine) === 'claude' && (
                <span className="flex items-center gap-1">
                  {cliUpdate?.updateAvailable && (
                    <a href="#/settings/host/host" onClick={() => setOpen(false)} dir="ltr" title={t('rail.cliUpdate.hint', { v: cliUpdate.latest })} className="rounded-sm bg-muted px-1.5 text-2xs text-foreground no-underline">
                      {t('rail.cliUpdate', { v: cliUpdate.latest })}
                    </a>
                  )}
                  <Button variant="ghost" size="xs" disabled={loading} onClick={refreshModels} aria-label={t('rail.refetchModelList')} title={t('rail.refetchModelList')}>
                    <RefreshCwIcon className={loading ? 'animate-spin' : ''} /> {t('rail.refresh')}
                  </Button>
                </span>
              )}
            >
              {modelOpts.map((o) => (
                <Option key={o.value} selected={o.value === modelChoice} label={o.label} desc={o.desc} onClick={() => pick('model', o.value, o.label, modelChoice)} />
              ))}
            </Section>
            <Section title={t('rail.effort')}>
              {effortOpts.map((o) => (
                <Option key={o.value} selected={o.value === effort} label={o.label} desc={o.desc} onClick={() => pick('effort', o.value, o.label, effort)} />
              ))}
            </Section>
            <Section title={t('rail.permissionMode')}>
              {hasPermissionModes(session.engine) ? (
                permOpts.map((o) => (
                  <Option key={o.value} selected={o.value === perm} label={o.label} desc={o.desc} danger={o.danger} onClick={() => pick('perm', o.value, o.label, perm)} />
                ))
              ) : (
                <p className="px-2 pb-1 text-xs leading-snug text-muted-foreground">{t('rail.noPermissionModes', { engine })}</p>
              )}
            </Section>
          </div>
        )}
      </PopoverContent>
    </Popover>
    </TooltipProvider>
  );
}
