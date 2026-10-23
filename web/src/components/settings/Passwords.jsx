// VAULT1 — Settings › Connections › Passwords: the owner's credential vault (lib/vault.js). A KDBX 4 file the
// cockpit encrypts itself — the host keeps only the ciphertext, and KeePassXC / KeePassDX / Strongbox open the same
// file. Here: lock/unlock, what is saved (sites and usernames, never a password), how long it stays unlocked, and
// the per-site choices made on sign-in cards ("always fill" / "I type it myself").
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toastError } from '../../lib/toast.js';
import { useVault, unlockVault, lockVault, listVault, removeVaultEntry, setVaultWindow, vaultWindowMinutes } from '../../lib/vault.js';
import { SECRET } from '../CredentialCard.jsx';
import { Section, SettingCard, Segmented, BTN_SM, BTN_DANGER, INPUT } from './shared.jsx';

const errText = (e) => String(e?.body?.error || e?.message || e).replace(/^HTTP \d+ — /, '');

export default function Passwords() {
  const t = useT();
  const vault = useVault();
  const [master, setMaster] = useState('');
  const [items, setItems] = useState(null);
  const [prefs, setPrefs] = useState({});
  const [win, setWin] = useState(vaultWindowMinutes());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const loadPrefs = () => api.get('/vault/prefs').then((r) => setPrefs(r.prefs || {})).catch(() => {});
  useEffect(() => { loadPrefs(); }, []);
  useEffect(() => {
    if (vault.unlocked) listVault().then(setItems).catch(() => setItems(null));
    else setItems(null);
  }, [vault.unlocked, vault.count]);

  const unlock = async () => {
    setBusy(true);
    setErr(null);
    try { await unlockVault({ password: master }); setMaster(''); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (it) => {
    if (!(await confirmDialog({ title: t('vault.removeTitle', { site: it.title }), body: t('vault.removeBody'), confirmLabel: t('vault.remove'), danger: true }))) return;
    try { setItems(await removeVaultEntry(it.id)); } catch (e) { toastError(errText(e)); }
  };
  const clearPref = (origin) => api.put('/vault/prefs', { origin, pref: null }).then((r) => setPrefs(r.prefs || {})).catch((e) => toastError(errText(e)));

  const state = vault.unsupported ? 'unsupported' : !vault.loaded ? 'loading' : vault.unlocked ? 'unlocked' : vault.exists ? 'locked' : 'none';
  return (
    <Section id="passwords" title={t('vault.section')}>
      <SettingCard
        title={t('vault.title')}
        hint={t(`vault.state.${state}`, { n: vault.count || 0 })}
        actions={
          <>
            {state === 'unlocked' && <button type="button" onClick={() => lockVault()} className={BTN_SM}>{t('vault.lock')}</button>}
            {(state === 'locked' || state === 'unlocked') && <a href="/__api/vault/file" download="arigami.kdbx" className={BTN_SM}>{t('vault.download')}</a>}
          </>
        }
      >
        {state === 'locked' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input {...SECRET} value={master} onChange={(e) => setMaster(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && master && unlock()} placeholder={t('vault.master')} aria-label={t('vault.master')} className={`${INPUT} w-[220px]`} />
            <button type="button" disabled={busy || !master} onClick={unlock} className={BTN_SM}>{t('vault.unlock')}</button>
          </div>
        )}
        {err && <div className="mt-1 text-xs text-err">{err}</div>}
        {items && (
          <div data-vault-entries className="mt-2 rounded-lg border border-hair px-3 py-1">
            {items.length === 0 && <div className="py-2 text-xs text-fgdim">{t('vault.empty')}</div>}
            {items.map((it) => (
              <div key={it.id} className="flex items-center gap-2 border-b border-hair py-1.5 text-sm last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-fg" dir="ltr">{it.title}</span>
                <span className="min-w-0 truncate text-xs text-fgdim" dir="ltr">{it.username}</span>
                <button type="button" onClick={() => remove(it)} className={BTN_DANGER}>{t('vault.remove')}</button>
              </div>
            ))}
          </div>
        )}
        {state !== 'unsupported' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fgdim">
            {t('vault.window')}
            <Segmented
              value={String(win)}
              label={t('vault.window')}
              options={[15, 60, 240, 480].map((m) => ({ value: String(m), label: t('vault.minutes', { n: m }) }))}
              onChange={(v) => { setWin(Number(v)); setVaultWindow(Number(v)).catch(() => {}); }}
            />
          </div>
        )}
      </SettingCard>
      {Object.keys(prefs).length > 0 && (
        <SettingCard title={t('vault.prefs')} hint={t('vault.prefsHint')}>
          <div className="mt-1">
            {Object.entries(prefs).map(([origin, pref]) => (
              <div key={origin} className="flex items-center gap-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg" dir="ltr">{origin.replace(/^https:\/\//, '')}</span>
                <span className="text-xs text-fgdim">{t(`vault.pref.${pref}`)}</span>
                <button type="button" onClick={() => clearPref(origin)} className={BTN_SM}>{t('vault.prefReset')}</button>
              </div>
            ))}
          </div>
        </SettingCard>
      )}
    </Section>
  );
}
