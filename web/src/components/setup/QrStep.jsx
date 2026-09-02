// S2 — manual.kind 'qr' (WhatsApp): start the bridge, show the QR the server
// returns (a data: URL or host-relative image), poll until linked. The QR is
// scanned from the phone's WhatsApp, so this step is often viewed on a
// laptop while the phone does the scanning — or on a second phone.
import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import * as setupApi from '../../lib/setup-api.js';
import { BTN2, ErrorBox, OkLine, Spinner, useAction } from './shared.jsx';

const POLL_MS = 3000;

export default function QrStep({ capability = 'whatsapp', onDone, initial = null }) {
  const t = useT();
  const [st, setSt] = useState(initial); // {status:'disconnected'|'starting'|'qr'|'connected', qr?, qrUrl?, user?}
  const { busy, err, run, setErr } = useAction();

  // Poll while the bridge is starting / waiting for a scan.
  const stateNow = typeof st?.status === 'string' ? st.status : st?.status?.data?.status;
  const active = stateNow === 'qr' || stateNow === 'starting';
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await setupApi.connect(capability, { action: 'poll' });
        if (cancelled) return;
        setSt(r);
        const rs = typeof r?.status === 'string' ? r.status : r?.status?.data?.status;
        if (rs === 'connected') onDone?.(r);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [active, capability, onDone, setErr]);

  const connect = () => run(async () => setSt(await setupApi.connect(capability, { action: 'connect' })));
  const qr = st?.qr || st?.qrUrl || st?.status?.data?.qr;
  // The setup endpoint answers {ok, status:<capability status object>, qr, qrUrl, user}
  // while the bare bridge answers {status:'qr'|…}. Read the bridge state from
  // whichever shape arrived — otherwise a live QR never reaches the <img>.
  const state = typeof st?.status === 'string' ? st.status : st?.status?.data?.status;
  const user = st?.user ?? st?.status?.data?.user;

  if (state === 'connected') return <OkLine>{t('setup.qr.connected', { user: user || '…' })}</OkLine>;
  return (
    <div className="flex flex-col items-start gap-2">
      {state === 'qr' && qr ? (
        <>
          <img src={qr} alt="WhatsApp QR" className="h-[200px] w-[200px] rounded-[8px] border border-hair bg-white" />
          <div className="text-[11px] text-fgdim">{t('setup.qr.scanHint')}</div>
        </>
      ) : active ? (
        <Spinner>{t('setup.qr.starting')}</Spinner>
      ) : (
        <button type="button" className={BTN2} disabled={busy} onClick={connect}>{t('setup.qr.connect')}</button>
      )}
      <ErrorBox err={err} />
    </div>
  );
}
