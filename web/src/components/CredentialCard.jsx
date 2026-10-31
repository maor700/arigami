// VAULT1 — the sign-in card (request_credentials; server/lib/credentials.ts). The session carries the request
// (origin, which fields — never a value); the card renders from it and talks to the vault worker, which holds the
// unlocked database and posts the values to the host's fill route itself. Nothing typed here goes into the chat,
// the agent, or a log: the agent only hears "[host] … filled".
//   vault unlocked, an entry for the site → "Sign in as <user>" (one tap)
//   otherwise                             → the detected fields, Fill, ☑ Save for next time
//   always                                → I'll type it myself (→ request_screen) · Cancel · ☐ Remember for the site
// VAULT2 — two more kinds of the same card (request.kind):
//   'form'  → vault_collect: a secure form of named fields; Save puts them in the vault (the worker encrypts, uploads)
//             and tells the host only the names. Nothing goes to any page.
//   'field' → vault_fill: ONE named field of the page — "Fill <field> from <entry>" (one tap), or type it once and keep it.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useVault, matchVault, unlockVault, createVault, fillFromVault, vaultSupported, matchVaultField, fillVaultField, saveVaultFields } from '../lib/vault.js';
import { inputPropsFor } from '../lib/vault-schema.js';
import { defineHostComponent, loose, str, any, z } from '../openui/define.js';
import { CardFrame, Btn, Prose } from '../openui/primitives.jsx';
import { INPUT } from './settings/shared.jsx';

// Secret inputs are text inputs drawn as dots: a real type="password" makes the cockpit's own browser offer to save
// what was typed into ITS password manager — outside the vault, the opposite of the point.
export const SECRET = { type: 'text', autoComplete: 'off', spellCheck: false, 'data-1p-ignore': '', 'data-lpignore': 'true', style: { WebkitTextSecurity: 'disc' } };
const PLAIN = { type: 'text', autoComplete: 'off', spellCheck: false, 'data-1p-ignore': '', 'data-lpignore': 'true' };

/** Input attributes for a named field's type — dots for anything private, always a text input (see SECRET above). */
export function fieldInputProps(type) {
  const p = inputPropsFor(type);
  return { ...(p.secret ? SECRET : PLAIN), ...(p.inputMode ? { inputMode: p.inputMode } : {}) };
}

const errText = (e) => String(e?.body?.error || e?.message || e).replace(/^HTTP \d+ — /, '');

function Check({ checked, onChange, children, ...rest }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--term-accent-fg)] select-none coarse:min-h-11" {...rest}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--accent)]" />
      {children}
    </label>
  );
}

/** The vault's master password row: unlock an existing vault, or choose a password for a new one. */
function MasterRow({ vault, master, setMaster, master2, setMaster2, onEnter, busy, onUnlock, create }) {
  const t = useT();
  if (vault.exists && !vault.unlocked) {
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <input {...SECRET} value={master} onChange={(e) => setMaster(e.target.value)} onKeyDown={onEnter(onUnlock)} placeholder={t('vault.master')} aria-label={t('vault.master')} className={`${INPUT} w-[220px]`} />
        <Btn variant="secondary" disabled={busy || !master} onClick={onUnlock}>{t('vault.unlock')}</Btn>
        <span className="text-xs text-[var(--term-accent-dim)]">{t('vault.masterHintUnlock')}</span>
      </div>
    );
  }
  if (!vault.exists && create) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input {...SECRET} value={master} onChange={(e) => setMaster(e.target.value)} placeholder={t('vault.masterNew')} aria-label={t('vault.masterNew')} className={`${INPUT} w-[220px]`} />
        <input {...SECRET} value={master2} onChange={(e) => setMaster2(e.target.value)} onKeyDown={onEnter(create)} placeholder={t('vault.masterAgain')} aria-label={t('vault.masterAgain')} className={`${INPUT} w-[220px]`} />
        <span className="text-xs text-[var(--term-accent-dim)]">{t('vault.masterHintNew')}</span>
      </div>
    );
  }
  return null;
}

/** Open the vault for a save: unlock it with the master, or create it (8+ chars, typed twice). */
async function openVault(t, vault, master, master2) {
  if (!vault.exists) {
    if (master.length < 8) throw new Error(t('vault.masterShort'));
    if (master !== master2) throw new Error(t('vault.masterMismatch'));
    await createVault({ password: master });
  } else if (!vault.unlocked) {
    await unlockVault({ password: master });
  }
}

// ---- VAULT2: the secure form (vault_collect) -------------------------------------------------------------------------
function FormCardView({ sessionId, request }) {
  const t = useT();
  const vault = useVault();
  const spec = request.spec || request.fields.map((name) => ({ name, type: 'secret' }));
  const [values, setValues] = useState({});
  const [title, setTitle] = useState(request.entry || request.host);
  const [master, setMaster] = useState('');
  const [master2, setMaster2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const supported = vaultSupported();
  const missing = spec.filter((f) => f.required !== false && !values[f.name]);
  const onEnter = (fn) => (e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); fn(); } };
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  const unlock = () => run(async () => { await unlockVault({ password: master }); setMaster(''); setBusy(false); });
  const saveAll = () => run(async () => {
    if (!supported) throw new Error(t('vault.unsupported'));
    if (missing.length) throw new Error(t('vault.form.missing', { fields: missing.map((f) => f.label || f.name).join(', ') }));
    await openVault(t, vault, master, master2);
    const fields = spec.filter((f) => values[f.name]).map((f) => ({ name: f.name, type: f.type, value: values[f.name] }));
    // the entry of this site with this title, if there is one, is updated — else a new account
    const existing = (await matchVault(request.origin)).find((m) => m.exact && m.title.toLowerCase() === title.trim().toLowerCase());
    const entry = await saveVaultFields({ id: existing?.id, origin: request.origin, title: title.trim() || request.host, fields });
    setValues({});
    await api.post(`/sessions/${encodeURIComponent(sessionId)}/credentials/answer`, { requestId: request.requestId, choice: 'saved', entry: { id: entry.id, title: entry.title, fields: entry.fields.map((f) => f.name) } });
  });
  const cancel = () => run(() => api.post(`/sessions/${encodeURIComponent(sessionId)}/credentials/answer`, { requestId: request.requestId, choice: 'cancel' }));
  // the agent's label is shown WITH the stored name when they differ, so a label cannot dress one field up as another
  const stored = (f) => (/^(username|password|otp)$/.test(f.name) ? t(`vault.field.${f.name}`) : f.name);
  const label = (f) => (f.label && f.label.trim().toLowerCase() !== f.name.toLowerCase() ? `${f.label} · ${f.name}` : stored(f));

  return (
    <CardFrame tone="accent" live data-credential-request={request.requestId} data-cred-kind="form" label={t('vault.form.title', { host: request.host })}>
      {request.reason && <Prose className="mt-2">{request.reason}</Prose>}
      <Prose dim className="mt-1">{t('vault.form.private')}</Prose>
      <MasterRow vault={vault} master={master} setMaster={setMaster} master2={master2} setMaster2={setMaster2} onEnter={onEnter} busy={busy} onUnlock={unlock} create={saveAll} />
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--term-accent-dim)]">
          {t('vault.form.entry')}
          <input {...PLAIN} data-cred-title value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} aria-label={t('vault.form.entry')} />
        </label>
        {spec.map((f) => (
          <label key={f.name} className="flex flex-col gap-1 text-xs text-[var(--term-accent-dim)]">
            <span>{label(f)}{f.required === false ? '' : ' *'}<span className="opacity-60"> · {t(`vault.type.${f.type}`)}</span></span>
            {inputPropsFor(f.type).multiline ? (
              <textarea
                data-cred-field={f.name}
                autoComplete="off"
                spellCheck={false}
                dir="auto"
                rows={3}
                value={values[f.name] || ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                aria-label={label(f)}
                className={`${INPUT} h-auto py-1.5`}
              />
            ) : (
              <input
                data-cred-field={f.name}
                {...fieldInputProps(f.type)}
                dir="ltr"
                value={values[f.name] || ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                onKeyDown={onEnter(saveAll)}
                placeholder={inputPropsFor(f.type).placeholderHint || ''}
                aria-label={label(f)}
                className={INPUT}
              />
            )}
          </label>
        ))}
      </div>
      {!supported && <Prose dim className="mt-2">{t('vault.unsupported')}</Prose>}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        <Btn variant="quiet" disabled={busy} onClick={cancel}>{t('vault.card.cancel')}</Btn>
        <Btn variant="primary" data-cred-save-form disabled={busy || !supported || missing.length > 0} onClick={saveAll}>{t('vault.form.save')}</Btn>
      </div>
      {err && <div data-cred-error dir="auto" className="mt-1.5 text-end text-xs font-medium text-destructive">{err}</div>}
    </CardFrame>
  );
}

// ---- VAULT2: one named field of the page (vault_fill) -----------------------------------------------------------------
function FieldCardView({ sessionId, request }) {
  const t = useT();
  const vault = useVault();
  const field = request.fields[0];
  const [matches, setMatches] = useState([]);
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState('');
  const [save, setSave] = useState(true);
  const [master, setMaster] = useState('');
  const [master2, setMaster2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const supported = vaultSupported();
  const isRole = /^(username|password|otp)$/.test(field);
  const name = isRole ? t(`vault.field.${field}`) : field;
  // WHERE on the page the value goes (the host read the element): the owner judges the target, not only the site
  const page = request.page || null;
  const pageKind = page ? [page.tag, page.type, page.name || page.id].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ') : '';
  // VAULT3: which PART of the saved value — an expiry's month or year (split in the vault worker, never shown here)
  const part = request.part && request.part !== 'value' ? request.part : null;
  const source = part ? `${name} · ${t(`vault.part.${part}`)}` : name;

  useEffect(() => {
    let alive = true;
    if (vault.unlocked) matchVaultField(request.origin, field, request.entry).then((m) => alive && setMatches(m)).catch(() => {});
    else setMatches([]);
    return () => { alive = false; };
  }, [vault.unlocked, vault.count, request.origin, field, request.entry]);

  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  // no "remember this choice" here: a named field is never filled without a tap (the per-site auto choice is a sign-in's)
  const base = { sessionId, requestId: request.requestId, origin: request.origin, field, ...(part ? { part } : {}) };
  const fillFrom = (m) => run(() => fillVaultField({ ...base, entryId: m.id }));
  const fillTyped = () => run(async () => {
    const keep = save && supported && field !== 'otp';
    if (keep) await openVault(t, vault, master, master2);
    await fillVaultField({ ...base, value, save: keep, title: request.entry });
  });
  const unlock = () => run(async () => { await unlockVault({ password: master }); setMaster(''); setBusy(false); });
  const answer = (choice) => run(() => api.post(`/sessions/${encodeURIComponent(sessionId)}/credentials/answer`, { requestId: request.requestId, choice }));
  const onEnter = (fn) => (e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); fn(); } };
  const showSaved = vault.unlocked && matches.length > 0 && !typing;
  const shared = request.target === 'shared';

  return (
    <CardFrame tone="accent" live data-credential-request={request.requestId} data-cred-kind="field" data-cred-part={part || undefined} label={t('vault.fieldCard.title', { field: source, host: request.host })}>
      {request.reason && <Prose className="mt-2">{request.reason}</Prose>}
      {shared && <Prose dim className="mt-1" data-cred-shared>{t('vault.card.shared', { account: request.account || 'Chrome' })}</Prose>}
      {page && (
        <Prose className="mt-1" data-cred-target>
          {t('vault.fieldCard.into', { label: page.label || page.tag, kind: pageKind })}
          <span className="text-xs text-[var(--term-accent-dim)]"> · {request.origin.replace(/^https?:\/\//, '')}</span>
        </Prose>
      )}
      <Prose dim className="mt-1">{t('vault.fieldCard.private')}</Prose>
      {showSaved ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {matches.map((m) => (
            <Btn key={m.id} variant="primary" disabled={busy} data-fill-from={m.title} onClick={() => fillFrom(m)}>
              {t('vault.fieldCard.fillFrom', { field: source, entry: m.title || m.username })}{!m.exact && <span className="opacity-70"> · {new URL(m.origin).hostname}</span>}
            </Btn>
          ))}
          <Btn variant="quiet" disabled={busy} onClick={() => setTyping(true)}>{t('vault.card.other')}</Btn>
        </div>
      ) : (
        <>
          <MasterRow vault={vault} master={master} setMaster={setMaster} master2={master2} setMaster2={setMaster2} onEnter={onEnter} busy={busy} onUnlock={unlock} create={save && supported && field !== 'otp' ? fillTyped : null} />
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            <input data-cred-field={field} {...fieldInputProps(isRole ? (field === 'username' ? 'text' : 'secret') : 'secret')} dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onEnter(fillTyped)} placeholder={name} aria-label={name} className={INPUT} />
          </div>
          {supported && field !== 'otp' && (
            <div className="mt-2">
              <Check checked={save} onChange={setSave} data-cred-save>{t('vault.fieldCard.save', { entry: request.entry || request.host })}</Check>
            </div>
          )}
          {!supported && <Prose dim className="mt-2">{t('vault.unsupported')}</Prose>}
        </>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        <span className="flex-1" />
        <Btn variant="quiet" disabled={busy} onClick={() => answer('cancel')}>{t('vault.card.cancel')}</Btn>
        <Btn variant="secondary" disabled={busy} data-cred-manual onClick={() => answer('manual')}>{t('vault.card.manual')}</Btn>
        {!showSaved && (
          <Btn variant="primary" data-cred-fill disabled={busy || !value} onClick={fillTyped}>
            {save && supported && field !== 'otp' ? t('vault.card.fillSave') : t('vault.card.fill')}
          </Btn>
        )}
      </div>
      {err && <div data-cred-error dir="auto" className="mt-1.5 text-end text-xs font-medium text-destructive">{err}</div>}
    </CardFrame>
  );
}

// ---- VAULT1: the sign-in card ----------------------------------------------------------------------------------------
function SignInCardView({ sessionId, request }) {
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
    if (keep) await openVault(t, vault, master, master2);
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

function CredentialCardView({ props: { sessionId, request } }) {
  if (request.kind === 'form') return <FormCardView sessionId={sessionId} request={request} />;
  if (request.kind === 'field') return <FieldCardView sessionId={sessionId} request={request} />;
  return <SignInCardView sessionId={sessionId} request={request} />;
}

export const CredentialCardDef = defineHostComponent({
  name: 'CredentialCard',
  description: 'Host: request_credentials — fill a sign-in from the owner\'s vault, or hand it to take-over',
  props: loose({
    sessionId: z.string(),
    request: loose({ requestId: str, origin: str, host: str, fields: any, reason: any, pref: any, target: any, account: any, kind: any, spec: any, entry: any, page: any, part: any }),
  }),
  component: CredentialCardView,
});

export default function CredentialCard({ sessionId, request }) {
  return <CredentialCardView props={{ sessionId, request }} />;
}
