// Settings › Host: version/commit + update check, supervisor/uptime, restart
// now / when idle, upgrade, and Backup (export full/bundle, import). Mutations
// go through POST /__api/host/* with the X-Arigami-Confirm header
// (server/host-control.ts); progress arrives as `host` bus events
// (store.js → state.hostEvent). Users/access, VNC and the danger zone are in
// Access.jsx.
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toast, toastError } from '../../lib/toast.js';
import { Section, Field, BTN, hostPost } from './shared.jsx';
import Budgets from './Budgets.jsx';

function fmtUptime(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 90) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

// B4-full — Export is a plain download of GET /__api/host/export?mode=…;
// import POSTs the chosen .tgz raw. A full restore ends in a host restart.
function BackupField({ disabled, onRestarting, reload }) {
  const t = useT();
  const [exporting, setExporting] = useState(null);
  const [importing, setImporting] = useState(false);
  const [force, setForce] = useState(false);
  const [memory, setMemory] = useState(true);
  const fileRef = useRef(null);

  const download = async (mode) => {
    setExporting(mode);
    try {
      const r = await fetch(`/__api/host/export?mode=${mode}${mode === 'bundle' && !memory ? '&memory=0' : ''}`);
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b?.error || `HTTP ${r.status}`); }
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || `arigami-${mode}.tgz`;
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { toastError(e?.message || String(e)); } finally { setExporting(null); }
  };

  const onFile = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    const ok = await confirmDialog({ title: t('host.confirmImport.title'), body: t('host.confirmImport.body', { file: file.name }), confirmLabel: t('host.confirmImport.ok') });
    if (!ok) return;
    setImporting(true);
    try {
      const r = await hostPost(`/host/import${force ? '?force=1' : ''}`, 'POST', file);
      if (r.kind === 'bundle') toast(t('host.importDoneBundle', { name: r.name, repos: r.repos?.length || 0, skills: r.skills?.length || 0, cron: r.cron?.length || 0 }));
      else if (r.restart?.scheduled) { onRestarting?.(); toast(t('host.importDoneFull', { version: r.manifest?.version || '?', bak: r.backupDir || '—' })); }
      else toast(t('host.importDoneFullNoRestart', { bak: r.backupDir || '—' }));
      reload?.();
    } catch (e) {
      if (e?.status === 409 && /working/.test(e.message)) toastError(t('host.err.busy'));
      else if (e?.status === 409 && /newer/.test(e.message)) toastError(t('host.err.newer'));
      else if (e?.status === 403) toastError(t('host.err.forbidden'));
      else toastError(e?.message || String(e));
    } finally { setImporting(false); }
  };

  const off = disabled || importing || !!exporting;
  return (
    <Section id="backup" title={t('host.backup')}>
      <Field label={t('host.backup')} hint={t('host.backup.hint')} wrap>
        <div className="flex flex-col items-end gap-1.5">
          <span className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={off} onClick={() => download('full')} className={BTN}>{exporting === 'full' ? t('host.exporting') : t('host.exportFull')}</button>
            <button type="button" disabled={off} onClick={() => download('bundle')} className={BTN}>{exporting === 'bundle' ? t('host.exporting') : t('host.exportBundle')}</button>
            <button type="button" disabled={off} onClick={() => fileRef.current?.click()} className={BTN}>{importing ? t('host.importing') : t('host.import')}</button>
            <input ref={fileRef} type="file" accept=".tgz,.tar.gz,application/gzip,application/x-gzip" className="hidden" onChange={onFile} />
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10.5px] text-fgdim">
            <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} disabled={off} />
            {t('host.exportMemory')}
          </label>
          {memory && <div className="max-w-[28rem] text-end font-mono text-[10.5px] text-amber-500">{t('host.exportMemory.warn')}</div>}
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10.5px] text-fgdim">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={off} />
            {t('host.importForce')}
          </label>
        </div>
      </Field>
    </Section>
  );
}

export default function Host() {
  const t = useT();
  const { conn, hostEvent } = useStore();
  const [ver, setVer] = useState(null);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [log, setLog] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const wasDown = useRef(false);
  const restarting = useRef(false);

  const load = () => {
    api.get('/host/status').then(setSt).catch(() => setSt(null));
    api.get('/version').then(setVer).catch(() => setVer(null));
  };
  useEffect(() => { load(); }, []);

  // Reconnect after a restart we triggered → refresh + toast.
  useEffect(() => {
    if (conn !== 'open') { wasDown.current = true; return; }
    if (wasDown.current) {
      wasDown.current = false;
      if (restarting.current) { restarting.current = false; toast(t('host.back')); }
      setLog([]);
      load();
    }
  }, [conn]);

  // Live progress from the bus.
  useEffect(() => {
    if (!hostEvent) return;
    const ev = hostEvent;
    if (ev.kind === 'upgrade-progress') {
      setLog((l) => [...l.slice(-199), ev.line]);
      setSt((s) => (s ? { ...s, upgrade: { ...(s.upgrade || {}), step: ev.step, finishedAt: null } } : s));
      return;
    }
    if (ev.kind === 'upgrade-failed') { toastError(t('host.upgradeFailed', { error: ev.error })); setShowLog(true); }
    if (ev.kind === 'upgrade-done') toast(t('host.upgradeDone'));
    if (ev.kind === 'restarting' || ev.kind === 'restart-draining') restarting.current = true;
    load();
  }, [hostEvent]);

  const fail = (e) => {
    if (e?.status === 409 && /supervisor/.test(e.message)) toastError(t('host.err.noSupervisor'));
    else if (e?.status === 403) toastError(t('host.err.forbidden'));
    else toastError(e?.message || String(e));
  };
  const act = async (fn) => {
    setBusy(true);
    try { await fn(); load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const restartNow = async () => {
    const n = st?.busySessions || 0;
    const ok = await confirmDialog({ title: t('host.confirmRestart.title'), body: n ? t('host.confirmRestart.body', { n }) : '', confirmLabel: t('host.confirmRestart.ok'), danger: true });
    if (!ok) return;
    restarting.current = true;
    act(() => hostPost('/host/restart?when=now'));
  };
  const restartIdle = () => act(() => hostPost('/host/restart?when=idle'));
  const cancelPending = () => act(() => hostPost('/host/restart', 'DELETE'));
  const upgrade = async (when) => {
    const ok = await confirmDialog({ title: t('host.confirmUpgrade.title'), body: t('host.confirmUpgrade.body'), confirmLabel: t('host.confirmUpgrade.ok'), danger: true });
    if (!ok) return;
    setLog([]); setShowLog(true);
    act(() => hostPost(`/host/upgrade?when=${when}`));
  };
  const check = async () => {
    setChecking(true);
    try { setVer(await api.get('/version?refresh=1')); } catch (e) { fail(e); } finally { setChecking(false); }
  };

  const noSup = st && st.manager === 'none';
  const pending = st?.pendingRestart;
  const phase = st?.phase;
  const upg = st?.upgrade;
  const upgRunning = !!upg && upg.finishedAt === null;
  const disabled = busy || noSup || phase === 'draining' || phase === 'exiting' || upgRunning;
  const warn = 'font-mono text-[10.5px] text-[#CE8324]';

  return (
    <>
      <Section id="host" title={t('host.title')} first>
        <Field label={t('host.version')} hint={t('host.version.hint')}>
          <div className="flex flex-col items-end gap-1">
            <span className="font-mono text-[11.5px] text-fg" dir="ltr">{ver ? `v${ver.version} · ${ver.commit || '?'}${ver.branch ? ` · ${ver.branch}` : ''}` : '…'}</span>
            <span className="flex items-center gap-2 font-mono text-[10.5px] text-fgdim">
              {ver && !st?.docker && (ver.ahead === null ? t('host.noUpstream') : ver.ahead > 0 ? <span className="text-[#CE8324]">{t('host.updateAvailable', { n: ver.ahead })}</span> : t('host.upToDate'))}
              <button type="button" disabled={checking} onClick={check} className="cursor-pointer underline disabled:opacity-50">{checking ? t('host.checking') : t('host.check')}</button>
            </span>
          </div>
        </Field>
        {st?.docker && (
          <Field label={t('host.image')} hint={t('host.image.hint')}>
            <span className="font-mono text-[11.5px] text-fg" dir="ltr">{st.image || ver?.image || 'docker'}</span>
          </Field>
        )}
        <Field label={t('host.manager')} hint={t('host.manager.hint')}>
          <span className="font-mono text-[11.5px] text-fg" dir="ltr">
            {st ? `${st.manager === 'docker' ? t('host.docker.manager') : st.manager} · ${t('host.uptime', { t: fmtUptime(st.uptimeSec) })}${st.busySessions ? ` · ${t('host.busy', { n: st.busySessions })}` : ''}` : '…'}
          </span>
        </Field>
        <Field label={t('host.restart')} hint={t('host.restart.hint')} wrap>
          <div className="flex flex-col items-end gap-1.5">
            <span className="flex items-center gap-2">
              {pending === 'idle' && phase === 'pending-idle'
                ? <button type="button" disabled={busy} onClick={cancelPending} className={BTN}>{t('host.cancelPending')}</button>
                : <button type="button" disabled={disabled} onClick={restartIdle} className={BTN}>{t('host.restartIdle')}</button>}
              <button type="button" disabled={disabled} onClick={restartNow} className={BTN}>{t('host.restartNow')}</button>
            </span>
            {phase === 'pending-idle' && <span className={warn}>{t('host.pendingIdle', { n: st.busySessions })}</span>}
            {phase === 'draining' && <span className={warn}>{t('host.draining')}</span>}
            {phase === 'exiting' && <span className={warn}>{t('host.restarting')}</span>}
          </div>
        </Field>
        {st?.docker ? (
          <Field label={t('host.upgrade')} hint={t('host.docker.upgradeHint')} wrap>
            <div className="flex flex-col items-end gap-1">
              <span className="text-[11px] text-fgdim">{t('host.docker.upgrade')}</span>
              <code dir="ltr" className="rounded-[6px] border border-hair bg-bg px-2 py-1 font-mono text-[10.5px] select-all">docker compose pull && docker compose up -d</code>
            </div>
          </Field>
        ) : (
        <Field label={t('host.upgrade')} hint={st && !st.allowUpgrade ? t('host.upgradeDisabled') : t('host.upgrade.hint')} wrap>
          <div className="flex flex-col items-end gap-1.5">
            <span className="flex items-center gap-2">
              <button type="button" disabled={disabled || !st?.allowUpgrade} onClick={() => upgrade('idle')} className={BTN}>{t('host.upgradeIdleBtn')}</button>
              <button type="button" disabled={disabled || !st?.allowUpgrade} onClick={() => upgrade('now')} className={BTN}>{t('host.upgradeBtn')}</button>
            </span>
            {upgRunning && <span className={warn}>{t('host.upgradeRunning', { step: upg.step || '…' })}</span>}
            {(log.length > 0 || upg?.log?.length > 0) && (
              <button type="button" onClick={() => setShowLog((v) => !v)} className="cursor-pointer font-mono text-[10.5px] text-fgdim underline">{t('host.log')}</button>
            )}
          </div>
        </Field>
        )}
        {showLog && (log.length > 0 || upg?.log?.length > 0) && (
          <pre dir="ltr" className="thin-scroll my-3 max-h-[220px] overflow-auto rounded-lg border border-hair bg-bg p-2 font-mono text-[10.5px] leading-snug text-fg">{(log.length ? log : upg.log).join('\n')}</pre>
        )}
      </Section>
      <Budgets />
      <BackupField disabled={busy || phase === 'draining' || phase === 'exiting' || upgRunning} onRestarting={() => { restarting.current = true; }} reload={load} />
    </>
  );
}
