// Settings › Extensions (EXT wave 2). The fourth category, and the only place
// a human installs, configures or removes an extension.
//
// The one rule that shapes this page: **installing an extension is running
// someone's code as yourself** (docs/EXTENSIONS.md §6). So "Add" never installs
// on the first click — it reads the manifest first (POST /__api/extensions/validate)
// and shows the title, the description and every requested permission in a
// confirmation dialog. Only a second, deliberate click installs.
//
// A git URL is the one case that cannot be pre-read: the host has to clone
// before there is a manifest to validate. That path therefore asks first
// ("clone from a source you trust"), and shows the permissions right after the
// install with "keep on / turn off / remove" — the same decision, one step later.
import { useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore, loadExtensions } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { toast, toastError } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import { settingsFields, fieldValue, coerceSettings } from '../../lib/ext.js';
import { faPuzzlePiece, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import {
  Section, SettingCard, StatusPill, Toggle, ErrorLine,
  BTN, BTN_SM, BTN_PRIMARY, BTN_DANGER, INPUT,
} from './shared.jsx';

/** A manifest permission → a sentence a human can decide on. */
export function permissionLabel(t, perm) {
  const p = String(perm || '');
  if (p.startsWith('tools:')) return t('ext.perm.tools', { name: p.slice(6) });
  if (p.startsWith('events:')) return t('ext.perm.events', { name: p.slice(7) });
  const known = t(`ext.perm.${p}`);
  return known === `ext.perm.${p}` ? `${p} — ${t('ext.perm.unknown')}` : known;
}

function PermissionList({ permissions }) {
  const t = useT();
  const list = (permissions || []).filter((p) => typeof p === 'string');
  if (!list.length) return <div className="text-[11px] text-fgdim">{t('ext.permissions.none')}</div>;
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {list.map((p) => (
        <li key={p} className="flex items-start gap-2 text-[11.5px] text-fg">
          <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-fgdim" />
          <span className="min-w-0">
            {permissionLabel(t, p)}
            <code dir="ltr" className="ms-1.5 font-mono text-[11.5px] md:text-[10px] text-fgdim">{p}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- the trusted tier --------------------------------------------- */

// The second decision, and a bigger one than the permission list: a trusted
// extension's tab is served WITHOUT the sandbox, same origin as the cockpit, so
// it holds the session cookie and can call /__api as the human. The manifest can
// only ask; this checkbox is what actually grants it (host side: the `trusted`
// map in extensions.json, which is why a `git pull` can't escalate anything).
function TrustNotice({ children }) {
  const t = useT();
  return (
    <div className="mt-2 rounded-lg border-[1.5px] border-ink bg-chip px-3 py-2 text-[11.5px] leading-relaxed text-fg">
      <div className="font-bold">⚠ {t('ext.trust.title')}</div>
      <div className="mt-0.5 text-fgdim">{t('ext.trust.body')}</div>
      {children}
    </div>
  );
}

/* ---------- the install confirmation ------------------------------------- */

// Deliberately a modal, not an inline panel: an install is a decision with
// consequences outside this page, and it should interrupt.
function InstallDialog({ manifest, permissions, errors = [], mode, busy, onConfirm, onCancel }) {
  const t = useT();
  const name = manifest?.title || manifest?.name || '';
  const review = mode === 'review';
  const wantsTrust = manifest?.trusted === true;
  const [trust, setTrust] = useState(false);
  return (
    <div
      className="fixed inset-0 z-[86] flex items-center justify-center bg-[rgba(20,20,22,0.5)] p-5"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={busy ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-[440px] max-w-full overflow-y-auto rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)] thin-scroll"
      >
        <div className="px-[18px] pt-4 pb-1 text-[14px] font-bold">
          {t(review ? 'ext.review.title' : 'ext.confirm.title', { name })}
        </div>
        {manifest?.description && (
          <div className="px-[18px] pb-2 text-[11.5px] leading-relaxed text-fgdim">{manifest.description}</div>
        )}
        <div className="px-[18px] pb-1 text-[11.5px] leading-relaxed text-fgdim">
          {t(review ? 'ext.review.intro' : 'ext.confirm.intro')}
        </div>
        <div className="px-[18px] pb-3">
          <PermissionList permissions={permissions} />
          {wantsTrust && !review && (
            <TrustNotice>
              <label className="mt-2 flex cursor-pointer items-start gap-2">
                <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="mt-[3px]" />
                <span className="min-w-0 font-bold">{t('ext.trust.grant')}</span>
              </label>
            </TrustNotice>
          )}
          {wantsTrust && review && <TrustNotice>{null}</TrustNotice>}
          {errors.length > 0 && (
            <ErrorLine>
              <div className="font-bold">{t('ext.confirm.errors')}</div>
              <ul className="mt-1 list-disc list-inside">
                {errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </ErrorLine>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-hair px-[18px] py-3">
          {review ? (
            <>
              <button type="button" disabled={busy} onClick={() => onConfirm('remove')} className={BTN_DANGER}>{t('ext.review.remove')}</button>
              <button type="button" disabled={busy} onClick={() => onConfirm('disable')} className={BTN_SM}>{t('ext.review.disable')}</button>
              <button type="button" disabled={busy} onClick={() => onConfirm('keep')} className={BTN_PRIMARY}>{t('ext.review.keep')}</button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={onCancel} className={BTN_SM}>{t('ext.confirm.cancel')}</button>
              <button type="button" disabled={busy} onClick={() => onConfirm('install', { trust })} className={BTN_PRIMARY}>
                {busy ? t('ext.add.installing') : wantsTrust && trust ? t('ext.confirm.installTrusted') : t('ext.confirm.install')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- add ----------------------------------------------------------- */

const isGitUrl = (s) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(String(s || '').trim()) || /\.git$/i.test(String(s || '').trim());

function AddExtension({ onDone }) {
  const t = useT();
  const [source, setSource] = useState('');
  const [phase, setPhase] = useState(''); // '' | 'checking' | 'installing'
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // {manifest, permissions, errors, mode, name}

  const busy = phase !== '';

  // Step 1 — read the manifest without installing anything (local directory),
  // or get an explicit "yes, clone from there" first (git URL).
  const check = async () => {
    const src = source.trim();
    if (!src || busy) return;
    setError(null);
    if (isGitUrl(src)) {
      const ok = await confirmDialog({
        title: t('ext.confirm.git.title'),
        body: t('ext.confirm.git.body'),
        confirmLabel: t('ext.confirm.git.go'),
        cancelLabel: t('ext.confirm.cancel'),
      });
      if (ok) await install(src, 'review');
      return;
    }
    setPhase('checking');
    try {
      const v = await api.post('/extensions/validate', { source: src });
      setPending({
        manifest: v?.manifest || { name: src },
        permissions: v?.manifest?.permissions || [],
        errors: v?.errors || [],
        mode: 'install',
      });
    } catch (e) {
      setError(e);
    } finally {
      setPhase('');
    }
  };

  // Step 2 — the actual install. `after` is 'install' (already confirmed) or
  // 'review' (git: show the permissions once they exist). `trust` is only ever
  // true on the confirmed path — a git clone's manifest is unread at this point,
  // so the trusted tier there is granted afterwards, from the extension's card.
  const install = async (src, after, trust = false) => {
    setPhase('installing');
    setError(null);
    try {
      const r = await api.post('/extensions/add', { source: src, trust });
      setSource('');
      await loadExtensions();
      if (after === 'review') {
        setPending({ manifest: r?.manifest || { name: r?.name }, permissions: r?.permissions || [], errors: r?.errors || [], mode: 'review', name: r?.name });
      } else {
        setPending(null);
        toast(t('ext.added', { name: r?.name || '' }));
        onDone?.();
      }
    } catch (e) {
      setPending(null);
      setError(e);
    } finally {
      setPhase('');
    }
  };

  // The review dialog's three answers, for the git path.
  const decide = async (choice) => {
    const name = pending?.name || pending?.manifest?.name;
    setPhase('installing');
    try {
      if (choice === 'remove') await api.del(`/extensions/${name}`);
      else if (choice === 'disable') await api.patch(`/extensions/${name}`, { enabled: false });
      await loadExtensions();
      setPending(null);
      if (choice === 'keep') toast(t('ext.added', { name }));
      onDone?.();
    } catch (e) {
      // Close the dialog too — the error line lives behind it on the page.
      setPending(null);
      setError(e);
    } finally {
      setPhase('');
    }
  };

  return (
    <SettingCard title={t('ext.add')} hint={t('ext.add.hint')}>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={source}
          dir="ltr"
          disabled={busy}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && check()}
          placeholder={t('ext.add.placeholder')}
          className={`${INPUT} min-w-0 flex-1`}
        />
        <button type="button" disabled={busy || !source.trim()} onClick={check} className={BTN}>
          {phase === 'checking' ? t('ext.add.checking') : phase === 'installing' ? t('ext.add.installing') : t('ext.add.check')}
        </button>
      </div>
      <ErrorLine>{error ? String(error.message || error) : null}</ErrorLine>
      {pending && (
        <InstallDialog
          manifest={pending.manifest}
          permissions={pending.permissions}
          errors={pending.errors}
          mode={pending.mode}
          busy={busy}
          onConfirm={(choice, opts) => (pending.mode === 'review' ? decide(choice) : install(source.trim(), 'install', opts?.trust === true))}
          onCancel={() => setPending(null)}
        />
      )}
    </SettingCard>
  );
}

/* ---------- the per-extension settings form ------------------------------- */

function SettingsForm({ ext }) {
  const t = useT();
  const fields = useMemo(() => settingsFields(ext.settingsSchema), [ext.settingsSchema]);
  const initial = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.key, fieldValue(f, ext.settings)])),
    [fields, ext.settings]
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  if (!fields.length) return null;

  const dirty = fields.some((f) => form[f.key] !== initial[f.key]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/extensions/${ext.name}`, { settings: coerceSettings(fields, form) });
      await loadExtensions();
      toast(t('ext.settings.saved'));
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 border-t border-hair pt-2">
      <div className="mb-1 font-mono text-[11px] md:text-[9.5px] tracking-[0.08em] text-fgdim uppercase">{t('ext.settings')}</div>
      {fields.map((f) => (
        <div key={f.key} className={`flex gap-3 border-b border-hair py-2 last:border-b-0 ${f.multiline ? 'flex-col' : 'items-center'}`}>
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-bold text-fg">{f.title}</div>
            {f.description && <div className="mt-0.5 text-[11.5px] md:text-[10.5px] text-fgdim">{f.description}</div>}
            {f.fallback !== undefined && f.type !== 'boolean' && !f.multiline && (
              <div className="mt-0.5 font-mono text-[11px] md:text-[9.5px] text-fgdim" dir="ltr">
                {t('ext.settings.default', { v: String(f.fallback) })}
              </div>
            )}
          </div>
          <div className={f.multiline ? 'w-full' : 'shrink-0'}>
            {f.type === 'boolean' ? (
              <Toggle on={form[f.key] === true} onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))} />
            ) : f.multiline ? (
              <textarea
                value={form[f.key] ?? ''}
                rows={8}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className={`${INPUT} w-full resize-y font-mono`}
              />
            ) : (
              <input
                value={form[f.key] ?? ''}
                dir="ltr"
                type={f.type === 'number' ? 'number' : 'text'}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className={`${INPUT} w-[170px]`}
              />
            )}
          </div>
        </div>
      ))}
      <div className="mt-2 flex justify-end">
        <button type="button" disabled={saving || !dirty} onClick={save} className={BTN_PRIMARY}>
          {saving ? t('ext.settings.saving') : t('ext.settings.save')}
        </button>
      </div>
      <ErrorLine>{error ? String(error.message || error) : null}</ErrorLine>
    </div>
  );
}

/* ---------- one extension ------------------------------------------------- */

const CONTRIB_KEYS = ['tools', 'listeners', 'docs', 'tabs', 'hooks', 'gates', 'channels', 'webhooks'];

export function ExtensionCard({ ext }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const status = ext.state === 'loaded' ? 'ok' : ext.state === 'error' ? 'error' : 'off';
  const contributions = CONTRIB_KEYS
    .filter((k) => (ext.contributions?.[k] || 0) > 0)
    .map((k) => t(`ext.c.${k}`, { n: ext.contributions[k] }));

  const toggle = async (on) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/extensions/${ext.name}`, { enabled: on });
      await loadExtensions();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // Grant / revoke the TRUSTED tier after the install — the path a git-cloned
  // extension takes (its manifest could not be read before the clone), and the
  // way out again once you no longer want a tab holding your cockpit session.
  const setTrust = async (on) => {
    const ok = await confirmDialog({
      title: t(on ? 'ext.trust.confirm.title' : 'ext.trust.revoke.title', { name: ext.title || ext.name }),
      body: t(on ? 'ext.trust.confirm.body' : 'ext.trust.revoke.body'),
      confirmLabel: t(on ? 'ext.trust.confirm.go' : 'ext.trust.revoke.go'),
      danger: on,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/extensions/${ext.name}`, { trusted: on });
      await loadExtensions();
      toast(t(on ? 'ext.trust.granted' : 'ext.trust.revoked', { name: ext.title || ext.name }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t('ext.remove.title', { name: ext.title || ext.name }),
      body: t('ext.remove.body'),
      confirmLabel: t('ext.remove.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/extensions/${ext.name}`);
      await loadExtensions();
      toast(t('ext.removed', { name: ext.title || ext.name }));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <SettingCard
      title={ext.title || ext.name}
      hint={ext.description || undefined}
      pill={<StatusPill status={status} label={t(`ext.state.${ext.state}`)} />}
      actions={
        <>
          <button type="button" disabled={busy} onClick={remove} className={BTN_DANGER}>{t('ext.remove')}</button>
          <Toggle on={ext.enabled !== false} disabled={busy} onChange={toggle} />
        </>
      }
      tone={ext.state === 'error' ? 'danger' : 'default'}
    >
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] md:text-[9.5px] text-fgdim" dir="ltr">
        <span>{ext.name}</span>
        {ext.version && <span>· {t('ext.version', { v: ext.version })}</span>}
        {ext.apiVersion != null && <span>· {t('ext.apiVersion', { n: ext.apiVersion })}</span>}
        {ext.sha && <span>· {t('ext.sha', { sha: String(ext.sha).slice(0, 7) })}</span>}
      </div>

      <div className="mt-1.5 text-[11px] text-fgdim">
        <span className="font-bold">{t('ext.contributions')}: </span>
        {contributions.length ? contributions.join(' · ') : t('ext.c.none')}
      </div>

      <div className="mt-1.5">
        <div className="text-[11px] font-bold text-fgdim">{t('ext.permissions')}</div>
        <PermissionList permissions={ext.permissions} />
      </div>

      {/* The tier. Only shown when it is a live question — an ordinary
          sandboxed extension that never asked says nothing. */}
      {(ext.trusted || ext.trustRequested) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`rounded-full border-[1.5px] border-ink px-2 py-0.5 text-[11.5px] md:text-[10.5px] ${ext.trusted ? 'bg-chip text-fg' : 'bg-panel text-fgdim'}`}>
            {t(ext.trusted ? 'ext.tier.trusted' : 'ext.tier.sandboxed')}
          </span>
          <span className="min-w-0 flex-1 text-[11.5px] md:text-[10.5px] text-fgdim">
            {t(ext.trusted ? 'ext.tier.trusted.hint' : 'ext.tier.asked.hint')}
          </span>
          <button type="button" disabled={busy} onClick={() => setTrust(!ext.trusted)} className={ext.trusted ? BTN_SM : BTN_DANGER}>
            {t(ext.trusted ? 'ext.trust.revoke' : 'ext.trust.grant.short')}
          </button>
        </div>
      )}

      {ext.error && <ErrorLine>{ext.error}</ErrorLine>}
      {(ext.warnings || []).length > 0 && (
        <div className="mt-2 rounded-lg border border-hair bg-chip/50 px-3 py-2 text-[11.5px] md:text-[10.5px] text-fgdim">
          <div className="font-bold">{t('ext.warnings')}</div>
          <ul className="mt-0.5 list-inside list-disc">
            {ext.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <SettingsForm ext={ext} />
      <ErrorLine>{error ? String(error.message || error) : null}</ErrorLine>
    </SettingCard>
  );
}

/* ---------- the page ------------------------------------------------------ */

export default function ExtensionsPage() {
  const t = useT();
  const { extensions, extApiVersion } = useStore();
  const [reloading, setReloading] = useState(false);

  const reload = async () => {
    setReloading(true);
    try {
      await api.post('/extensions/reload', {});
      await loadExtensions();
      toast(t('ext.reloaded'));
    } catch (e) {
      toastError(e);
    } finally {
      setReloading(false);
    }
  };

  return (
    <>
      <Section id="extensions" title={t('ext.title')} onRefresh={loadExtensions} first>
        <p className="mb-2 text-[11px] leading-snug text-fgdim">
          {t('ext.sub')} · {t('ext.apiVersion', { n: extApiVersion })}
        </p>
        <div className="mb-3 flex justify-end">
          <button type="button" disabled={reloading} onClick={reload} className={BTN_SM}>
            <Icon icon={faRotateRight} /> {reloading ? t('ext.reloading') : t('ext.reload')}
          </button>
        </div>
        {extensions.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <span className="text-[18px] text-fgdim"><Icon icon={faPuzzlePiece} /></span>
            <div className="text-[12px] text-fgdim">{t('ext.empty')}</div>
          </div>
        ) : (
          extensions.map((e) => <ExtensionCard key={e.name} ext={e} />)
        )}
      </Section>

      <Section id="extensions-add" title={t('ext.add')}>
        <AddExtension />
      </Section>
    </>
  );
}
