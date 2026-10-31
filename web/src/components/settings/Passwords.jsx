// VAULT1 — Settings › Connections › Passwords: the owner's credential vault (lib/vault.js). A KDBX 4 file the
// cockpit encrypts itself — the host keeps only the ciphertext, and KeePassXC / KeePassDX / Strongbox open the same
// file. Here: lock/unlock, what is saved (sites and usernames, never a password), how long it stays unlocked, and
// the per-site choices made on sign-in cards ("always fill" / "I type it myself").
// VAULT2 — an entry is more than a sign-in: its named fields (a card number, an ID number…) are listed by name and
// type, and the owner can add a field, replace one, reveal or copy a value (their own click, their own tab), remove
// one, and add an entry by hand — several accounts for one site are several entries.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { confirmDialog } from '../../lib/confirm.js';
import { toast, toastError } from '../../lib/toast.js';
import { useVault, unlockVault, lockVault, listVault, removeVaultEntry, setVaultWindow, vaultWindowMinutes, saveVaultFields, revealVaultField } from '../../lib/vault.js';
import { FIELD_TYPES, cleanName } from '../../lib/vault-schema.js';
import { SECRET, fieldInputProps } from '../CredentialCard.jsx';
import { Section, SettingCard, Segmented, BTN_SM, BTN_DANGER, INPUT } from './shared.jsx';

const errText = (e) => String(e?.body?.error || e?.message || e).replace(/^HTTP \d+ — /, '');
const REVEAL_MS = 20_000;

/** One row: name · type · a value shown as dots, with Reveal / Copy / Remove. */
function FieldRow({ entry, field, onChange }) {
  const t = useT();
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (shown === null) return;
    const h = setTimeout(() => setShown(null), REVEAL_MS);
    return () => clearTimeout(h);
  }, [shown]);
  const reveal = async () => {
    try { setShown((await revealVaultField(entry.id, field.name)).value); } catch (e) { toastError(errText(e)); }
  };
  const copy = async () => {
    try {
      const { value } = await revealVaultField(entry.id, field.name);
      await navigator.clipboard.writeText(value);
      toast(t('vault.fields.copied', { name: field.name }));
    } catch (e) { toastError(errText(e)); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('vault.fields.removeTitle', { name: field.name }), body: t('vault.fields.removeBody'), confirmLabel: t('vault.remove'), danger: true }))) return;
    try { onChange(await saveVaultFields({ id: entry.id, remove: [field.name] })); } catch (e) { toastError(errText(e)); }
  };
  return (
    <div data-vault-field={field.name} className="flex flex-wrap items-center gap-2 py-1 text-xs">
      <span className="min-w-0 truncate font-medium text-fg" dir="auto">{field.name}</span>
      <span className="text-fgdim">{t(`vault.type.${field.type}`)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-fgdim" dir="ltr" data-vault-value>{shown === null ? '••••••••' : shown}</span>
      {shown === null ? (
        <button type="button" onClick={reveal} className={BTN_SM}>{t('vault.fields.reveal')}</button>
      ) : (
        <button type="button" onClick={() => setShown(null)} className={BTN_SM}>{t('vault.fields.hide')}</button>
      )}
      <button type="button" onClick={copy} className={BTN_SM}>{t('vault.fields.copy')}</button>
      <button type="button" onClick={remove} className={BTN_DANGER}>{t('vault.remove')}</button>
    </div>
  );
}

/** Add a field to an entry (or replace one of the same name): name, type, value. */
function AddField({ entry, onChange }) {
  const t = useT();
  const [name, setName] = useState('');
  const [type, setType] = useState('secret');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const n = cleanName(name) || (/^(username|password|otp)$/i.test(name.trim()) ? name.trim().toLowerCase() : null);
    if (!n) return toastError(t('vault.fields.badName'));
    if (!value) return;
    setBusy(true);
    try {
      onChange(await saveVaultFields({ id: entry.id, fields: [{ name: n, type, value }] }));
      setName('');
      setValue('');
    } catch (e) { toastError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div data-vault-add-field className="mt-1 flex flex-wrap items-center gap-2 py-1">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('vault.fields.name')} aria-label={t('vault.fields.name')} dir="auto" className={`${INPUT} w-[150px]`} autoComplete="off" />
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label={t('vault.fields.type')} className={`${INPUT} w-[120px]`}>
        {FIELD_TYPES.map((x) => <option key={x} value={x}>{t(`vault.type.${x}`)}</option>)}
      </select>
      {type === 'multiline' ? (
        <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('vault.fields.value')} aria-label={t('vault.fields.value')} dir="auto" rows={2} autoComplete="off" spellCheck={false} className={`${INPUT} h-auto w-[260px] py-1.5`} />
      ) : (
        <input {...fieldInputProps(type)} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={t('vault.fields.value')} aria-label={t('vault.fields.value')} dir="ltr" className={`${INPUT} w-[180px]`} />
      )}
      <button type="button" disabled={busy || !name || !value} onClick={add} className={BTN_SM}>{t('vault.fields.add')}</button>
    </div>
  );
}

/** A new entry by hand: the site, a title (the account), a username, and a first field. */
function AddEntry({ onDone }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [site, setSite] = useState('');
  const [title, setTitle] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!site.trim()) return;
    setBusy(true);
    try {
      await saveVaultFields({ origin: site.trim(), title: title.trim(), username: username.trim(), fields: [] });
      setSite(''); setTitle(''); setUsername(''); setOpen(false);
      onDone();
    } catch (e) { toastError(errText(e)); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" data-vault-add-entry onClick={() => setOpen(true)} className={`${BTN_SM} mt-2`}>{t('vault.entry.add')}</button>;
  return (
    <div data-vault-new-entry className="mt-2 flex flex-wrap items-center gap-2">
      <input value={site} onChange={(e) => setSite(e.target.value)} placeholder={t('vault.entry.site')} aria-label={t('vault.entry.site')} dir="ltr" className={`${INPUT} w-[180px]`} autoComplete="off" />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('vault.entry.title')} aria-label={t('vault.entry.title')} dir="auto" className={`${INPUT} w-[160px]`} autoComplete="off" />
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('vault.field.username')} aria-label={t('vault.field.username')} dir="ltr" className={`${INPUT} w-[180px]`} autoComplete="off" />
      <button type="button" disabled={busy || !site.trim()} onClick={create} className={BTN_SM}>{t('vault.entry.create')}</button>
      <button type="button" onClick={() => setOpen(false)} className={BTN_SM}>{t('vault.card.cancel')}</button>
    </div>
  );
}

function Entry({ it, onChange, onRemove }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const n = (it.fields || []).length;
  return (
    <div data-vault-entry={it.id} className="border-b border-hair py-1.5 text-sm last:border-b-0">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 truncate text-start text-fg" dir="auto" aria-expanded={open}>
          {it.title}<span className="text-xs text-fgdim" dir="ltr"> · {it.origin.replace(/^https?:\/\//, '')}</span>
        </button>
        <span className="min-w-0 truncate text-xs text-fgdim" dir="ltr">{it.username}</span>
        <span className="text-xs text-fgdim" data-vault-field-count>{t('vault.fields.count', { n })}</span>
        <button type="button" onClick={() => onRemove(it)} className={BTN_DANGER}>{t('vault.remove')}</button>
      </div>
      {open && (
        <div className="ms-2 mt-1 border-s border-hair ps-3">
          {(it.fields || []).map((f) => <FieldRow key={f.name} entry={it} field={f} onChange={onChange} />)}
          <AddField entry={it} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

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
  const reload = () => listVault().then(setItems).catch(() => setItems(null));
  useEffect(() => { loadPrefs(); }, []);
  useEffect(() => {
    if (vault.unlocked) reload();
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
  const changed = (entry) => setItems((list) => (list || []).map((x) => (x.id === entry.id ? entry : x)));
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
          <>
            <div data-vault-entries className="mt-2 rounded-lg border border-hair px-3 py-1">
              {items.length === 0 && <div className="py-2 text-xs text-fgdim">{t('vault.empty')}</div>}
              {items.map((it) => <Entry key={it.id} it={it} onChange={changed} onRemove={remove} />)}
            </div>
            <div className="mt-1 text-xs text-fgdim">{t('vault.fields.hint')}</div>
            <AddEntry onDone={reload} />
          </>
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
