// Settings › Automation: the Brain heartbeat (single source — BrainView links
// here), opt-in telemetry with the exact payload preview, and a pointer to the
// cron/trigger launcher (cron itself stays in the Launcher).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toast, toastError } from '../../lib/toast.js';
import { Section, Field, Toggle, BTN, INPUT } from './shared.jsx';

// Toggling creates/removes the backing CronTrigger server-side
// (server/brain.ts setHeartbeat) — this only reflects what GET /brain returns.
function BrainHeartbeat() {
  const t = useT();
  const [status, setStatus] = useState(null);
  const [every, setEvery] = useState('30m');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/brain')
      .then((r) => { setStatus(r.heartbeat); setEvery(r.heartbeat.every); })
      .catch(() => setStatus({ enabled: false, every: '30m' }));
  }, []);
  const toggle = async (enabled) => {
    setBusy(true);
    try { setStatus(await api.put('/brain/heartbeat', { enabled, every })); } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <Section id="heartbeat" title={t('brain.heartbeatTitle')} first>
      <Field label={t('brain.heartbeatTitle')} hint={t('brain.heartbeatHint')}>
        <Toggle on={!!status?.enabled} onChange={toggle} disabled={busy || !status} />
      </Field>
      <Field label={t('brain.heartbeatEvery')} hint={t('brain.heartbeatEveryHint')}>
        <input
          type="text"
          value={every}
          disabled={busy || !status}
          onChange={(e) => setEvery(e.target.value)}
          onBlur={() => status?.enabled && every.trim() && every !== status.every && toggle(true)}
          placeholder="30m"
          className={`${INPUT} w-[100px] px-3 py-1.5 text-center text-[11.5px]`}
        />
      </Field>
      <Field label={t('settings.automation.cron')} hint={t('settings.automation.cron.hint')}>
        <a href="#/new/trigger" className={BTN}>{t('settings.automation.cron.open')}</a>
      </Field>
    </Section>
  );
}

// D3 — opt-in telemetry: toggle, "preview payload" (the exact JSON the host
// would POST next), and "reset anonymous ID" (= delete my data).
function Telemetry() {
  const t = useT();
  const { auth } = useStore();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';
  useEffect(() => { api.get('/telemetry').then(setSt).catch(() => setSt(null)); }, []);
  const run = async (fn) => {
    setBusy(true);
    try { setSt(await fn()); } catch (e) { toastError(e?.message || String(e)); } finally { setBusy(false); }
  };
  const toggle = (on) => run(() => api.post('/telemetry', { enabled: on }));
  const rotate = async () => {
    if (!(await confirmDialog({ title: t('telemetry.rotate.confirmTitle'), body: t('telemetry.rotate.confirmBody'), confirmLabel: t('telemetry.rotate') }))) return;
    run(async () => { const r = await api.post('/telemetry/rotate', {}); toast(t('telemetry.rotated')); return r; });
  };
  const pinned = st && (st.reason === 'dnt' || st.reason === 'env');
  return (
    <Section id="telemetry" title={t('telemetry.title')}>
      <Field
        label={t('telemetry.enable')}
        hint={st?.reason === 'dnt' ? t('telemetry.dnt') : st?.reason === 'env' ? t('telemetry.env', { state: st.enabled ? 'on' : 'off' }) : t('telemetry.hint')}
      >
        <Toggle on={!!st?.enabled} disabled={!st || busy || !admin || pinned} onChange={toggle} />
      </Field>
      <Field label={t('telemetry.preview')} hint={st?.lastSentAt ? t('telemetry.lastSent', { when: new Date(st.lastSentAt).toLocaleString(), n: st.pending }) : t('telemetry.neverSent', { n: st?.pending ?? 0 })}>
        <button type="button" className={BTN} disabled={!st} onClick={() => setShow((v) => !v)}>{show ? t('telemetry.hidePreview') : t('telemetry.showPreview')}</button>
      </Field>
      {show && st?.preview && (
        <pre dir="ltr" className="my-2 max-h-[260px] overflow-auto rounded-[8px] border border-hair bg-bg p-3 font-mono text-[10.5px] leading-snug text-fg">{JSON.stringify(st.preview, null, 2)}</pre>
      )}
      <Field label={t('telemetry.id')} hint={t('telemetry.id.hint')}>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-fgdim" dir="ltr">{st?.id ? st.id.slice(0, 8) + '…' : '…'}</span>
          <button type="button" className={BTN} disabled={!st || busy || !admin} onClick={rotate}>{t('telemetry.rotate')}</button>
        </span>
      </Field>
      {st?.lastError && <div className="py-1 font-mono text-[10.5px] text-fgdim">{t('telemetry.lastError', { error: st.lastError })}</div>}
    </Section>
  );
}

export default function Automation() {
  return (
    <>
      <BrainHeartbeat />
      <Telemetry />
    </>
  );
}
