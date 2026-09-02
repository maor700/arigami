// Settings › General › Advanced › automation (AUDIT2 — the Automation page
// folded into the General drawer): the Brain heartbeat (BrainView links to
// #/settings/automation/heartbeat, which resolves here) and the opt-in
// telemetry toggle. The payload preview, the anonymous id and the permanent
// "last send failed" line are gone from the UI — the endpoint does not
// resolve, so they were noise; the REST routes behind them still exist.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toast, toastError } from '../../lib/toast.js';
import { Section, Field, Toggle, BTN, INPUT } from './shared.jsx';
import { fmtDateTime } from '../../lib/time.js';

// Toggling creates/removes the backing CronTrigger server-side
// (server/brain.ts setHeartbeat) — this only reflects what GET /brain returns.
export function BrainHeartbeat({ first = false }) {
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
    <Section id="heartbeat" title={t('brain.heartbeatTitle')} first={first}>
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
    </Section>
  );
}

// D3 — the consent toggle only (D3 requires the choice to stay revocable).
// "What is sent" is documented in docs/TELEMETRY.md, linked from the hint.
export function TelemetryToggle() {
  const t = useT();
  const { auth } = useStore();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';
  useEffect(() => { api.get('/telemetry').then(setSt).catch(() => setSt(null)); }, []);
  const toggle = async (on) => {
    setBusy(true);
    try { setSt(await api.post('/telemetry', { enabled: on })); } catch (e) { toastError(e?.message || String(e)); } finally { setBusy(false); }
  };
  const pinned = st && (st.reason === 'dnt' || st.reason === 'env');
  return (
    <Section id="telemetry" title={t('telemetry.title')}>
      <Field
        label={t('telemetry.enable')}
        hint={
          <>
            {st?.reason === 'dnt' ? t('telemetry.dnt') : st?.reason === 'env' ? t('telemetry.env', { state: st.enabled ? 'on' : 'off' }) : t('telemetry.hint')}{' '}
            <a href="https://github.com/maor700/arigami/blob/master/docs/TELEMETRY.md" target="_blank" rel="noreferrer" className="underline hover:text-fg">{t('telemetry.docs')}</a>
          </>
        }
      >
        <Toggle on={!!st?.enabled} disabled={!st || busy || !admin || pinned} onChange={toggle} />
      </Field>
    </Section>
  );
}

export default function Automation() {
  return (
    <>
      <BrainHeartbeat first />
      <TelemetryToggle />
    </>
  );
}
