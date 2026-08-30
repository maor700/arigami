// Settings › Connections › Claude accounts (was the standalone AccountsView):
// the accounts the host runs sessions on — set active, pool membership, live
// usage, add (PKCE in the browser / paste a token) and remove. Backend:
// server/accounts.js + /__api/accounts; usage from the store's per-account
// 'account-usage' broadcasts. `initialAdd` opens the add flow straight away
// (#/accounts/add, the /mcp panel, SessionView's "sign in" button).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { toastSuccess } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import { useStore, loadAccounts } from '../../lib/store.js';
import { UsageBar } from '../Usage.jsx';
import { untilTime } from '../../lib/time.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import { Section, StatusPill, ErrorLine, BTN_SM } from './shared.jsx';

const TYPE_LABEL = { keychain: 'launcher.account.typeKeychain', 'oauth-token': 'launcher.account.typeToken' };
const INPUT = 'mt-2 w-full rounded-[6px] border border-border bg-bg px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-ink';
const PRIMARY = 'rounded-[6px] bg-ink px-3 py-1.5 text-[12px] font-bold text-panel hover:opacity-90 disabled:opacity-40';
const GHOST = 'rounded-[6px] border border-border px-3 py-1.5 text-[11.5px] text-fgdim hover:border-ink hover:text-fg';

function StateBadge({ account, usage }) {
  const t = useT();
  const cooling = account.quarantineUntil && Date.parse(account.quarantineUntil) > Date.now();
  if (cooling) return <StatusPill status="error" label={t('launcher.account.coolingDown', { time: untilTime(account.quarantineUntil) })} />;
  if (usage?.available && (usage.session?.pct ?? 0) >= 100) return <StatusPill status="error" label={t('launcher.account.atSessionLimit')} />;
  if (usage && !usage.available) {
    if (usage.reason === 'usage-throttled') return null; // transient endpoint hiccup
    const label = usage.reason === 'http-401' ? t('launcher.account.tokenInvalid')
      : usage.reason === 'http-403' ? t('launcher.account.usageNeedsRelogin') // token lacks user:profile scope — sessions still run
        : usage.reason === 'no-credentials' ? t('launcher.account.notSignedIn') : t('launcher.account.unavailable');
    return <StatusPill status="off" label={label} />;
  }
  return <StatusPill status="ok" label={t('launcher.account.available')} />;
}

function AccountCard({ account, usage, busy, onSetActive, onSetPool, onRemove }) {
  const t = useT();
  const initial = ((account.label || '').trim()[0] || '?').toUpperCase();
  return (
    <div className={`mb-2 rounded-xl border p-3 ${account.active ? 'border-ink bg-chip/40' : 'border-hair bg-panel'}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-chip text-[14px] font-bold text-fg">{initial}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-bold text-fg">{account.label}</span>
            {account.active && <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-bold text-panel">{t('launcher.account.active')}</span>}
            <span className="rounded-full border border-hair px-2 py-0.5 text-[10px] text-fgdim">{TYPE_LABEL[account.type] ? t(TYPE_LABEL[account.type]) : account.type}</span>
            <StateBadge account={account} usage={usage} />
          </div>
          {account.email || account.org || account.plan ? (
            <div className="mt-0.5 text-[11px] text-fgdim">{[account.email, account.org, account.plan].filter(Boolean).join(' · ')}</div>
          ) : account.type === 'oauth-token' ? (
            <div className="mt-0.5 text-[10.5px] text-fgdim">{t('launcher.account.browserToken')}</div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 ps-12">
        {usage?.available && (usage.session || usage.week) ? (
          <>
            <UsageBar label={t('launcher.account.usageSession')} win={usage.session} sub />
            <UsageBar label={t('launcher.account.usageWeek')} win={usage.week} sub />
          </>
        ) : (
          <div className="font-mono text-[10.5px] text-fgdim">{usage && !usage.available && usage.reason === 'http-403' ? t('launcher.account.usageHidden') : t('launcher.account.checkingUsage')}</div>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 ps-12">
        {!account.active && (
          <button type="button" disabled={busy} onClick={() => onSetActive(account.id)} className={GHOST}>{t('launcher.account.setActive')}</button>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-fgdim">
          <input type="checkbox" checked={!!account.pool} disabled={busy} onChange={(e) => onSetPool(account.id, e.target.checked)} />
          {t('launcher.account.inPool')}
        </label>
        {account.type !== 'keychain' && (
          <button type="button" disabled={busy} onClick={() => onRemove(account)} className="ms-auto rounded-[6px] border border-border px-2.5 py-1 text-[11.5px] text-[#B23B30] hover:border-[#B23B30] disabled:opacity-50">
            {t('launcher.account.remove')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ClaudeAccounts({ initialAdd = false, identity, onConnectAuto }) {
  const t = useT();
  const { accounts, accountUsage } = useStore();
  const list = accounts?.accounts || [];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [addMode, setAddMode] = useState(initialAdd ? 'choose' : null); // null | 'choose' | 'auth' | 'paste'
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [auth, setAuth] = useState(null); // { id, url, state, error }
  const [code, setCode] = useState('');

  useEffect(() => { loadAccounts(); }, []);
  useEffect(() => { if (initialAdd) setAddMode('choose'); }, [initialAdd]);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await loadAccounts(); } catch (e) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  const setActive = (id) => run(() => api.post('/accounts/active', { id }));
  const setPool = (id, pool) => run(() => api.post('/accounts/pool', { id, pool }));
  const remove = async (account) => {
    const ok = await confirmDialog({
      title: t('launcher.account.removeConfirmTitle', { name: account.label || t('launcher.account.thisAccount') }),
      body: t('launcher.account.removeConfirmBody'),
      confirmLabel: t('launcher.account.removeConfirm'),
      danger: true,
    });
    if (!ok) return;
    run(async () => { await api.post('/accounts/remove', { id: account.id }); toastSuccess(t('launcher.account.removedToast')); });
  };
  const add = () => run(async () => {
    await api.post('/accounts', { label: label.trim() || undefined, token: token.trim() });
    setAddMode(null); setLabel(''); setToken('');
  });
  // Self-driven PKCE: mint the consent URL, open it, exchange the pasted code.
  const startAuth = () => run(async () => {
    const r = await api.post('/accounts/oauth/start', { label: label.trim() || undefined });
    if (r?.state === 'error') throw new Error(r.error || t('launcher.account.startAuthError'));
    setAuth(r); setCode(''); setAddMode('auth');
    try { window.open(r.url, '_blank', 'noopener'); } catch { /* user clicks the link */ }
  });
  const submitCode = () => run(async () => {
    const r = await api.post('/accounts/oauth/code', { id: auth?.id, code: code.trim() });
    if (!r?.ok) { setAuth((a) => ({ ...(a || {}), state: 'error', error: r?.error || t('launcher.account.exchangeFailed') })); return; }
    setAuth(null); setAddMode(null); setLabel(''); setCode('');
  });
  const cancelAuth = () => {
    if (auth?.id) api.post('/accounts/oauth/cancel', { id: auth.id }).catch(() => {});
    setAuth(null); setCode(''); setAddMode(null);
  };

  return (
    <Section id="claude" title={t('settings.connections.claude')}>
      <div className="mb-2 text-[11px] text-fgdim">{t('launcher.account.subtitle')}</div>
      <ErrorLine>{err}</ErrorLine>
      {list.map((a) => (
        <AccountCard
          key={a.id}
          account={a}
          usage={accountUsage?.[a.id] || (a.lastUsage && !a.lastUsage.reason ? { available: true, session: { pct: a.lastUsage.session }, week: { pct: a.lastUsage.week } } : null)}
          busy={busy}
          onSetActive={setActive}
          onSetPool={setPool}
          onRemove={remove}
        />
      ))}
      {accounts && list.length === 0 && (
        <div className="mb-2 rounded-xl border border-hair bg-panel px-3 py-4 text-center text-[12px] text-fgdim">{t('launcher.account.emptyList')}</div>
      )}

      {addMode === null && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setAddMode('choose')} className="rounded-xl border border-dashed border-border px-3 py-2 text-[12px] text-fgdim hover:border-ink hover:text-fg">
            {t('launcher.account.addAccount')}
          </button>
          {identity && onConnectAuto && (
            <button type="button" onClick={onConnectAuto} className={BTN_SM}><Icon icon={faWandMagicSparkles} /> {t('setup.connectAuto')}</button>
          )}
        </div>
      )}

      {addMode === 'choose' && (
        <div className="rounded-xl border border-hair bg-panel p-3">
          <div className="text-[12.5px] font-bold text-fg">{t('launcher.account.addHeading')}</div>
          <p className="mt-1 text-[11px] leading-snug text-fgdim">{t('launcher.account.addBody')}</p>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('launcher.account.labelPlaceholder')} className={INPUT} />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={startAuth} className={PRIMARY}>{t('launcher.account.authBrowser')}</button>
            <button type="button" onClick={() => setAddMode('paste')} className={GHOST}>{t('launcher.account.pasteInstead')}</button>
            <button type="button" onClick={() => { setAddMode(null); setLabel(''); }} className="ms-auto text-[11.5px] text-fgdim hover:text-fg">{t('launcher.account.cancel')}</button>
          </div>
        </div>
      )}

      {addMode === 'auth' && (
        <div className="rounded-xl border border-hair bg-panel p-3">
          <div className="text-[12.5px] font-bold text-fg">{t('launcher.account.addAccountTitle')}{label ? ` · ${label}` : ''}</div>
          <ol className="mt-1.5 ms-4 list-decimal text-[11.5px] leading-relaxed text-fgdim">
            <li>
              {t('launcher.account.step1a')}
              {auth?.url && <> — <a href={auth.url} target="_blank" rel="noreferrer" className="text-[#2C6BD6] underline">{t('launcher.account.openSignIn')}</a></>}
              {t('launcher.account.step1b')}
            </li>
            <li>{t('launcher.account.step2')}</li>
          </ol>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) submitCode(); }}
            placeholder={t('launcher.account.codePlaceholder')}
            spellCheck={false}
            autoFocus
            className={`${INPUT} font-mono text-[11.5px]`}
          />
          {auth?.state === 'error' && <p className="mt-1.5 text-[11.5px] text-[#B23B30]">{auth.error || t('launcher.account.exchangeFailedRetry')}</p>}
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" disabled={busy || !code.trim()} onClick={submitCode} className={PRIMARY}>{busy ? t('launcher.account.finishing') : t('launcher.account.finish')}</button>
            <button type="button" onClick={cancelAuth} className="text-[11.5px] text-fgdim hover:text-fg">{t('launcher.account.cancel')}</button>
          </div>
        </div>
      )}

      {addMode === 'paste' && (
        <div className="rounded-xl border border-hair bg-panel p-3">
          <div className="text-[12.5px] font-bold text-fg">{t('launcher.account.pasteTitle')}</div>
          <p className="mt-1 text-[11px] leading-snug text-fgdim">
            {t('launcher.account.pasteBodyA')} <code className="rounded bg-chip px-1 font-mono">claude setup-token</code> {t('launcher.account.pasteBodyB')}{' '}
            <code className="font-mono">sk-ant-oat…</code> {t('launcher.account.pasteBodyC')}
          </p>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('launcher.account.labelPlaceholder')} className={INPUT} />
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" spellCheck={false} className={`${INPUT} font-mono text-[11.5px]`} />
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" disabled={busy || !token.trim()} onClick={add} className={PRIMARY}>{t('launcher.account.addAccountBtn')}</button>
            <button type="button" onClick={() => setAddMode('choose')} className="text-[11.5px] text-fgdim hover:text-fg">{t('launcher.account.back')}</button>
          </div>
        </div>
      )}

      <p className="mt-2 px-1 text-[10.5px] leading-snug text-fgdim">
        <b>{t('launcher.account.footerActive')}</b> {t('launcher.account.footer1')} <b>{t('launcher.account.footerPool')}</b> {t('launcher.account.footer2')}
      </p>
    </Section>
  );
}
