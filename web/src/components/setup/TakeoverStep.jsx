// S2 — manual.kind 'takeover' (identity): the human signs in to Google
// inside the session's own Chrome. The agent never types a password
// (automation rule 1), so this step only (a) opens the existing ScreenModal
// — the same interactive viewer "Take over" uses — and (b) once the human
// says they're done, asks the server to verify + write identity.json
// (POST /setup/identity {email?}). With a live `screen-request` on the
// card's session, Done/Cancel live in the modal; without one we show our
// own "I'm signed in" button.
import { useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { useStore, setScreenModal, openScreenTakeover, openScreenRequest } from '../../lib/store.js';
import * as setupApi from '../../lib/setup-api.js';
import { BTN, BTN2, INPUT, ErrorBox, OkLine, useAction } from './shared.jsx';
import { faDisplay } from '@fortawesome/free-solid-svg-icons';

export default function TakeoverStep({ capability = 'identity', sessionId, requestId, onDone }) {
  const t = useT();
  const s = useStore();
  const [email, setEmail] = useState('');
  const [result, setResult] = useState(null);
  const { busy, err, run } = useAction();
  const req = sessionId ? openScreenRequest(s, sessionId) : null;

  // F6: with a live screen-request the modal's Done answers it and the host
  // resolves this card itself (identity probe); without one the modal gets a
  // setup context whose Done runs the same verify — "Not now" on the card is
  // the only way to skip.
  const open = () => {
    if (req) openScreenTakeover(sessionId, req.requestId);
    else setScreenModal(sessionId ? { sessionId, setupId: requestId || null, capability } : true);
  };
  const verify = () =>
    run(async () => {
      const r = await setupApi.connect(capability, { action: 'verify', ...(sessionId ? { sessionId } : {}), ...(email.trim() ? { email: email.trim() } : {}) });
      if (r && r.ok === false) throw new Error(r.error || r.detail || t('setup.takeover.notSignedIn'));
      setResult(r);
      onDone?.(r);
    });

  if (result) return <OkLine>{t('setup.takeover.done', { email: result.email || email || '' })}</OkLine>;
  return (
    <div className="flex flex-col gap-2">
      <ol className="list-decimal ps-5 text-[12px] leading-relaxed text-fgdim">
        <li>{t('setup.takeover.step1')}</li>
        <li>{t('setup.takeover.step2')}</li>
        <li>{t('setup.takeover.step3')}</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} onClick={open}><Icon icon={faDisplay} /> {t('setup.takeover.open')}</button>
      </div>
      <input className={INPUT} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('setup.takeover.emailPlaceholder')} spellCheck={false} autoComplete="off" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN2} disabled={busy} onClick={verify}>{busy ? t('setup.takeover.verifying') : t('setup.takeover.verify')}</button>
      </div>
      <ErrorBox err={err} />
    </div>
  );
}
