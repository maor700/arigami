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
import ConnectStep from '../setup/ConnectStep.jsx';
import { BTN_SM, BTN2_SM } from '../setup/shared.jsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.jsx';
import { faWandMagicSparkles, faHand } from '@fortawesome/free-solid-svg-icons';

export default function ConnectDialog({ cap, identity, owner = 'global', onClose, onChanged }) {
  const ownerAgent = owner && owner.startsWith('agent:') ? owner.slice(6) : null; // A2: connect FOR an agent
  const t = useT();
  const autoAllowed = !!cap.autoCapable && !!identity;
  const [mode, setMode] = useState(autoAllowed ? 'auto' : 'manual');
  const [busy, setBusy] = useState(false);
  const Step = stepFor(cap.manual?.kind);
  // A remote service (mcp:*) has one way in: the ConnectStep (host tries first).
  const isService = String(cap.id || '').startsWith('mcp:') && cap.manual?.kind === 'oauth';
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
      className={`flex-1 cursor-pointer rounded-sm px-2.5 py-1 text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 coarse:min-h-10 ${mode === v ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--hb-hair)]' : 'text-muted-foreground hover:text-foreground'}`}>
      <Icon icon={icon} /> {label}
    </button>
  );
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[520px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('setup.connections.connectTitle', { name: title })}</DialogTitle>
        </DialogHeader>
        {isService && (
          <div className="mt-3">
            <ConnectStep capability={cap.id} owner={ownerAgent ? owner : undefined} title={title} onDone={() => { onChanged?.(); onClose(); }} onCancel={onClose} />
          </div>
        )}
        {!isService && cap.autoCapable && (
          <div className="mt-3">
            <div role="radiogroup" className="flex gap-0.5 rounded-md bg-muted p-0.5">
              {seg('auto', faWandMagicSparkles, t('setup.mode.auto'))}
              {seg('manual', faHand, t('setup.mode.manual'))}
            </div>
            {!autoAllowed && <div className="mt-1 text-xs text-fgdim">{identity ? t('setup.mode.autoUnavailable') : t('setup.mode.needsIdentity')}</div>}
          </div>
        )}
        {!isService && <div className="mt-3">
          {mode === 'auto' && autoAllowed ? (
            <>
              <ul className="list-disc ps-5 text-xs leading-relaxed text-fgdim">
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
        </div>}
      </DialogContent>
    </Dialog>
  );
}
