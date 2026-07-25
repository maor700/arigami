// Accounts — a global, app-level page (opened from the Rail profile dropdown)
// for the Claude accounts the host runs sessions on. Set which account is active
// (the default for new sessions), toggle which accounts the auto-switch pool may
// rotate to, watch each account's live usage, and add/remove token accounts.
// Backend: server/accounts.js + /__api/accounts. Usage comes from the store's
// per-account 'account-usage' broadcasts (see server/usage.js).
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { toastSuccess } from '../lib/toast.js';
import { confirmDialog } from '../lib/confirm.js';
import { useStore, loadAccounts } from '../lib/store.js';
import { UsageBar } from './Usage.jsx';
import { untilTime } from '../lib/time.js';
import { Icon } from '../lib/icons.js';
import { faUser } from '@fortawesome/free-solid-svg-icons';

const TYPE_LABEL = { keychain: 'macOS login', 'oauth-token': 'setup-token' };

function StateBadge({ account, usage }) {
  const cooling = account.quarantineUntil && Date.parse(account.quarantineUntil) > Date.now();
  if (cooling) {
    return (
      <span className="rounded-full bg-[#B23B30]/15 px-2 py-0.5 text-[10px] font-bold text-[#B23B30]">
        cooling down · resets in {untilTime(account.quarantineUntil)}
      </span>
    );
  }
  if (usage?.available && (usage.session?.pct ?? 0) >= 100) {
    return <span className="rounded-full bg-[#B23B30]/15 px-2 py-0.5 text-[10px] font-bold text-[#B23B30]">at session limit</span>;
  }
  if (usage && !usage.available) {
    const dead = usage.reason === 'http-401';
    // 403 = the token authenticates but lacks user:profile scope (old
    // inference-only login) — sessions run fine, only usage is blind.
    const noScope = usage.reason === 'http-403';
    const throttled = usage.reason === 'usage-throttled';
    if (throttled) return null; // transient endpoint hiccup — say nothing
    return (
      <span className="rounded-full bg-chip px-2 py-0.5 text-[10px] text-fgdim">
        {dead
          ? 'token invalid — re-add'
          : noScope
            ? 'usage needs re-login (old token scope)'
            : usage.reason === 'no-credentials'
              ? 'not signed in'
              : 'unavailable'}
      </span>
    );
  }
  return <span className="rounded-full bg-[#3C9A4E]/15 px-2 py-0.5 text-[10px] font-bold text-[#3C9A4E]">available</span>;
}

function AccountCard({ account, usage, busy, onSetActive, onSetPool, onRemove }) {
  const initial = ((account.label || '').trim()[0] || '?').toUpperCase();
  return (
    <div className={`rounded-[10px] border p-3.5 ${account.active ? 'border-ink bg-chip/40' : 'border-hair bg-panel'}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-chip text-[14px] font-bold text-fg">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-bold text-fg">{account.label}</span>
            {account.active && (
              <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-bold text-panel">active</span>
            )}
            <span className="rounded-full border border-hair px-2 py-0.5 text-[10px] text-fgdim">
              {TYPE_LABEL[account.type] || account.type}
            </span>
            <StateBadge account={account} usage={usage} />
          </div>
          {account.email || account.org || account.plan ? (
            <div className="mt-0.5 text-[11px] text-fgdim">
              {[account.email, account.org, account.plan].filter(Boolean).join(' · ')}
            </div>
          ) : account.type === 'oauth-token' ? (
            <div className="mt-0.5 text-[10.5px] text-fgdim">
              browser token · identity not exposed by this token type
            </div>
          ) : null}
        </div>
      </div>

      {usage?.available && (usage.session || usage.week) ? (
        <div className="mt-2 pl-12">
          <UsageBar label="Session (5h)" win={usage.session} sub />
          <UsageBar label="Week (all models)" win={usage.week} sub />
        </div>
      ) : usage && !usage.available && usage.reason === 'http-403' ? (
        <div className="mt-2 pl-12 font-mono text-[10.5px] text-fgdim">
          usage hidden for this token — remove &amp; re-add the account to grant the new login scope
        </div>
      ) : (
        <div className="mt-2 pl-12 font-mono text-[10.5px] text-fgdim">checking usage…</div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-12">
        {!account.active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetActive(account.id)}
            className="rounded-[6px] border border-border px-2.5 py-1 text-[11.5px] text-fg hover:border-ink disabled:opacity-50"
          >
            Set active
          </button>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-fgdim">
          <input
            type="checkbox"
            checked={!!account.pool}
            disabled={busy}
            onChange={(e) => onSetPool(account.id, e.target.checked)}
          />
          In auto-switch pool
        </label>
        {account.type !== 'keychain' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(account)}
            className="ml-auto rounded-[6px] border border-border px-2.5 py-1 text-[11.5px] text-[#B23B30] hover:border-[#B23B30] disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export default function AccountsView({ onClose, initialAdd = false }) {
  const { accounts, accountUsage } = useStore();
  const list = accounts?.accounts || [];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [addMode, setAddMode] = useState(null); // null | 'choose' | 'auth' | 'paste'
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [authId, setAuthId] = useState(null);
  const [auth, setAuth] = useState(null); // { state, url, needsCode, error }
  const [code, setCode] = useState('');

  useEffect(() => {
    loadAccounts();
  }, []);

  // Opened straight into the add/auth flow (e.g. from the /mcp panel).
  useEffect(() => {
    if (initialAdd) setAddMode('choose');
  }, [initialAdd]);

  const run = async (fn) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await loadAccounts();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const setActive = (id) => run(() => api.post('/accounts/active', { id }));
  const setPool = (id, pool) => run(() => api.post('/accounts/pool', { id, pool }));
  const remove = async (account) => {
    const ok = await confirmDialog({
      title: `Remove "${account.label || 'this account'}"?`,
      body: 'Sessions on it fall back to the active account on their next restart.',
      confirmLabel: 'Remove account',
      danger: true,
    });
    if (!ok) return;
    run(async () => {
      await api.post('/accounts/remove', { id: account.id });
      toastSuccess('Account removed');
    });
  };
  const add = () =>
    run(async () => {
      await api.post('/accounts', { label: label.trim() || undefined, token: token.trim() });
      setAddMode(null);
      setLabel('');
      setToken('');
    });

  // Self-driven OAuth: mint the consent URL, open it, then take the code the
  // user pastes and exchange it server-side for a token. No terminal, no polling.
  const startAuth = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/accounts/oauth/start', { label: label.trim() || undefined });
      if (r?.state === 'error') throw new Error(r.error || 'could not start authentication');
      setAuth(r); // { id, url, state: 'awaiting-code' }
      setAuthId(r.id);
      setCode('');
      setAddMode('auth');
      try { window.open(r.url, '_blank', 'noopener'); } catch { /* user clicks the link */ }
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/accounts/oauth/code', { id: authId, code: code.trim() });
      if (!r?.ok) {
        setAuth((a) => ({ ...(a || {}), state: 'error', error: r?.error || 'token exchange failed' }));
        return;
      }
      setAuthId(null);
      setAuth(null);
      setAddMode(null);
      setLabel('');
      setCode('');
      await loadAccounts();
    } catch (e) {
      setAuth((a) => ({ ...(a || {}), state: 'error', error: e?.message || String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const cancelAuth = () => {
    if (authId) api.post('/accounts/oauth/cancel', { id: authId }).catch(() => {});
    setAuthId(null);
    setAuth(null);
    setCode('');
    setAddMode(null);
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center gap-2 border-b border-hair px-4 py-2.5">
        <span className="text-[14px]"><Icon icon={faUser} /></span>
        <span className="text-[13.5px] font-bold text-fg">Accounts</span>
        <span className="text-[11px] text-fgdim">· which Claude login the host runs sessions on</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-[6px] border border-border px-2.5 py-1 text-[11.5px] text-fgdim hover:border-ink hover:text-fg"
        >
          Close
        </button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[620px] flex-col gap-3">
          {err && (
            <div className="rounded-[8px] border border-[#B23B30]/40 bg-[#B23B30]/10 px-3 py-2 text-[11.5px] text-[#B23B30]">
              {err}
            </div>
          )}

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
            <div className="rounded-[8px] border border-hair bg-panel px-3 py-4 text-center text-[12px] text-fgdim">
              No accounts yet. Add one below.
            </div>
          )}

          {addMode === null && (
            <button
              type="button"
              onClick={() => setAddMode('choose')}
              className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[12px] text-fgdim hover:border-ink hover:text-fg"
            >
              + Add account
            </button>
          )}

          {addMode === 'choose' && (
            <div className="rounded-[10px] border border-hair bg-panel p-3.5">
              <div className="text-[12.5px] font-bold text-fg">Add an account</div>
              <p className="mt-1 text-[11px] leading-snug text-fgdim">
                Sign in through your browser — the token is created and stored automatically. Make sure the browser is
                logged into the Claude account you want to add.
              </p>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. Work · Acme)"
                className="mt-2.5 w-full rounded-[6px] border border-border bg-bg px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-ink"
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={startAuth}
                  className="rounded-[6px] bg-ink px-3 py-1.5 text-[12px] font-bold text-panel hover:opacity-90 disabled:opacity-40"
                >
                  🔓 Authenticate with browser
                </button>
                <button
                  type="button"
                  onClick={() => setAddMode('paste')}
                  className="rounded-[6px] border border-border px-3 py-1.5 text-[11.5px] text-fgdim hover:border-ink hover:text-fg"
                >
                  Paste a token instead
                </button>
                <button
                  type="button"
                  onClick={() => { setAddMode(null); setLabel(''); }}
                  className="ml-auto text-[11.5px] text-fgdim hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {addMode === 'auth' && (
            <div className="rounded-[10px] border border-hair bg-panel p-3.5">
              <div className="text-[12.5px] font-bold text-fg">Add account{label ? ` · ${label}` : ''}</div>
              <ol className="mt-1.5 ml-4 list-decimal text-[11.5px] leading-relaxed text-fgdim">
                <li>
                  Approve in the browser
                  {auth?.url && (
                    <>
                      {' — '}
                      <a href={auth.url} target="_blank" rel="noreferrer" className="text-[#2C6BD6] underline">
                        open the sign-in page ↗
                      </a>
                    </>
                  )}
                  . Sign in as the account you want to add.
                </li>
                <li>Copy the code it shows you and paste it below.</li>
              </ol>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) submitCode(); }}
                placeholder="Paste the code (looks like abc123…#xyz)"
                spellCheck={false}
                autoFocus
                className="mt-2.5 w-full rounded-[6px] border border-border bg-bg px-2.5 py-1.5 font-mono text-[11.5px] text-fg outline-none focus:border-ink"
              />
              {auth?.state === 'error' && (
                <p className="mt-1.5 text-[11.5px] text-[#B23B30]">{auth.error || 'Token exchange failed — try again.'}</p>
              )}
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || !code.trim()}
                  onClick={submitCode}
                  className="rounded-[6px] bg-ink px-3 py-1.5 text-[12px] font-bold text-panel hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? 'Finishing…' : 'Finish'}
                </button>
                <button type="button" onClick={cancelAuth} className="text-[11.5px] text-fgdim hover:text-fg">Cancel</button>
              </div>
            </div>
          )}

          {addMode === 'paste' && (
            <div className="rounded-[10px] border border-hair bg-panel p-3.5">
              <div className="text-[12.5px] font-bold text-fg">Paste a token</div>
              <p className="mt-1 text-[11px] leading-snug text-fgdim">
                Run <code className="rounded bg-chip px-1 font-mono">claude setup-token</code> yourself and paste the{' '}
                <code className="font-mono">sk-ant-oat…</code> token here.
              </p>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. Work · Acme)"
                className="mt-2.5 w-full rounded-[6px] border border-border bg-bg px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-ink"
              />
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="sk-ant-oat01-…"
                spellCheck={false}
                className="mt-2 w-full rounded-[6px] border border-border bg-bg px-2.5 py-1.5 font-mono text-[11.5px] text-fg outline-none focus:border-ink"
              />
              <div className="mt-2.5 flex items-center gap-2">
                <button type="button" disabled={busy || !token.trim()} onClick={add} className="rounded-[6px] bg-ink px-3 py-1.5 text-[12px] font-bold text-panel hover:opacity-90 disabled:opacity-40">Add account</button>
                <button type="button" onClick={() => setAddMode('choose')} className="text-[11.5px] text-fgdim hover:text-fg">Back</button>
              </div>
            </div>
          )}

          <p className="mt-1 px-1 text-[10.5px] leading-snug text-fgdim">
            <b>Active</b> is the default account for new sessions. The <b>auto-switch pool</b> is the set of accounts a
            session may rotate to when its account hits a limit. Switching an account never exposes its token.
          </p>
        </div>
      </div>
    </div>
  );
}
