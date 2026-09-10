// Settings › Host (AUDIT2: 23 → ~6 default-visible rows). On the page: version
// + update (one row), Claude CLI (one row: installed / update available /
// update now — UPD1), restart, upgrade, backup (three buttons) and Users &
// access › signed-in-as + pairing (Access.jsx › WhoAmI). In the Advanced
// drawer: CLI details (last check / last update / auto-update toggle), the
// process manager row, the upgrade log, export/import options, per-agent
// budgets (Budgets.jsx — the agent page has the same field), Health
// (Health.jsx, reminders filtered), the users list + API tokens, the VNC
// password and the danger zone. Mutations go through POST /__api/host/* with
// the X-Arigami-Confirm header (server/host-control.ts); progress arrives as
// `host` bus events (store.js → state.hostEvent).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toast, toastError } from '../../lib/toast.js';
import { Section, Field, BTN, Toggle, hostPost, Advanced } from './shared.jsx';
import { relTime } from '../../lib/time.js';
import Budgets from './Budgets.jsx';
import Health from './Health.jsx';
import { WhoAmI, UsersAdvanced, ScreenShare, DangerZone } from './Access.jsx';
import { useShell, openMachines } from '../../lib/shell.js';

export const HOST_ADVANCED_IDS = ['cli-details', 'manager', 'upgrade-legacy', 'upgrade-log', 'backup-options', 'budgets', 'health', 'users-list', 'screen', 'danger'];

// VER1: sessionStorage is absent when the page is rendered server-side (tests).
const ss = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : null);

// VER1: numeric-triple compare ("0.2.0" vs "0.1.9"); 0 when either side is not a version.
function cmpVer(a, b) {
  const pa = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(a || ''));
  const pb = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(b || ''));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

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
// The two checkboxes (bundle memory seed, force import) render in the drawer
// (`BackupOptions`) — state is lifted to the page so both halves agree.
function BackupField({ disabled, onRestarting, reload, memory, force }) {
  const t = useT();
  const [exporting, setExporting] = useState(null);
  const [importing, setImporting] = useState(false);
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
        <span className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" disabled={off} onClick={() => download('full')} className={BTN}>{exporting === 'full' ? t('host.exporting') : t('host.exportFull')}</button>
          <button type="button" disabled={off} onClick={() => download('bundle')} className={BTN}>{exporting === 'bundle' ? t('host.exporting') : t('host.exportBundle')}</button>
          <button type="button" disabled={off} onClick={() => fileRef.current?.click()} className={BTN}>{importing ? t('host.importing') : t('host.import')}</button>
          <input ref={fileRef} type="file" accept=".tgz,.tar.gz,application/gzip,application/x-gzip" className="hidden" onChange={onFile} />
        </span>
      </Field>
    </Section>
  );
}

function BackupOptions({ memory, setMemory, force, setForce, disabled }) {
  const t = useT();
  return (
    <Section id="backup-options" title={t('settings.host.backupOptions')}>
      <div className="flex flex-col gap-1.5 py-2">
        <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
          <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} disabled={disabled} />
          {t('host.exportMemory')}
        </label>
        {memory && <div className="max-w-[28rem] font-mono text-[11.5px] md:text-[10.5px] text-amber-500">{t('host.exportMemory.warn')}</div>}
        <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={disabled} />
          {t('host.importForce')}
        </label>
      </div>
    </Section>
  );
}

// Desktop shell only: the entry point for linking a second Arigami — another
// computer, a VPS over Tailscale — and the only way in until one exists. Once
// there are two, the rail's brand row grows a switcher (Rail.jsx › MachineChip)
// and this stays as the place to add, rename or forget one.
//
// The list, and the window that edits it, both live in the shell
// (desktop/src-tauri/src/main.rs); the cockpit only reads window.__arigami and
// asks for that window. In a browser useShell() is null and nothing renders.
function Machines() {
  const t = useT();
  const shell = useShell();
  if (!shell) return null;
  const n = (shell.machines || []).length;
  return (
    <Section id="machines" title={t('host.machines')}>
      <Field label={t('host.machines.linked')} hint={t('host.machines.hint')}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fgdim">{t('host.machines.count', { n })}</span>
          <button type="button" className={BTN} onClick={openMachines}>
            {t('host.machines.manage')}
          </button>
        </div>
      </Field>
    </Section>
  );
}

export default function Host({ section = '' }) {
  const t = useT();
  const { conn, hostEvent } = useStore();
  const [ver, setVer] = useState(null);
  const [st, setSt] = useState(null);
  const [cli, setCli] = useState(null); // UPD1: GET /host/claude
  const [cliBusy, setCliBusy] = useState(null); // 'check' | 'update' | 'auto'
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [log, setLog] = useState([]);
  const [updateErr, setUpdateErr] = useState(null); // VER1: {error, dirty?} from a refused POST /host/upgrade
  const [dismissedJob, setDismissedJob] = useState(() => ss()?.getItem('host.ver.dismissed') || null);
  const [memory, setMemory] = useState(true);
  const [force, setForce] = useState(false);
  const wasDown = useRef(false);
  const restarting = useRef(false);

  const load = () => {
    api.get('/host/status').then(setSt).catch(() => setSt(null));
    api.get('/version').then(setVer).catch(() => setVer(null));
    api.get('/host/claude').then(setCli).catch(() => setCli(null));
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
    if (ev.kind === 'upgrade-failed') toastError(t('host.upgradeFailed', { error: ev.error }));
    // VER1: confirm-mode upgrades park with needsRestart — the card below asks for the click.
    if (ev.kind === 'upgrade-done') toast(ev.needsRestart ? t('host.ver.builtToast', { to: ev.to || '?' }) : t('host.upgradeDone'));
    if (ev.kind === 'restarting' || ev.kind === 'restart-draining') restarting.current = true;
    // UPD1: done/failed are toasted globally (store.js); here just refresh the row.
    if (ev.kind === 'claude-update-started') setCli((c) => (c ? { ...c, applying: true } : c));
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
    setLog([]);
    act(() => hostPost(`/host/upgrade?when=${when}`));
  };
  const check = async () => {
    setChecking(true);
    try { setVer(await api.get('/version?refresh=1')); api.get('/host/status').then(setSt).catch(() => {}); } catch (e) { fail(e); } finally { setChecking(false); }
  };
  // VER1 — "Update": pull + install + build with when=confirm; the restart is the card's click.
  const update = async () => {
    const ok = await confirmDialog({ title: t('host.ver.confirmUpdate.title'), body: t('host.ver.confirmUpdate.body', { from: ver?.version || '?', to: ver?.available?.version || ver?.version || '?' }), confirmLabel: t('host.ver.confirmUpdate.ok') });
    if (!ok) return;
    setLog([]); setUpdateErr(null);
    setBusy(true);
    try { await hostPost('/host/upgrade?when=confirm'); load(); } catch (e) {
      if (e?.status === 409 && e.dirty) setUpdateErr({ error: e.message, dirty: e.dirty });
      else fail(e);
      load();
    } finally { setBusy(false); }
  };
  const restartAfterUpdate = async (when) => {
    if (when === 'now') {
      const n = st?.busySessions || 0;
      const ok = await confirmDialog({ title: t('host.confirmRestart.title'), body: n ? t('host.confirmRestart.body', { n }) : '', confirmLabel: t('host.confirmRestart.ok'), danger: true });
      if (!ok) return;
    }
    restarting.current = true;
    act(() => hostPost(`/host/restart?when=${when}`));
  };
  const dismissReady = (jobId) => { ss()?.setItem('host.ver.dismissed', jobId); setDismissedJob(jobId); };
  // UPD1 — the `claude` CLI row. Mutations are admin-confirmed POSTs like the rest of the card.
  const cliAct = async (what, fn) => {
    setCliBusy(what);
    try { setCli(await fn()); } catch (e) {
      if (e?.status === 409 && /memory|MB/.test(e.message || '')) toastError(t('host.cli.deferredToast', { mb: cli?.availableMb ?? '?', min: cli?.minFreeMb ?? '?' }));
      else fail(e);
      api.get('/host/claude').then(setCli).catch(() => {});
    } finally { setCliBusy(null); }
  };
  const cliCheck = () => cliAct('check', () => hostPost('/host/claude/check'));
  const cliUpdate = () => cliAct('update', async () => (await hostPost('/host/claude/update')).status);
  const cliAuto = (on) => cliAct('auto', () => hostPost('/host/claude/auto', 'POST', { enabled: on }));

  const noSup = st && st.manager === 'none';
  const pending = st?.pendingRestart;
  const phase = st?.phase;
  const upg = st?.upgrade;
  const upgRunning = !!upg && upg.finishedAt === null;
  const disabled = busy || noSup || phase === 'draining' || phase === 'exiting' || upgRunning;
  const warn = 'font-mono text-[11.5px] md:text-[10.5px] text-[#CE8324]';
  const hasLog = log.length > 0 || (upg?.log?.length || 0) > 0;
  const advIds = hasLog ? HOST_ADVANCED_IDS : HOST_ADVANCED_IDS.filter((x) => x !== 'upgrade-log');
  // VER1 — the version row's derived state.
  const avail = ver?.available?.version || null;
  const newer = !!avail && !!ver?.version && cmpVer(avail, ver.version) > 0;
  const canUpdate = !!ver && !st?.docker && (newer || ver.ahead > 0);
  const dirtyList = updateErr?.dirty?.length ? updateErr.dirty : st?.dirty || [];
  const blocked = dirtyList.length > 0 || ver?.sharedBase === false || (ver?.behind > 0 && ver?.ahead > 0);
  const readyJob = upg && upg.ok && upg.needsRestart && phase !== 'exiting' ? upg : null;
  const readyDismissed = !!readyJob && dismissedJob === readyJob.id;

  return (
    <>
      <Section id="host" title={t('host.title')} first>
        <Field label={t('host.version')} hint={t('host.version.hint')} wrap>
          <div className="flex w-full max-w-full flex-col items-end gap-1.5">
            <span className="max-w-full break-all font-mono text-[11.5px] text-fg" dir="ltr">
              <span className="text-fgdim">{t('host.ver.current')} </span>
              {ver ? `v${ver.version} · ${ver.commit || '?'}${ver.branch ? ` · ${ver.branch}` : ''}` : '…'}
            </span>
            {ver && !st?.docker && (
              <span className="max-w-full break-all font-mono text-[11.5px] text-fg" dir="ltr">
                <span className="text-fgdim">{t('host.ver.available')} </span>
                {avail ? `v${avail}${ver.available?.tag && ver.available.tag !== `v${avail}` ? ` · ${ver.available.tag}` : ''}` : t('host.ver.availableUnknown')}
                {ver.available?.release?.url && <> · <a href={ver.available.release.url} target="_blank" rel="noreferrer" className="underline">{t('host.ver.release')}</a></>}
              </span>
            )}
            <span className="flex flex-wrap items-center justify-end gap-2 font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
              {ver && !st?.docker && (
                ver.ahead === null ? t('host.noUpstream')
                : newer ? <span className="text-[#CE8324]">{t('host.ver.newer', { v: avail })}</span>
                : ver.ahead > 0 ? <span className="text-[#CE8324]">{t('host.ver.aheadOnly', { n: ver.ahead })}</span>
                : t('host.upToDate')
              )}
              {ver?.fetchedAt ? <span>· {t('host.ver.checkedAt', { when: relTime(ver.fetchedAt) })}</span> : null}
              <button type="button" disabled={checking} onClick={check} className="cursor-pointer underline disabled:opacity-50">{checking ? t('host.checking') : t('host.check')}</button>
            </span>
            {canUpdate && !upgRunning && !readyJob && (
              <button type="button" disabled={disabled || blocked || !st?.allowUpgrade} onClick={update} className={BTN}>{t('host.ver.update')}</button>
            )}
            {upgRunning && <span className={warn}>{t('host.ver.updating', { step: upg.step || '…' })}</span>}
            {st && !st.allowUpgrade && !st.docker && <span className={warn}>{t('host.upgradeDisabled')}</span>}
            {dirtyList.length > 0 && (
              <div className="w-full max-w-[28rem] rounded-xl border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-start text-[11px] text-[#9c3b33]">
                <div className="font-bold">{t('host.ver.dirty.title', { n: dirtyList.length })}</div>
                <ul dir="ltr" className="my-1 max-h-[140px] overflow-auto font-mono text-[11.5px] md:text-[10.5px] leading-snug">
                  {dirtyList.slice(0, 20).map((f) => <li key={f}>{f}</li>)}
                  {dirtyList.length > 20 && <li>… +{dirtyList.length - 20}</li>}
                </ul>
                <div className="text-fgdim">{t('host.ver.dirty.how')}</div>
              </div>
            )}
            {ver?.sharedBase === false && (
              <div className="w-full max-w-[28rem] rounded-xl border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-start text-[11px] text-[#9c3b33]">
                <div className="font-bold">{t('host.ver.noBase.title')}</div>
                <div className="text-fgdim">{t('host.ver.noBase.how')}</div>
              </div>
            )}
            {ver?.sharedBase !== false && ver?.behind > 0 && ver?.ahead > 0 && (
              <div className="w-full max-w-[28rem] rounded-xl border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-start text-[11px] text-[#9c3b33]">{t('host.ver.notFF', { n: ver.behind })}</div>
            )}
            {readyJob && !readyDismissed && (
              <div className="w-full max-w-[28rem] rounded-xl border-[1.5px] border-ink bg-panel px-3 py-2.5 text-start">
                <div className="text-[12.5px] font-bold text-fg" dir="auto">{t('host.ver.ready.title', { from: readyJob.from || '?', to: readyJob.to || '?' })}</div>
                <div className="mt-0.5 text-[11px] text-fgdim">{t('host.ver.ready.body')}</div>
                {st?.busySessions > 0 && <div className={`mt-0.5 ${warn}`}>{t('host.ver.ready.busy', { n: st.busySessions })}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy || phase === 'draining' || phase === 'exiting'} onClick={() => restartAfterUpdate('now')} className={BTN}>{t('host.ver.restartNow')}</button>
                  <button type="button" disabled={busy || phase !== 'idle'} onClick={() => restartAfterUpdate('idle')} className={BTN}>{t('host.ver.restartIdle')}</button>
                  <button type="button" onClick={() => dismissReady(readyJob.id)} className="cursor-pointer font-mono text-[11.5px] md:text-[10.5px] text-fgdim underline">{t('host.ver.later')}</button>
                </div>
                {phase === 'pending-idle' && <div className={`mt-1 ${warn}`}>{t('host.pendingIdle', { n: st.busySessions })}</div>}
              </div>
            )}
            {readyJob && readyDismissed && (
              <span className={warn}>
                {t('host.ver.ready.title', { from: readyJob.from || '?', to: readyJob.to || '?' })} · <button type="button" onClick={() => { ss()?.removeItem('host.ver.dismissed'); setDismissedJob(null); }} className="cursor-pointer underline">{t('host.ver.restartNow')}</button>
              </span>
            )}
            {hasLog && <a href="#/settings/host/upgrade-log" className="cursor-pointer font-mono text-[11.5px] md:text-[10.5px] text-fgdim underline">{t('host.log')}</a>}
          </div>
        </Field>
        <Field label={t('host.cli')} hint={t('host.cli.hint')} wrap>
          <span className="flex flex-wrap items-center justify-end gap-2">
            <span className="font-mono text-[11.5px] text-fg" dir="ltr">{cli?.installed ? t('host.cli.installed', { v: cli.installed }) : '…'}</span>
            {cli?.updateAvailable
              ? <span className="font-mono text-[11px] font-bold text-[#CE8324]" dir="ltr">{t('host.cli.updateAvailable', { v: cli.latest })}</span>
              : cli?.latest && cli?.installed ? <span className="font-mono text-[11.5px] md:text-[10.5px] text-fgdim">{t('host.cli.upToDate')}</span> : null}
            {(cli?.updateAvailable || cli?.applying) && (
              <button type="button" disabled={cliBusy === 'update' || cli?.applying} onClick={cliUpdate} className={BTN}>{cliBusy === 'update' || cli?.applying ? t('host.cli.updating') : t('host.cli.updateNow')}</button>
            )}
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
        {st?.docker && (
          <Field label={t('host.upgrade')} hint={t('host.docker.upgradeHint')} wrap>
            <div className="flex flex-col items-end gap-1">
              <span className="text-[11px] text-fgdim">{t('host.docker.upgrade')}</span>
              <code dir="ltr" className="rounded-[6px] border border-hair bg-bg px-2 py-1 font-mono text-[11.5px] md:text-[10.5px] select-all">docker compose pull && docker compose up -d</code>
            </div>
          </Field>
        )}
      </Section>

      <Machines />
      <BackupField disabled={busy || phase === 'draining' || phase === 'exiting' || upgRunning} onRestarting={() => { restarting.current = true; }} reload={load} memory={memory} force={force} />
      <WhoAmI />

      <Advanced section={section} ids={advIds}>
        <Section id="cli-details" title={t('settings.host.cliDetails')}>
          <Field label={t('host.cli')} hint={t('host.cli.hint')} wrap>
            <div className="flex flex-col items-end gap-1.5">
              <span className="flex items-center gap-2 font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
                {cli?.checkError ? <span className="text-[#9c3b33]">{t('host.cli.checkError', { error: cli.checkError })}</span> : cli?.checkedAt ? t('host.cli.checkedAt', { when: relTime(cli.checkedAt) }) : cli ? t('host.cli.unknown') : ''}
                <button type="button" disabled={cliBusy === 'check' || cli?.checking} onClick={cliCheck} className="cursor-pointer underline disabled:opacity-50">{cliBusy === 'check' || cli?.checking ? t('host.checking') : t('host.check')}</button>
              </span>
              {cli?.deferred && <span className={warn}>{t('host.cli.deferred', { mb: cli.deferred.availableMb, min: cli.deferred.minFreeMb })}</span>}
              {cli?.lastUpdate && (
                <span className={`font-mono text-[11.5px] md:text-[10.5px] ${cli.lastUpdate.ok ? 'text-fgdim' : 'text-[#9c3b33]'}`} dir="ltr">
                  {cli.lastUpdate.ok
                    ? t('host.cli.lastOk', { from: cli.lastUpdate.from || '?', to: cli.lastUpdate.to || '?', when: relTime(cli.lastUpdate.at) })
                    : t('host.cli.lastFailed', { when: relTime(cli.lastUpdate.at), error: cli.lastUpdate.error || '?' })}
                </span>
              )}
              <label className="flex cursor-pointer items-center gap-2 font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
                {t('host.cli.auto')}
                <Toggle on={!!cli?.auto} disabled={!cli || cliBusy === 'auto'} onChange={cliAuto} />
              </label>
            </div>
          </Field>
        </Section>

        <Section id="manager" title={t('host.manager')}>
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
        </Section>

        {!st?.docker && (
          <Section id="upgrade-legacy" title={t('host.upgrade')}>
            <Field label={t('host.upgrade')} hint={`${t('host.upgrade.legacyHint')} ${st && !st.allowUpgrade ? t('host.upgradeDisabled') : t('host.upgrade.hint')}`} wrap>
              <div className="flex flex-col items-end gap-1.5">
                <span className="flex items-center gap-2">
                  <button type="button" disabled={disabled || blocked || !st?.allowUpgrade} onClick={() => upgrade('idle')} className={BTN}>{t('host.upgradeIdleBtn')}</button>
                  <button type="button" disabled={disabled || blocked || !st?.allowUpgrade} onClick={() => upgrade('now')} className={BTN}>{t('host.upgradeBtn')}</button>
                </span>
                {upgRunning && <span className={warn}>{t('host.upgradeRunning', { step: upg.step || '…' })}</span>}
              </div>
            </Field>
          </Section>
        )}

        {hasLog && (
          <Section id="upgrade-log" title={t('settings.host.upgradeLog')}>
            <pre dir="ltr" className="thin-scroll my-2 max-h-[220px] overflow-auto rounded-lg border border-hair bg-bg p-2 font-mono text-[11.5px] md:text-[10.5px] leading-snug text-fg">{(log.length ? log : upg.log).join('\n')}</pre>
          </Section>
        )}

        <BackupOptions memory={memory} setMemory={setMemory} force={force} setForce={setForce} disabled={busy} />
        <Budgets />
        <Health />
        <UsersAdvanced />
        <ScreenShare />
        <DangerZone />
      </Advanced>
    </>
  );
}
