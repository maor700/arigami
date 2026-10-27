// VAULT1 — the sign-in card (request_credentials; server/lib/credentials.ts). The session carries the request
// (origin, which fields — never a value); the card renders from it and talks to the vault worker, which holds the
// unlocked database and posts the values to the host's fill route itself. Nothing typed here goes into the chat,
// the agent, or a log: the agent only hears "[host] … filled".
//   vault unlocked, an entry for the site → "Sign in as <user>" (one tap)
//   otherwise                             → the detected fields, Fill, ☑ Save for next time
//   always                                → I'll type it myself (→ request_screen) · Cancel · ☐ Remember for the site
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useVault, matchVault, unlockVault, createVault, fillFromVault, vaultSupported } from '../lib/vault.js';
import { defineHostComponent, loose, str, any, z } from '../openui/define.js';
import { CardFrame, Btn, Prose } from '../openui/primitives.jsx';
import { INPUT } from './settings/shared.jsx';

// Secret inputs are text inputs drawn as dots: a real type="password" makes the cockpit's own browser offer to save
// what was typed into ITS password manager — outside the vault, the opposite of the point.
export const SECRET = { type: 'text', autoComplete: 'off', spellCheck: false, 'data-1p-ignore': '', 'data-lpignore': 'true', style: { WebkitTextSecurity: 'disc' } };

const errText = (e) => String(e?.body?.error || e?.message || e).replace(/^HTTP \d+ — /, '');

function Check({ checked, onChange, children, ...rest }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--term-accent-fg)] select-none coarse:min-h-11" {...rest}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--accent)]" />
      {children}
    </label>
  );
}

function CredentialCardView({ props: { sessionId, request } }) {
  const t = useT();
  const vault = useVault();
  const [matches, setMatches] = useState([]);
  const [typing, setTyping] = useState(false); // "use other details" over a saved entry
  const [values, setValues] = useState({});
  const [save, setSave] = useState(true);
  const [remember, setRemember] = useState(false);
  const [master, setMaster] = useState('');
  const [master2, setMaster2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const supported = vaultSupported();
  const fields = request.fields || [];
  const saveable = fields.includes('password');

  useEffect(() => {
    let alive = true;
    if (vault.unlocked) matchVault(request.origin).then((m) => alive && setMatches(m)).catch(() => {});
    else setMatches([]);
    return () => { alive = false; };
  }, [vault.unlocked, vault.count, request.origin]);

  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const shared = request.target === 'shared';
  const base = { sessionId, requestId: request.requestId, origin: request.origin, fields, remember, exact: shared };

  const signInAs = (m) => run(() => fillFromVault({ ...base, entryId: m.id }));
  const fillTyped = () => run(async () => {
    const keep = save && saveable && supported;
    if (keep && !vault.exists) {
      if (master.length < 8) throw new Error(t('vault.masterShort'));
      if (master !== master2) throw new Error(t('vault.masterMismatch'));
      await createVault({ password: master });
    } else if (keep && !vault.unlocked) {
      await unlockVault({ password: master });
    }
    await fillFromVault({ ...base, values, save: keep });
  });
  const unlock = () => run(async () => { await unlockVault({ password: master }); setMaster(''); setBusy(false); });
  const answer = (choice) => run(() => api.post(`/sessions/${encodeURIComponent(sessionId)}/credentials/answer`, { requestId: request.requestId, choice, remember: choice === 'manual' && remember }));

  const showSaved = vault.unlocked && matches.length > 0 && !typing;
  // a locked vault: the unlock row on top (it opens saved sign-ins, and saving typed ones); a new vault: its password under Save
  const needsMaster = save && saveable && supported && !vault.exists;
  const onEnter = (fn) => (e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); fn(); } };
  const label = (r) => t(`vault.field.${r}`);

  return (
    <CardFrame tone="accent" live data-credential-request={request.requestId} label={t('vault.card.title', { host: request.host })}>
      {request.reason && <Prose className="mt-2">{request.reason}</Prose>}
      {shared && <Prose dim className="mt-1" data-cred-shared>{t('vault.card.shared', { account: request.account || 'Chrome' })}</Prose>}
      <Prose dim className="mt-1">{t('vault.card.private')}</Prose>

      {showSaved ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {matches.map((m) => (
            <Btn key={m.id} variant="primary" disabled={busy} data-sign-in-as={m.username} onClick={() => signInAs(m)}>
              {t('vault.card.signInAs', { user: m.username || m.title })}{!m.exact && <span className="opacity-70"> · {new URL(m.origin).hostname}</span>}
            </Btn>
          ))}
          <Btn variant="quiet" disabled={busy} onClick={() => setTyping(true)}>{t('vault.card.other')}</Btn>
        </div>
      ) : (
        <>
          {vault.exists && !vault.unlocked && supported && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <input {...SECRET} value={master} onChange={(e) => setMaster(e.target.value)} onKeyDown={onEnter(unlock)} placeholder={t('vault.master')} aria-label={t('vault.master')} className={`${INPUT} w-[220px]`} />
              <Btn variant="secondary" disabled={busy || !master} onClick={unlock}>{t('vault.unlock')}</Btn>
              <span className="text-xs text-[var(--term-accent-dim)]">{t('vault.masterHintUnlock')}</span>
            </div>
          )}
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            {fields.map((r) => (
              <input
                key={r}
                data-cred-field={r}
                {...(r === 'password' ? SECRET : { type: 'text', autoComplete: 'off' })}
                inputMode={r === 'otp' ? 'numeric' : undefined}
                spellCheck={false}
                dir="ltr"
                value={values[r] || ''}
                onChange={(e) => setValues((v) => ({ ...v, [r]: e.target.value }))}
                onKeyDown={onEnter(fillTyped)}
                placeholder={label(r)}
                aria-label={label(r)}
                className={INPUT}
              />
            ))}
          </div>
          {saveable && supported && (
            <div className="mt-2 space-y-2">
              <Check checked={save} onChange={setSave} data-cred-save>{t('vault.card.save')}</Check>
              {needsMaster && (
                <div className="flex flex-wrap items-center gap-2">
                  <input {...SECRET} value={master} onChange={(e) => setMaster(e.target.value)} placeholder={t('vault.masterNew')} aria-label={t('vault.masterNew')} className={`${INPUT} w-[220px]`} />
                  <input {...SECRET} value={master2} onChange={(e) => setMaster2(e.target.value)} onKeyDown={onEnter(fillTyped)} placeholder={t('vault.masterAgain')} aria-label={t('vault.masterAgain')} className={`${INPUT} w-[220px]`} />
                  <span className="text-xs text-[var(--term-accent-dim)]">{t('vault.masterHintNew')}</span>
                </div>
              )}
            </div>
          )}
          {saveable && !supported && <Prose dim className="mt-2">{t('vault.unsupported')}</Prose>}
        </>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        <Check checked={remember} onChange={setRemember}>{t('vault.card.remember', { host: request.host })}</Check>
        <span className="flex-1" />
        <Btn variant="quiet" disabled={busy} onClick={() => answer('cancel')}>{t('vault.card.cancel')}</Btn>
        <Btn variant="secondary" disabled={busy} data-cred-manual onClick={() => answer('manual')}>{t('vault.card.manual')}</Btn>
        {!showSaved && (
          <Btn variant="primary" data-cred-fill disabled={busy || !fields.some((r) => values[r])} onClick={fillTyped}>
            {save && saveable && supported ? t('vault.card.fillSave') : t('vault.card.fill')}
          </Btn>
        )}
      </div>
      {err && <div data-cred-error dir="auto" className="mt-1.5 text-end text-xs font-medium text-destructive">{err}</div>}
    </CardFrame>
  );
}

export const CredentialCardDef = defineHostComponent({
  name: 'CredentialCard',
  description: 'Host: request_credentials — fill a sign-in from the owner\'s vault, or hand it to take-over',
  props: loose({
    sessionId: z.string(),
    request: loose({ requestId: str, origin: str, host: str, fields: any, reason: any, pref: any, target: any, account: any }),
  }),
  component: CredentialCardView,
});

export default function CredentialCard({ sessionId, request }) {
  return <CredentialCardView props={{ sessionId, request }} />;
}
