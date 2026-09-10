// SET — the connect dialog the Connections category opens for any capability
// (moved from setup/ConnectionsCard.jsx). Same decision the chat SetupCard
// offers, outside a session: AUTO spawns a session that calls request_setup
// (needs a Google identity), MANUAL renders the manual.kind step component.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { toast, toastError } from '../../lib/toast.js';
import * as setupApi from '../../lib/setup-api.js';
import { stepFor } from '../setup/index.js';
import { capTitle, consentKeys } from '../setup/registry.js';
import { BTN_SM, BTN2_SM } from '../setup/shared.jsx';
import { faXmark, faWandMagicSparkles, faHand } from '@fortawesome/free-solid-svg-icons';

export default function ConnectDialog({ cap, identity, owner = 'global', onClose, onChanged }) {
  const ownerAgent = owner && owner.startsWith('agent:') ? owner.slice(6) : null; // A2: connect FOR an agent
  const t = useT();
  const autoAllowed = !!cap.autoCapable && !!identity;
  const [mode, setMode] = useState(autoAllowed ? 'auto' : 'manual');
  const [busy, setBusy] = useState(false);
  const Step = stepFor(cap.manual?.kind);
  const title = cap.title || capTitle(t, cap.id);
  const auto = async () => {
    setBusy(true);
    try {
      await setupApi.connectViaSession(cap.id, { agent: ownerAgent });
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
            {!autoAllowed && <div className="mt-1 text-[11.5px] md:text-[10.5px] text-fgdim">{identity ? t('setup.mode.autoUnavailable') : t('setup.mode.needsIdentity')}</div>}
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
            <Step capability={cap.id} manual={cap.manual || {}} enabled={!!cap.ok} detail={cap.detail} have={cap.data?.repos || []} owner={ownerAgent ? owner : undefined} onDone={() => { onChanged?.(); onClose(); }} />
          )}
        </div>
      </div>
    </div>
  );
}
