// Settings › Host › Users & access (C1). AUDIT2 split: `WhoAmI` (signed-in-as
// + the pairing code — the only way to add a phone/laptop) stays on the Host
// page; `UsersAdvanced` (the users list, API tokens), `ScreenShare` (the
// VNC-auth password every per-session x11vnc is started with —
// server/lib/desktops.ts — and the embedded viewer sends on
// `credentialsrequired`) and `DangerZone` (reset local prefs) are in the
// Advanced drawer. Sign-out moved to the rail's profile menu (Rail.jsx).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { toastError } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import { Section, SettingCard, Field, BTN, BTN_SM, BTN_DANGER, INPUT, ROW, LIST } from './shared.jsx';

export function WhoAmI() {
  const t = useT();
  const { auth } = useStore();
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const admin = !!auth?.isAdmin;
  const off = auth?.authMode === 'off';
  if (!auth) return null;
  const issueCode = async () => {
    setBusy(true);
    try { setCode((await api.post('/auth/pairing-code')).code); } catch (e) { toastError(String(e.message || e)); } finally { setBusy(false); }
  };
  return (
    <Section id="users" title={t('auth.settings.title')}>
      {off ? (
        <div className="text-[11.5px] text-fgdim">{t('auth.settings.off')}</div>
      ) : (
        <>
          <Field label={t('auth.settings.you')} hint={auth.user ? `${auth.user.email} · ${auth.user.role}` : auth.principal} />
          {admin && (
            <Field label={t('auth.settings.pairAnother')} hint={code ? t('auth.settings.pairCodeHint') : t('auth.settings.pairAnotherHint')}>
              {code ? <span className="font-mono text-sm font-bold tracking-[0.15em]">{code}</span>
                : <button type="button" disabled={busy} onClick={issueCode} className={BTN_SM}>{t('auth.settings.issueCode')}</button>}
            </Field>
          )}
        </>
      )}
    </Section>
  );
}

export function UsersAdvanced() {
  const t = useT();
  const { auth } = useStore();
  const [users, setUsers] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null); // {token} shown once
  const [busy, setBusy] = useState(false);
  const admin = !!auth?.isAdmin;
  const off = auth?.authMode === 'off';

  const load = () => {
    if (!auth || off) return;
    api.get('/auth/users').then((r) => setUsers(r.users || [])).catch(() => {});
    if (admin) api.get('/auth/tokens').then((r) => setTokens(r.tokens || [])).catch(() => {});
  };
  useEffect(() => { load(); }, [auth?.user?.id, admin, off]);
  if (!auth || off) return null;

  const createToken = async () => {
    setBusy(true);
    try { setFresh(await api.post('/auth/tokens', { label: label || 'cli' })); setLabel(''); load(); } catch (e) { toastError(String(e.message || e)); } finally { setBusy(false); }
  };
  const delToken = async (id) => { await api.del(`/auth/tokens/${id}`).catch(() => {}); load(); };
  const delUser = async (id) => { await api.del(`/auth/users/${id}`).catch((e) => toastError(String(e.message || e))); load(); };

  return (
    <Section id="users-list" title={t('auth.settings.usersTitle')}>
      {users.length > 0 ? (
        <div className={LIST}>
          {users.map((u) => (
            <div key={u.id} className={ROW}>
              <span className="min-w-0 truncate">
                <span className="font-bold">{u.email}</span>
                <span className="ms-2 font-mono text-[10px] text-fgdim">{u.role}{u.oidcSub ? ' · oidc' : ''}</span>
              </span>
              {admin && u.id !== auth.user?.id && (
                <button type="button" onClick={() => delUser(u.id)} className="cursor-pointer text-[10px] text-fgdim hover:text-fg">{t('auth.settings.remove')}</button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-fgdim">{t('auth.settings.noUsers')}</div>
      )}
      {admin && (
        <>
          <Field label={t('auth.settings.tokens')} hint={t('auth.settings.tokensHint')}>
            <span className="flex items-center gap-1.5">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('auth.settings.tokenLabel')} className={`${INPUT} w-[110px] font-sans`} />
              <button type="button" disabled={busy} onClick={createToken} className={BTN_SM}>{t('auth.settings.createToken')}</button>
            </span>
          </Field>
          {fresh && (
            <div className="mt-1 rounded-lg border border-hair bg-panel px-3 py-2 text-[11px]">
              <div className="mb-1 text-fgdim">{t('auth.settings.tokenOnce')}</div>
              <code className="break-all font-mono text-[11px] select-all">{fresh.token}</code>
            </div>
          )}
          {tokens.length > 0 && (
            <div className={LIST}>
              {tokens.map((tk) => (
                <div key={tk.id} className={ROW}>
                  <span className="min-w-0 truncate">
                    <span className="font-bold">{tk.label}</span>
                    <span className="ms-2 font-mono text-[10px] text-fgdim">{tk.email} · {tk.createdAt?.slice(0, 10)}</span>
                  </span>
                  <button type="button" onClick={() => delToken(tk.id)} className="cursor-pointer text-[10px] text-fgdim hover:text-fg">{t('auth.settings.revoke')}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// Write-only from the UI's point of view — the server only reports whether
// a password is set.
export function ScreenShare() {
  const t = useT();
  const [hasPassword, setHasPassword] = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  useEffect(() => {
    api.get('/screen/settings').then((r) => setHasPassword(!!r?.hasVncPassword)).catch(() => setHasPassword(false));
  }, []);
  const submit = async (pw) => {
    setBusy(true);
    try {
      const r = await api.put('/screen/settings', { vncPassword: pw });
      setHasPassword(!!r?.hasVncPassword); setValue(''); setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  if (hasPassword === null) return null;
  return (
    <Section id="screen" title={t('settings.screenTitle')}>
      <Field label={t('settings.vncPassword')} hint={t('settings.vncPassword.hint')} wrap>
        <div className="flex flex-col items-end gap-1.5">
          <span className="flex items-center gap-2">
            <input
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && value && !busy && submit(value)}
              placeholder={t('settings.vncPassword.placeholder')}
              className={`${INPUT} w-[160px] px-3 py-1.5 text-[11.5px]`}
            />
            <button type="button" disabled={busy || !value} onClick={() => submit(value)} className={BTN}>{t('settings.vncPassword.save')}</button>
            {hasPassword && <button type="button" disabled={busy} onClick={() => submit('')} className={BTN}>{t('settings.vncPassword.clear')}</button>}
          </span>
          <span className="font-mono text-[10.5px] text-fgdim">{savedTick ? t('settings.vncPassword.saved') : hasPassword ? t('settings.vncPassword.set') : t('settings.vncPassword.unset')}</span>
        </div>
      </Field>
    </Section>
  );
}

// Reset local prefs only — sign-out is the profile menu's job now (Rail.jsx).
export function DangerZone() {
  const t = useT();
  const resetPrefs = async () => {
    if (!(await confirmDialog({ title: t('settings.danger.resetPrefs.confirm'), body: t('settings.danger.resetPrefs.hint'), confirmLabel: t('settings.danger.resetPrefs'), danger: true }))) return;
    try { localStorage.removeItem('arigami-prefs'); } catch { /* no storage */ }
    window.location.reload();
  };
  return (
    <Section id="danger" title={t('settings.danger')}>
      <SettingCard tone="danger" title={t('settings.danger.resetPrefs')} hint={t('settings.danger.resetPrefs.hint')}
        actions={<button type="button" onClick={resetPrefs} className={BTN_DANGER}>{t('settings.danger.resetPrefs')}</button>} />
    </Section>
  );
}

// The drawer half of the page, in the old order.
export default function AccessAdvanced() {
  return (
    <>
      <UsersAdvanced />
      <ScreenShare />
      <DangerZone />
    </>
  );
}
