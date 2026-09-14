// Settings › Connections › Accounts (was ClaudeAccounts.jsx): the logins the
// host runs sessions on, grouped by PROVIDER (lib/providers.js — Claude, Codex,
// …). Set active (per provider), pool membership, live usage, add and remove.
// Adding asks for the provider first, then the method that provider offers:
//   Claude — PKCE in the browser (paste the code back) / paste a setup-token
//   Codex  — `codex login` in the browser (sign in; if the browser is not on
//            the host machine, paste the callback address back and the host
//            forwards it to codex's loopback; the poller sees it finish) /
//            paste an OpenAI API key
// Backend: server/accounts.js + /__api/accounts (generic routes:
// /accounts/providers, POST /accounts {provider}, /accounts/login/*). Usage
// comes from the store's per-account 'account-usage' broadcasts. `initialAdd`
// opens the add flow straight away (#/accounts/add, the /mcp panel,
// SessionView's "sign in" button).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { toastSuccess } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import { useStore, loadAccounts } from '../../lib/store.js';
import { UsageBar } from '../Usage.jsx';
import { untilTime } from '../../lib/time.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import { PROVIDERS, DEFAULT_PROVIDER, providerOf, mergeCatalog, TYPE_LABEL_KEYS, windowLabel, snapshotUsage } from '../../lib/providers.js';
import { Section, StatusPill, ErrorLine, BTN_SM } from './shared.jsx';

const INPUT = 'mt-2 w-full rounded-[6px] border border-border bg-bg px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-ink';
// The filled action button: brand fill + foreground text, like every other
// primary button in Settings (shared.jsx BTN_PRIMARY). `bg-ink text-panel` was
// dark-on-dark in dark mode — --color-ink is #2a2a2a in both themes while the
// panel goes near-black — so the "Sign in" label became unreadable.
const PRIMARY = 'cursor-pointer rounded-[6px] border border-ink bg-brand px-3 py-1.5 text-[12px] font-bold text-[#1a1a1a] hover:opacity-90 disabled:opacity-40';
const GHOST = 'rounded-[6px] border border-border px-3 py-1.5 text-[11.5px] text-fgdim hover:border-ink hover:text-fg';

/** The provider badge on a card: a coloured dot + the product name. Text, never colour alone. */
export function ProviderBadge({ provider, catalog }) {
  const t = useT();
  const p = (catalog || PROVIDERS)[provider] || PROVIDERS[DEFAULT_PROVIDER];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-hair bg-bg px-2 py-0.5 text-[11.5px] md:text-[10px] font-bold text-fg"
      title={t('launcher.account.providerBadge', { provider: p.label })}
      data-provider={p.id}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.dot || '#888' }} />
      {p.label}
    </span>
  );
}

function StateBadge({ account, usage }) {
  const t = useT();
  const cooling = account.quarantineUntil && Date.parse(account.quarantineUntil) > Date.now();
  if (cooling) return <StatusPill status="error" label={t('launcher.account.coolingDown', { time: untilTime(account.quarantineUntil) })} />;
  if (usage?.available && usage.limitReached) return <StatusPill status="error" label={t('launcher.account.limitReached')} />;
  if (usage?.available && (usage.session?.pct ?? 0) >= 100) return <StatusPill status="error" label={t('launcher.account.atSessionLimit')} />;
  if (usage && !usage.available) {
    if (usage.reason === 'usage-throttled' || usage.reason === 'api-key') return usage.reason === 'api-key' ? <StatusPill status="ok" label={t('launcher.account.available')} /> : null;
    const label = usage.reason === 'http-401' ? t('launcher.account.tokenInvalid')
      : usage.reason === 'http-403' ? t('launcher.account.usageNeedsRelogin') // token lacks user:profile scope — sessions still run
        : usage.reason === 'no-credentials' ? t('launcher.account.notSignedIn') : t('launcher.account.unavailable');
    return <StatusPill status="off" label={label} />;
  }
  return <StatusPill status="ok" label={t('launcher.account.available')} />;
}

function AccountCard({ account, usage, busy, catalog, onSetActive, onSetPool, onRemove }) {
  const t = useT();
  const provider = providerOf(account);
  const local = account.type === (catalog[provider] || PROVIDERS[provider])?.localType;
  const initial = ((account.label || '').trim()[0] || '?').toUpperCase();
  const typeKey = TYPE_LABEL_KEYS[account.type];
  return (
    <div data-account-card data-provider={provider} className={`mb-2 rounded-xl border p-3 ${account.active ? 'border-ink bg-chip/40' : 'border-hair bg-panel'}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-chip text-[14px] font-bold text-fg">{initial}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-bold text-fg">{account.label}</span>
            <ProviderBadge provider={provider} catalog={catalog} />
            {account.active && <span className="rounded-full bg-fg px-2 py-0.5 text-[11.5px] md:text-[10px] font-bold text-bg">{t('launcher.account.active')}</span>}
            <span className="rounded-full border border-hair px-2 py-0.5 text-[11.5px] md:text-[10px] text-fgdim">{typeKey ? t(typeKey) : account.type}</span>
            <StateBadge account={account} usage={usage} />
          </div>
          {account.email || account.org || account.plan ? (
            <div className="mt-0.5 text-[11px] text-fgdim">{[account.email, account.org, account.plan].filter(Boolean).join(' · ')}</div>
          ) : account.type === 'oauth-token' ? (
            <div className="mt-0.5 text-[11.5px] md:text-[10.5px] text-fgdim">{t('launcher.account.browserToken')}</div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 ps-12">
        {usage?.available && (usage.session || usage.week) ? (
          <>
            <UsageBar label={windowLabel(t, provider, 'session', usage.session)} win={usage.session} sub />
            <UsageBar label={windowLabel(t, provider, 'week', usage.week)} win={usage.week} sub />
          </>
        ) : (
          <div className="font-mono text-[11.5px] md:text-[10.5px] text-fgdim">
            {usage && !usage.available && usage.reason === 'api-key'
              ? t('launcher.account.apiKeyUsage')
              : usage && !usage.available && usage.reason === 'http-403'
                ? t('launcher.account.usageHidden')
                : t('launcher.account.checkingUsage')}
          </div>
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
        {!local && (
          <button type="button" disabled={busy} onClick={() => onRemove(account)} className="ms-auto rounded-[6px] border border-border px-2.5 py-1 text-[11.5px] text-[#B23B30] hover:border-[#B23B30] disabled:opacity-50">
            {t('launcher.account.remove')}
          </button>
        )}
      </div>
    </div>
  );
}

// `footer`: the 3-line active/pool explainer — AUDIT2 moved it to the Advanced drawer.
export function AccountsFooter() {
  const t = useT();
  return (
    <p className="mt-2 px-1 text-[11.5px] md:text-[10.5px] leading-snug text-fgdim">
      <b>{t('launcher.account.footerActive')}</b> {t('launcher.account.footer1')} <b>{t('launcher.account.footerPool')}</b> {t('launcher.account.footer2')}
    </p>
  );
}

/** Provider chooser: one button per provider, the picked one filled. */
function ProviderPicker({ catalog, value, onChange }) {
  const t = useT();
  const ids = Object.keys(catalog);
  return (
    <div className="mt-2">
      <div className="text-[11px] text-fgdim">{t('launcher.account.providerLabel')}</div>
      <div role="radiogroup" className="mt-1 flex flex-wrap gap-2">
        {ids.map((id) => {
          const p = catalog[id];
          const on = id === value;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              data-provider-choice={id}
              onClick={() => onChange(id)}
              className={`inline-flex items-center gap-2 rounded-[8px] border px-3 py-1.5 text-[12px] ${on ? 'border-ink bg-chip font-bold text-fg' : 'border-border text-fgdim hover:border-ink hover:text-fg'}`}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.dot || '#888' }} />
              {p.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-fgdim">{t('launcher.account.providerHint')}</p>
    </div>
  );
}

export default function Accounts({ initialAdd = false, identity, onConnectAuto, footer = true }) {
  const t = useT();
  const { accounts, accountUsage } = useStore();
  const list = accounts?.accounts || [];
  const [catalog, setCatalog] = useState(PROVIDERS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [addMode, setAddMode] = useState(initialAdd ? 'choose' : null); // null | 'choose' | 'auth' | 'paste'
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [auth, setAuth] = useState(null); // { id, provider, url, code?, state, error }
  const [code, setCode] = useState('');
  const pollRef = useRef(null);

  useEffect(() => { loadAccounts(); }, []);
  useEffect(() => { if (initialAdd) setAddMode('choose'); }, [initialAdd]);
  // The server's catalog wins over the local table (a new provider shows up
  // without a web change); old hosts without the route keep the local one.
  useEffect(() => {
    let alive = true;
    api.get('/accounts/providers').then((r) => { if (alive && r?.providers?.length) setCatalog(mergeCatalog(r.providers)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
  const resetAdd = () => { setAddMode(null); setLabel(''); setToken(''); setAuth(null); setCode(''); };
  const add = () => run(async () => {
    await api.post('/accounts', { provider, label: label.trim() || undefined, token: token.trim() });
    resetAdd();
  });
  // The browser path. Claude: self-driven PKCE — mint the consent URL, open it,
  // exchange the pasted code. Codex: device-auth — codex prints a URL + a code
  // the human types INTO the browser; we poll until codex reports done.
  const startAuth = () => run(async () => {
    const r = await api.post('/accounts/login/start', { provider, label: label.trim() || undefined });
    if (r?.state === 'error') throw new Error(r.error || t('launcher.account.startAuthError'));
    setAuth({ provider, ...r }); setCode(''); setAddMode('auth');
    if (r?.url) { try { window.open(r.url, '_blank', 'noopener'); } catch { /* user clicks the link */ } }
  });
  const submitCode = () => run(async () => {
    const r = await api.post('/accounts/login/code', { id: auth?.id, code: code.trim() });
    if (!r?.ok) { setAuth((a) => ({ ...(a || {}), state: 'error', error: r?.error || t('launcher.account.exchangeFailed') })); return; }
    // Codex: the host forwarded the callback; codex now exchanges the code and
    // exits — the poller below sees 'verifying' → 'done'. Claude: done here.
    if (auth?.provider === 'codex') { setAuth((a) => ({ ...(a || {}), state: 'verifying' })); setCode(''); return; }
    resetAdd();
  });
  const cancelAuth = () => {
    if (auth?.id) api.post('/accounts/login/cancel', { id: auth.id }).catch(() => {});
    resetAdd();
  };
  // Codex device flow: the URL/code may arrive a moment after start, and the
  // finish happens in the browser — poll the flow until it is done or failed.
  const pollable = auth?.provider === 'codex' && ['starting', 'awaiting', 'verifying'].includes(auth?.state);
  useEffect(() => {
    if (!pollable) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } return undefined; }
    const tick = async () => {
      try {
        const r = await api.get(`/accounts/login/status?id=${encodeURIComponent(auth.id)}`);
        if (!r) return;
        // Open the sign-in page once the URL is known (start() may have returned before codex printed it).
        if (r.url && !auth.url) { try { window.open(r.url, '_blank', 'noopener'); } catch { /* link */ } }
        setAuth((a) => ({ ...(a || {}), ...r }));
        if (r.state === 'done') { toastSuccess(t('launcher.account.codexDone')); resetAdd(); await loadAccounts(); }
      } catch { /* transient — keep polling */ }
    };
    pollRef.current = setInterval(tick, 2000);
    tick();
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollable, auth?.id]);

  const P = catalog[provider] || PROVIDERS[DEFAULT_PROVIDER];
  const usageOf = (a) => accountUsage?.[a.id] || snapshotUsage(a);
  // Group by provider, in catalog order; a provider with no account gets one
  // explanatory line so "why can't my codex session start" is answered here.
  const groups = Object.keys(catalog).map((id) => ({ id, p: catalog[id], items: list.filter((a) => providerOf(a) === id) }));
  const present = groups.filter((g) => g.items.length);

  return (
    <Section id="claude" title={t('settings.connections.claude')}>
      <div className="mb-2 text-[11px] text-fgdim">{t('launcher.account.subtitle')}</div>
      <ErrorLine>{err}</ErrorLine>
      {present.map((g) => (
        <div key={g.id} data-provider-group={g.id} className="mb-3">
          {present.length > 1 && (
            <div className="mb-1.5 flex items-center gap-2 text-[11.5px] font-bold text-fg">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: g.p.dot || '#888' }} />
              {t('launcher.account.groupHeading', { provider: g.p.label })}
            </div>
          )}
          {g.items.map((a) => (
            <AccountCard key={a.id} account={a} usage={usageOf(a)} busy={busy} catalog={catalog} onSetActive={setActive} onSetPool={setPool} onRemove={remove} />
          ))}
        </div>
      ))}
      {accounts && list.length === 0 && (
        <div className="mb-2 rounded-xl border border-hair bg-panel px-3 py-4 text-center text-[12px] text-fgdim">{t('launcher.account.emptyList')}</div>
      )}
      {accounts && list.length > 0 && groups.filter((g) => !g.items.length).map((g) => (
        <div key={g.id} data-provider-empty={g.id} className="mb-2 text-[11px] text-fgdim">{t('launcher.account.noneForProvider', { provider: g.p.label })}</div>
      ))}

      {addMode === null && (
        <div className="flex flex-wrap gap-2">
          <button type="button" data-add-account onClick={() => setAddMode('choose')} className="rounded-xl border border-dashed border-border px-3 py-2 text-[12px] text-fgdim hover:border-ink hover:text-fg">
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
          <ProviderPicker catalog={catalog} value={provider} onChange={setProvider} />
          <p className="mt-2 text-[11px] leading-snug text-fgdim">{provider === 'codex' ? t('launcher.account.codexAddBody') : t('launcher.account.addBody')}</p>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('launcher.account.labelPlaceholder')} className={INPUT} />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {P.methods?.some((m) => m.id === 'browser') && (
              <button type="button" data-auth-browser disabled={busy} onClick={startAuth} className={PRIMARY}>
                {provider === 'codex' ? t('launcher.account.codexBrowser') : t('launcher.account.authBrowser')}
              </button>
            )}
            {P.methods?.some((m) => m.id === 'paste') && (
              <button type="button" data-auth-paste onClick={() => setAddMode('paste')} className={GHOST}>
                {provider === 'codex' ? t('launcher.account.codexPasteKey') : t('launcher.account.pasteInstead')}
              </button>
            )}
            <button type="button" onClick={resetAdd} className="ms-auto text-[11.5px] text-fgdim hover:text-fg">{t('launcher.account.cancel')}</button>
          </div>
        </div>
      )}

      {addMode === 'auth' && auth?.provider === 'codex' && (
        <div className="rounded-xl border border-hair bg-panel p-3" data-codex-device-flow data-state={auth.state}>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-bold text-fg">
            <ProviderBadge provider="codex" catalog={catalog} />
            {t('launcher.account.addAccountTitle')}{label ? ` · ${label}` : ''}
          </div>
          {auth.state === 'starting' && <p className="mt-1.5 text-[11.5px] text-fgdim">{t('launcher.account.codexStarting')}</p>}
          {auth.state === 'verifying' && <p className="mt-1.5 text-[11.5px] text-fgdim">{t('launcher.account.codexVerifying')}</p>}
          {auth.state === 'awaiting' && (
            <>
              <ol className="mt-1.5 ms-4 list-decimal text-[11.5px] leading-relaxed text-fgdim">
                <li>
                  {t('launcher.account.codexStep1')}
                  {auth.url && <> — <a href={auth.url} target="_blank" rel="noreferrer" className="text-[#2C6BD6] underline">{t('launcher.account.openSignIn')}</a></>}
                  {t('launcher.account.codexStep1b')}
                </li>
                <li>{t('launcher.account.codexStep2')}</li>
              </ol>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) submitCode(); }}
                placeholder={t('launcher.account.codexCallbackPlaceholder')}
                spellCheck={false}
                autoFocus
                dir="ltr"
                data-codex-callback
                className={`${INPUT} font-mono text-[11.5px]`}
              />
              <p className="mt-1.5 text-[11px] text-fgdim">{t('launcher.account.codexCallbackHint')}</p>
            </>
          )}
          {auth.state === 'error' && <p className="mt-1.5 text-[11.5px] text-[#B23B30]">{auth.error || t('launcher.account.startAuthError')}</p>}
          <div className="mt-2.5 flex items-center gap-2">
            {auth.state === 'awaiting' && <button type="button" disabled={busy || !code.trim()} onClick={submitCode} className={PRIMARY}>{busy ? t('launcher.account.finishing') : t('launcher.account.finish')}</button>}
            {auth.state === 'error' && <button type="button" disabled={busy} onClick={startAuth} className={PRIMARY}>{t('launcher.account.codexBrowser')}</button>}
            <button type="button" onClick={cancelAuth} className="text-[11.5px] text-fgdim hover:text-fg">{t('launcher.account.cancel')}</button>
          </div>
        </div>
      )}

      {addMode === 'auth' && auth?.provider !== 'codex' && (
        <div className="rounded-xl border border-hair bg-panel p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-bold text-fg">
            <ProviderBadge provider="claude" catalog={catalog} />
            {t('launcher.account.addAccountTitle')}{label ? ` · ${label}` : ''}
          </div>
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
        <div className="rounded-xl border border-hair bg-panel p-3" data-paste-flow data-provider={provider}>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-bold text-fg">
            <ProviderBadge provider={provider} catalog={catalog} />
            {provider === 'codex' ? t('launcher.account.codexPasteTitle') : t('launcher.account.pasteTitle')}
          </div>
          {provider === 'codex' ? (
            <p className="mt-1 text-[11px] leading-snug text-fgdim">{t('launcher.account.codexPasteBody')}</p>
          ) : (
            <p className="mt-1 text-[11px] leading-snug text-fgdim">
              {t('launcher.account.pasteBodyA')} <code className="rounded bg-chip px-1 font-mono">claude setup-token</code> {t('launcher.account.pasteBodyB')}{' '}
              <code className="font-mono">sk-ant-oat…</code> {t('launcher.account.pasteBodyC')}
            </p>
          )}
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('launcher.account.labelPlaceholder')} className={INPUT} />
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={P.pasteHint || 'sk-…'} spellCheck={false} className={`${INPUT} font-mono text-[11.5px]`} dir="ltr" />
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" disabled={busy || !token.trim()} onClick={add} className={PRIMARY}>{busy ? t('launcher.account.finishing') : t('launcher.account.addAccountBtn')}</button>
            <button type="button" onClick={() => setAddMode('choose')} className="text-[11.5px] text-fgdim hover:text-fg">{t('launcher.account.back')}</button>
          </div>
        </div>
      )}

      {footer && <AccountsFooter />}
    </Section>
  );
}
