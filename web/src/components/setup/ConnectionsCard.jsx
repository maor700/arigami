// S2 — Settings → Connections: the Google identity (email / provider /
// connectedAt, Disconnect), every capability with its status and a
// "connect" button (opens a SetupCard-like dialog: mode switch + the
// manual.kind component; AUTO spawns a session that calls request_setup),
// and the last 10 lines of $ARIGAMI_DIR/connections.log. Reads
// GET /setup/capabilities through lib/setup-api.js (legacy fallback on
// hosts without S1).
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { useStore } from '../../lib/store.js';
import { toast, toastError } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import * as setupApi from '../../lib/setup-api.js';
import { stepFor } from './index.js';
import { capTitle, capFamily, consentKeys } from './registry.js';
import { Pill, BTN_SM, BTN2_SM } from './shared.jsx';
import { faXmark, faWandMagicSparkles, faHand, faRotateRight, faLinkSlash } from '@fortawesome/free-solid-svg-icons';

function fmtWhen(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); } catch { return String(iso); }
}

// Dialog used by the "connect" buttons — the same decision the chat card
// offers, outside a session.
export function ConnectDialog({ cap, identity, onClose, onChanged }) {
  const t = useT();
  const autoAllowed = !!cap.autoCapable && !!identity;
  const [mode, setMode] = useState(autoAllowed ? 'auto' : 'manual');
  const [busy, setBusy] = useState(false);
  const Step = stepFor(cap.manual?.kind);
  const title = capTitle(t, cap.id);
  const auto = async () => {
    setBusy(true);
    try {
      await setupApi.connectViaSession(cap.id);
      toast(t('setup.connections.autoStarted', { name: title }));
      onClose();
    } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  const seg = (v, icon, label) => (
    <button type="button" role="radio" aria-checked={mode === v} disabled={v === 'auto' && !autoAllowed} onClick={() => setMode(v)}
      className={`flex-1 cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-bold disabled:cursor-default disabled:opacity-40 ${mode === v ? 'bg-brand text-[#1a1a1a]' : 'text-fg'}`}>
      <Icon icon={icon} /> {label}
    </button>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-[520px] rounded-[12px] border-[1.5px] border-ink bg-panel p-4 text-fg shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-bold">{t('setup.connections.connectTitle', { name: title })}</span>
          <button type="button" onClick={onClose} className="ms-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg" aria-label={t('setup.cancel')}><Icon icon={faXmark} /></button>
        </div>
        {cap.autoCapable && (
          <div className="mt-3">
            <div role="radiogroup" className="flex gap-1 rounded-[8px] border border-border p-0.5">
              {seg('auto', faWandMagicSparkles, t('setup.mode.auto'))}
              {seg('manual', faHand, t('setup.mode.manual'))}
            </div>
            {!autoAllowed && <div className="mt-1 text-[10.5px] text-fgdim">{identity ? t('setup.mode.autoUnavailable') : t('setup.mode.needsIdentity')}</div>}
          </div>
        )}
        <div className="mt-3">
          {mode === 'auto' && autoAllowed ? (
            <>
              <ul className="list-disc ps-5 text-[11.5px] leading-relaxed text-fgdim">
                {consentKeys(cap.id).map((k) => <li key={k}>{t(k, { name: title })}</li>)}
                <li>{t('setup.consent.noPasswords')}</li>
                <li>{t('setup.consent.evidence')}</li>
              </ul>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className={BTN2_SM} onClick={onClose}>{t('setup.cancel')}</button>
                <button type="button" className={BTN_SM} disabled={busy} onClick={auto}><Icon icon={faWandMagicSparkles} /> {t('setup.connectAuto')}</button>
              </div>
            </>
          ) : (
            <Step capability={cap.id} manual={cap.manual || {}} enabled={!!cap.ok} detail={cap.detail} have={cap.data?.repos || []} onDone={() => { onChanged?.(); onClose(); }} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function ConnectionsCard() {
  const t = useT();
  const { setupTick } = useStore();
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [dialog, setDialog] = useState(null); // capability object
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setupApi.overview().then((r) => { setOv(r); setErr(null); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load, setupTick]);

  const disconnect = async (id) => {
    const name = capFamily(id) === 'identity' ? t('setup.connections.identity') : capTitle(t, id);
    const ok = await confirmDialog({ title: t('setup.connections.disconnectConfirm', { name }), body: '', confirmLabel: t('setup.connections.disconnect'), danger: true });
    if (!ok) return;
    setBusy(true);
    try { await setupApi.disconnect(id); load(); } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };

  const identity = ov?.identity || null;
  const caps = (ov?.capabilities || []).filter((c) => capFamily(c.id) !== 'identity');
  const audit = (ov?.audit || []).slice(-10).reverse();
  const row = 'flex items-center gap-2 border-b border-hair py-1.5 text-[11.5px] last:border-b-0';

  return (
    <>
      <h3 className="mt-3 flex items-center border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('setup.connections.title')}
        <button type="button" onClick={load} className="ms-auto cursor-pointer text-[10.5px] font-normal normal-case text-fgdim hover:text-fg"><Icon icon={faRotateRight} /> {t('setup.connections.refresh')}</button>
      </h3>
      {err && <div className="text-[11.5px] text-[#9c3b33]">{err}</div>}
      {!ov && !err && <div className="text-[11.5px] text-fgdim">{t('setup.loading')}</div>}
      {ov && (
        <>
          <div className="mt-2 rounded-lg border border-hair px-3 py-1">
            <div className={row}>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-bold">{t('setup.connections.identity')}</span>
                {identity ? (
                  <span className="ms-2 font-mono text-[10px] text-fgdim">{identity.email} · {identity.provider || 'google'} · {fmtWhen(identity.connectedAt)}</span>
                ) : (
                  <span className="ms-2 text-[10.5px] text-fgdim">{t('setup.connections.noIdentity')}</span>
                )}
              </span>
              {identity ? (
                <button type="button" disabled={busy} onClick={() => disconnect('identity')} className="cursor-pointer text-[10px] text-fgdim hover:text-[#9c3b33]"><Icon icon={faLinkSlash} /> {t('setup.connections.disconnect')}</button>
              ) : (
                <button type="button" className={BTN2_SM} onClick={() => setDialog({ id: 'identity', manual: { kind: 'takeover' }, autoCapable: false })}>{t('setup.connections.connect')}</button>
              )}
            </div>
          </div>
          <div className="mt-2 rounded-lg border border-hair px-3 py-1">
            {caps.map((c) => (
              <div key={c.id} className={row}>
                <Pill status={c.ok ? 'ok' : 'todo'} label={c.ok ? t('setup.connections.on') : t('setup.connections.off')} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-bold">{capTitle(t, c.id)}</span>
                  {(c.detail || c.connectedAt) && <span dir="ltr" className="ms-2 font-mono text-[10px] text-fgdim">{c.detail}{c.connectedAt ? ` · ${fmtWhen(c.connectedAt)}` : ''}</span>}
                </span>
                {c.ok && capFamily(c.id) !== 'repo' && (
                  <button type="button" disabled={busy} onClick={() => disconnect(c.id)} className="cursor-pointer text-[10px] text-fgdim hover:text-[#9c3b33]">{t('setup.connections.disconnect')}</button>
                )}
                <button type="button" className={c.ok ? BTN2_SM : BTN_SM} onClick={() => setDialog(c)}>{c.ok ? t('setup.connections.reconnect') : t('setup.connections.connect')}</button>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10.5px] font-bold uppercase tracking-wide text-fgdim">{t('setup.connections.audit')}</div>
          {audit.length === 0 ? (
            <div className="text-[11px] text-fgdim">{t('setup.connections.noAudit')}</div>
          ) : (
            <div dir="ltr" className="mt-1 max-h-[180px] overflow-auto rounded-lg border border-hair px-3 py-1 font-mono text-[10px] text-fgdim">
              {audit.map((a, i) => (
                <div key={i} className="flex flex-wrap gap-x-2 border-b border-hair py-1 last:border-b-0">
                  <span>{fmtWhen(a.at)}</span>
                  <span className="font-bold text-fg">{a.capability}</span>
                  <span>{a.mode}</span>
                  <span className={a.result === 'ok' || a.result === 'done' ? 'text-[#2f7d4f]' : a.result === 'failed' ? 'text-[#9c3b33]' : ''}>{a.result}</span>
                  {a.human ? <span>human</span> : null}
                  {a.evidence && <a href={a.evidence} target="_blank" rel="noopener noreferrer" className="underline">{t('setup.auto.evidence')}</a>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {dialog && <ConnectDialog cap={dialog} identity={identity} onClose={() => setDialog(null)} onChanged={load} />}
    </>
  );
}
