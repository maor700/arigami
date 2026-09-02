// Settings › General › זיכרון (LEARN1 — the approved mock at
// /tmp/memory-learning-mock/index.html): the mode segmented control with its
// explanatory line + "next run", "למד עכשיו", the learning log (collapsed run
// rows → grouped נכנסו / מוזגו / נדחו with a reason and a per-line "בטל"), the
// "N proposals waiting" strip, and — in manual mode — the pre-checked block
// with "מיון חכם" + "אשר N מסומנות". This replaces the Brain view's raw
// pending-approval tab: that list now IS the manual block.
// Data: GET /__api/memory/learning (server/memory-learning.ts status()).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { toastSuccess, toastError } from '../../lib/toast.js';
import { Section, Segmented, BTN, BTN_SM, BTN_PRIMARY } from './shared.jsx';
import { fmtDate, fmtTime } from '../../lib/time.js';

const errText = (e) => String(e?.message || e).replace(/^HTTP \d+ — /, '');

function whenLabel(iso, t) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = fmtTime(iso, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${t('memory.today')} ${time}`;
  return `${fmtDate(iso, { day: 'numeric', month: 'numeric' })} ${time}`;
}

function nextRunLine(st, t) {
  if (!st) return '';
  if (st.mode !== 'auto') return t('memory.next.manual');
  const parts = [];
  const { byCount, at } = st.nextRun || {};
  if (st.pending > 0 && byCount === 0) return t('memory.next.now');
  if (byCount > 0) parts.push(t('memory.next.count', { n: byCount }));
  if (at && st.pending > 0) {
    const d = new Date(at);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const label = d.toDateString() === tomorrow.toDateString()
      ? `${t('memory.tomorrow')} ${fmtTime(at, { hour: '2-digit', minute: '2-digit' })}`
      : `${fmtDate(at, { day: 'numeric', month: 'numeric' })} ${fmtTime(at, { hour: '2-digit', minute: '2-digit' })}`;
    parts.push(label);
  }
  if (!parts.length) return t('memory.next.none');
  return parts.join(` ${t('memory.next.or')} `);
}

// Deterministic reasons come as keys (translated here); model reasons are free text.
export function reasonText(item, t) {
  if (item.reasonKey === 'already-known') return t(`memory.reason.already-known.${item.target}`);
  if (item.reasonKey === 'cluster-member') return t('memory.reason.cluster-member', { key: item.reason || '' });
  if (item.reasonKey) {
    const base = t(`memory.reason.${item.reasonKey}`);
    return item.reason ? `${base} · ${item.reason}` : base;
  }
  if (item.reason) return item.reason;
  if (item.action === 'ENTER' || item.action === 'MERGE') {
    if (item.count > 1 && item.sessions > 1) return t('memory.seen', { n: item.count, s: item.sessions });
    if (item.count > 1) return t('memory.seen.same', { n: item.count });
    return t('memory.seen.once');
  }
  return '';
}

function summaryLine(run, t) {
  const c = run.counts || {};
  if (run.error) return t('memory.run.failed', { error: run.error });
  const parts = [];
  if (c.entered) parts.push({ bold: true, text: t('memory.run.entered', { n: c.entered }) });
  if (c.merged) parts.push({ text: c.merged === 1 ? t('memory.run.merged.one') : t('memory.run.merged', { n: c.merged }) });
  if (c.dropped) parts.push({ text: t('memory.run.dropped', { n: c.dropped }) });
  if (c.deferred) parts.push({ text: t('memory.run.deferred', { n: c.deferred }) });
  return parts;
}

const DOT = { ENTER: 'bg-brand', MERGE: 'bg-[#e0a030]', DROP: 'bg-fgdim/60', DEFER: 'bg-fgdim/30' };

function FactRow({ item, t, onUndo, busy }) {
  const canUndo = item.applied && item.logSeq && !item.undone && (item.action === 'ENTER' || item.action === 'MERGE');
  return (
    <div data-learning-fact data-action={item.action} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-chip/50 ${item.undone ? 'opacity-50' : ''}`}>
      <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${DOT[item.action] || DOT.DROP}`} />
      <span className="min-w-0 flex-1">
        <span className={`text-[12.5px] text-fg ${item.undone ? 'line-through' : ''}`}>
          {item.action === 'DROP' && item.count > 1 ? `"${item.content}" ×${item.count}` : item.content}
        </span>
        {item.action === 'MERGE' && item.mergeInto && <div className="text-[10.5px] text-fgdim">{t('memory.mergedFrom', { line: item.mergeInto })}</div>}
        <div className="text-[10.5px] text-fgdim">{reasonText(item, t)}{item.error ? ` · ${item.error}` : ''}</div>
      </span>
      {canUndo && (
        <button type="button" disabled={busy === item.logSeq} onClick={() => onUndo(item.logSeq)} className="shrink-0 cursor-pointer rounded-md border border-hair px-1.5 text-[10.5px] text-fgdim hover:text-fg disabled:opacity-40">
          {t('memory.undo')}
        </button>
      )}
      {item.undone && <span className="shrink-0 text-[10.5px] text-fgdim">{t('memory.undone')}</span>}
    </div>
  );
}

function RunRow({ run, open, onToggle, t, onUndo, busy }) {
  const [showDropped, setShowDropped] = useState(false);
  const groups = useMemo(() => {
    const g = { ENTER: [], MERGE: [], DROP: [], DEFER: [] };
    for (const it of run.items || []) (g[it.action] || g.DROP).push(it);
    return g;
  }, [run]);
  const sum = summaryLine(run, t);
  return (
    <div data-learning-run={run.id} className="mb-2 overflow-hidden rounded-xl border border-hair bg-panel">
      <button type="button" onClick={onToggle} className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-start">
        <span className="w-[92px] shrink-0 text-[11.5px] text-fgdim">{whenLabel(run.ts, t)}</span>
        <span className="min-w-0 flex-1 text-[12.5px] text-fg">
          {t('memory.run.proposed', { n: run.counts?.proposed ?? 0 })} →{' '}
          {typeof sum === 'string' ? <span className="text-[#9c3b33]">{sum}</span>
            : sum.length === 0 ? <span className="text-fgdim">{t('memory.run.nothing')}</span>
              : sum.map((p, i) => (
                <span key={i}>{i > 0 && ' · '}{p.bold ? <b className="text-brand-ink">{p.text}</b> : p.text}</span>
              ))}
          {!run.applied && !run.error && <span className="ms-2 rounded-full border border-hair px-1.5 text-[9.5px] font-bold text-fgdim uppercase">{t('memory.run.notApplied')}</span>}
        </span>
        <span className="shrink-0 text-[10px] text-fgdim">{t(`memory.run.trigger.${run.trigger}`, { h: 48 })}</span>
        <span className="shrink-0 text-fgdim">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-hair px-3.5 py-2.5 text-[13px]">
          {groups.ENTER.length > 0 && (
            <div className="mb-2.5">
              <div className="mb-1 text-[10.5px] text-fgdim">{t('memory.grp.entered')}</div>
              {groups.ENTER.map((it) => <FactRow key={it.key} item={it} t={t} onUndo={onUndo} busy={busy} />)}
            </div>
          )}
          {groups.MERGE.length > 0 && (
            <div className="mb-2.5">
              <div className="mb-1 text-[10.5px] text-fgdim">{t('memory.grp.merged')}</div>
              {groups.MERGE.map((it) => <FactRow key={it.key} item={it} t={t} onUndo={onUndo} busy={busy} />)}
            </div>
          )}
          {groups.DEFER.length > 0 && (
            <div className="mb-2.5">
              <div className="mb-1 text-[10.5px] text-fgdim">{t('memory.grp.deferred', { n: groups.DEFER.reduce((n, i) => n + i.count, 0) })}</div>
              {groups.DEFER.map((it) => <FactRow key={it.key} item={it} t={t} onUndo={onUndo} busy={busy} />)}
            </div>
          )}
          {groups.DROP.length > 0 && (
            <div className="mb-1">
              <button type="button" onClick={() => setShowDropped((v) => !v)} className="mb-1 cursor-pointer text-[10.5px] text-fgdim hover:text-fg">
                {t('memory.grp.dropped', { n: groups.DROP.reduce((n, i) => n + i.count, 0) })}{!showDropped && ` — ${t('memory.grp.expand')}`}
              </button>
              {(showDropped ? groups.DROP : groups.DROP.slice(0, 3)).map((it) => <FactRow key={it.key} item={it} t={t} onUndo={onUndo} busy={busy} />)}
            </div>
          )}
          {run.notes?.length > 0 && (
            <div className="mt-2 text-[10.5px] text-fgdim">
              <div className="mb-0.5">{t('memory.notes')}</div>
              {run.notes.map((n, i) => <div key={i} dir="ltr" className="font-mono">· {n}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TAG_CLS = 'mt-[3px] shrink-0 rounded-md border border-hair px-1.5 text-[10px] text-fgdim';

// Manual mode. Before a smart sort: the pre-pass clusters (checked) + the
// deterministic drops (unchecked, struck through). After "מיון חכם": the stored
// proposed run's items (ENTER/MERGE checked, DROP unchecked). One approve button.
function ManualBlock({ st, t, reload, setBusyGlobal }) {
  const [checked, setChecked] = useState(() => new Set());
  const [init, setInit] = useState('');
  const [busy, setBusy] = useState(null);
  const proposed = st.proposedRun;
  const rows = useMemo(() => {
    if (proposed) return proposed.items.map((it) => ({ key: it.key, content: it.content, count: it.count, action: it.action, reasonKey: it.reasonKey, reason: it.reason, target: it.target, mergeInto: it.mergeInto, selectable: it.action === 'ENTER' || it.action === 'MERGE' }));
    const pv = st.preview || { clusters: [], dropped: [] };
    return [
      ...pv.clusters.map((c) => ({ key: c.key, content: c.content, count: c.count, action: 'ENTER', target: c.target, related: c.related, selectable: true })),
      ...pv.dropped.map((d) => ({ key: d.key, content: d.content, count: d.count, action: 'DROP', reasonKey: d.reasonKey, target: d.target, selectable: false })),
    ];
  }, [st, proposed]);
  // Re-seed the checked set whenever the row set changes (new proposals / a new smart sort).
  const sig = rows.map((r) => r.key + ':' + r.action).join('|') + (proposed?.id || '');
  useEffect(() => {
    if (sig === init) return;
    setChecked(new Set(rows.filter((r) => r.selectable).map((r) => r.key)));
    setInit(sig);
  }, [sig, init, rows]);

  const toggle = (key) => setChecked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const n = checked.size;

  const smart = async () => {
    setBusy('smart'); setBusyGlobal(true);
    try {
      const r = await api.post('/memory/learning/run', { apply: false });
      toastSuccess(t('memory.manual.smartDone', { n: (r.run?.items || []).filter((i) => i.action === 'ENTER' || i.action === 'MERGE').length }));
      await reload();
    } catch (e) { toastError(errText(e)); } finally { setBusy(null); setBusyGlobal(false); }
  };
  const approve = async () => {
    setBusy('approve');
    try {
      const keys = [...checked];
      const r = await api.post('/memory/learning/apply', proposed ? { runId: proposed.id, keys } : { keys });
      toastSuccess(t('memory.manual.approved', { n: (r.run?.counts?.entered || 0) + (r.run?.counts?.merged || 0), d: r.run?.counts?.dropped || 0 }));
      await reload();
    } catch (e) { toastError(errText(e)); } finally { setBusy(null); }
  };

  const tag = (r) => {
    if (r.action === 'DROP') {
      if (r.reasonKey === 'already-known') return t('memory.tag.dup', { n: r.count });
      if (r.reasonKey === 'repo-doc') return t('memory.tag.doc');
      if (r.reasonKey === 'sensitive' || r.reasonKey === 'unsafe') return t('memory.tag.sensitive');
      return r.count > 1 ? t('memory.tag.times', { n: r.count }) : t('memory.tag.drop');
    }
    if (r.action === 'MERGE') return t('memory.tag.merge');
    if (r.action === 'DEFER') return t('memory.tag.defer');
    return r.count > 1 ? t('memory.tag.times', { n: r.count }) : t('memory.tag.new');
  };

  return (
    <div data-learning-manual className="mt-5 rounded-xl border border-hair bg-panel px-3.5 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <b className="text-[12.5px] text-fg">{t('memory.manual.title')}</b>
        <span className="text-[11.5px] text-fgdim">— {t('memory.manual.hint')}</span>
        <span className="ms-auto flex items-center gap-1.5">
          <button type="button" disabled={!!busy || st.running || !(st.pending > 0)} onClick={smart} className={BTN_SM}>{busy === 'smart' ? t('memory.learning') : t('memory.manual.smart')}</button>
          <button type="button" disabled={!!busy || n === 0} onClick={approve} className={BTN_PRIMARY}>{t('memory.manual.approve', { n })}</button>
        </span>
      </div>
      {rows.length === 0 && <div className="py-1 text-[11.5px] text-fgdim">{t('memory.manual.empty')}</div>}
      {rows.map((r) => (
        <label key={r.key} data-learning-row data-action={r.action} className={`flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[12.5px] ${r.selectable ? 'text-fg' : 'text-fgdim'}`}>
          <input type="checkbox" className="mt-1" disabled={!r.selectable} checked={r.selectable && checked.has(r.key)} onChange={() => toggle(r.key)} />
          <span className={`min-w-0 flex-1 ${r.selectable ? '' : 'line-through'}`}>
            {r.content}
            {r.action === 'MERGE' && r.mergeInto && <div className="text-[10.5px] text-fgdim no-underline">{t('memory.mergedFrom', { line: r.mergeInto })}</div>}
            {(r.reason || r.reasonKey) && <div className="text-[10.5px] text-fgdim">{reasonText(r, t)}</div>}
          </span>
          <span className={TAG_CLS}>{tag(r)}</span>
        </label>
      ))}
    </div>
  );
}

export default function MemoryLearning({ first = false }) {
  const t = useT();
  const { auth, hostEvent } = useStore();
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(null);
  const [open, setOpen] = useState(null);
  const [showPending, setShowPending] = useState(false);

  const load = () => api.get('/memory/learning').then((r) => { setSt(r); return r; }).catch((e) => { toastError(errText(e)); return null; });
  useEffect(() => { load(); }, []);
  // A scheduled run finishing elsewhere (auto mode) → the log refreshes by itself.
  useEffect(() => { if (hostEvent?.kind === 'learning' && (hostEvent.phase === 'done' || hostEvent.phase === 'applied' || hostEvent.phase === 'error')) load(); }, [hostEvent]);
  useEffect(() => { if (st?.runs?.length && open === null) setOpen(st.runs[0].id); }, [st, open]);

  const setMode = async (mode) => {
    if (!st || mode === st.mode) return;
    setBusy(true);
    try {
      const next = await api.post('/memory/learning/mode', { mode });
      setSt((s) => ({ ...s, ...next, preview: s?.preview }));
      toastSuccess(t('memory.modeSaved'));
      await load();
    }
    catch (e) { toastError(errText(e)); } finally { setBusy(false); }
  };
  const learnNow = async () => {
    setBusy(true);
    try { await api.post('/memory/learning/run', {}); await load(); }
    catch (e) { toastError(errText(e)); } finally { setBusy(false); }
  };
  const undo = async (seq) => {
    setUndoBusy(seq);
    try { await api.post(`/memory/learning/undo/${seq}`); toastSuccess(t('memory.undoDone')); await load(); }
    catch (e) { toastError(errText(e)); } finally { setUndoBusy(null); }
  };

  const auto = st?.mode === 'auto';
  const deferred = st?.lastDeferred?.reason === 'memory' && auto && st.pending > 0;

  return (
    <Section id="memory" title={t('memory.title')} first={first}>
      <div className="mb-3 text-[11.5px] text-fgdim">{t('memory.sub')}</div>

      <div data-learning-mode className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-hair bg-panel px-3.5 py-3">
        <Segmented
          value={st?.mode || 'auto'}
          onChange={(v) => admin && setMode(v)}
          options={[{ value: 'auto', label: t('memory.mode.auto') }, { value: 'manual', label: t('memory.mode.manual') }]}
        />
        <div className="min-w-[12rem] flex-1">
          <b className="block text-[12.5px] text-fg">{t(auto ? 'memory.mode.auto.title' : 'memory.mode.manual.title')}</b>
          <span className="text-[11px] text-fgdim">{t(auto ? 'memory.mode.auto.desc' : 'memory.mode.manual.desc')}</span>
        </div>
        <div className="flex w-full items-center gap-3 border-t border-hair pt-2.5">
          <div data-learning-next className="flex-1 text-[11px] text-fgdim">
            {t('memory.next')}: {nextRunLine(st, t)}
            {' · '}
            <b className="text-fg">{t('memory.pendingCount', { n: st?.pending ?? 0 })}</b>
          </div>
          <button type="button" disabled={!st || busy || st.running || !admin} onClick={learnNow} className={BTN}>{busy || st?.running ? t('memory.learning') : t('memory.learnNow')}</button>
        </div>
        {deferred && <div className="w-full text-[11px] text-amber-600">{t('memory.deferred', { mb: st.lastDeferred.availableMb ?? '?', min: st.config?.minFreeMb ?? '?' })}</div>}
      </div>

      <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('memory.log')}</div>
      {st && st.runs.length === 0 && <div className="mb-3 rounded-xl border border-hair bg-panel px-3.5 py-3 text-[11.5px] text-fgdim">{t('memory.log.empty')}</div>}
      {(st?.runs || []).map((run) => (
        <RunRow key={run.id} run={run} open={open === run.id} onToggle={() => setOpen(open === run.id ? '' : run.id)} t={t} onUndo={undo} busy={undoBusy} />
      ))}

      <div data-learning-pending className="mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed border-hair px-3.5 py-3 text-[12.5px] text-fgdim">
        <span>⏳</span>
        <span>{st?.pending > 0 ? t('memory.pending.strip', { n: st.pending }) : t('memory.pending.none')}</span>
        <span className="flex-1" />
        {st?.pending > 0 && auto && <button type="button" onClick={() => setShowPending((v) => !v)} className={BTN_SM}>{showPending ? t('memory.pending.hide') : t('memory.pending.show')}</button>}
      </div>
      {auto && showPending && st?.preview && (
        <div className="mt-2 rounded-xl border border-hair bg-panel px-3.5 py-2">
          {[...st.preview.clusters.map((c) => ({ ...c, action: 'ENTER' })), ...st.preview.dropped].map((r) => (
            <div key={r.key} className={`flex items-start gap-2 px-1.5 py-1 text-[12px] ${r.action === 'DROP' ? 'text-fgdim' : 'text-fg'}`}>
              <span className={`min-w-0 flex-1 ${r.action === 'DROP' ? 'line-through' : ''}`}>{r.content}</span>
              <span className={TAG_CLS}>{r.action === 'DROP' ? t(`memory.reason.${r.reasonKey}`) : r.count > 1 ? t('memory.tag.times', { n: r.count }) : t('memory.tag.new')}</span>
            </div>
          ))}
        </div>
      )}

      {st && !auto && admin && <ManualBlock st={st} t={t} reload={load} setBusyGlobal={setBusy} />}

      <div className="mt-4 border-t border-hair pt-2.5 text-[10.5px] leading-relaxed text-fgdim">
        {t('memory.footnote', { n: st?.config?.minBatch ?? 40 })}{' '}
        <a href="#/brain" className="underline hover:text-fg">{t('memory.brainLink')}</a>
      </div>
    </Section>
  );
}
