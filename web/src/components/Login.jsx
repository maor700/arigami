import { useEffect, useState } from 'react';
import { afterLogin } from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import { Logo } from './Logo.jsx';
import { canShellSignIn, shellSignIn, shellSignInOnce } from '../lib/shell.js';

// C1 — full-page sign-in. Pairing: the one-time code printed by the host at
// boot (or `bin/host pair`). OIDC: a redirect to /__api/auth/oidc/start when the
// host has a provider configured. Success → afterLogin() boots the store.
export default function Login({ info }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const hasAdmin = !!info?.hasAdmin;
  const oidc = !!info?.oidc;
  // Desktop shell, local machine: nobody should ever be asked for a pairing
  // code on the computer the app is installed on — the code is printed to a
  // log file an installed app gives no way to open. The shell mints a
  // single-use handoff token instead (docs/DESKTOP.md decision #6). This runs
  // here, and not only on first boot, because a full import replaces
  // users.json and sessions.json and restarts the host: the cookie dies with
  // no navigation to hang the handoff on, and this screen is where the user
  // lands. Reported live.
  const shellSignin = canShellSignIn();
  useEffect(() => { shellSignInOnce(); }, []);

  const submit = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/__api/auth/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), email: email.trim() || undefined }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      await afterLogin();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  const oidcStart = () => {
    const redirect = encodeURIComponent(window.location.pathname + window.location.hash);
    window.location.href = `/__api/auth/oidc/start?redirect=${redirect}`;
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-bg p-6 text-fg">
      <Logo size="3rem" className="mb-4" />
      <div className="mb-1 text-[1.625rem] leading-tight font-bold">{t('auth.login.heading')}</div>
      <div className="mb-4 max-w-[22.5rem] text-center text-[0.71875rem] text-fgdim">
        {hasAdmin ? t('auth.login.subPaired') : t('auth.login.subFirst')}
        {!hasAdmin && <div className="mt-1.5 text-[0.6875rem] leading-relaxed text-fgdim">{t('auth.login.whereCode')}</div>}
      </div>

      {shellSignin && (
        <button
          type="button"
          onClick={shellSignIn}
          className="mb-4 w-[20rem] max-w-[90%] cursor-pointer rounded-[10px] border-[1.5px] border-ink bg-panel px-4 py-2.5 text-sm font-bold text-fg hover:bg-brand"
        >
          {t('auth.login.shellSignin')}
        </button>
      )}

      {oidc && (
        <button
          type="button"
          onClick={oidcStart}
          className="mb-4 w-[20rem] max-w-[90%] cursor-pointer rounded-[10px] border-[1.5px] border-ink bg-panel px-4 py-2.5 text-sm font-bold text-fg hover:bg-brand"
        >
          {t('auth.login.oidc')}
        </button>
      )}

      <div className="flex w-[20rem] max-w-[90%] flex-col gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          className="rounded-[10px] border-[1.5px] border-ink bg-panel px-[0.8125rem] py-2.5 text-center font-mono text-base tracking-[0.2em] outline-none placeholder:text-fgdim focus:shadow-[2px_2px_0_rgba(42,42,42,0.16)]"
        />
        {!hasAdmin && (
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={t('auth.login.emailPlaceholder')}
            type="email"
            autoComplete="email"
            className="rounded-[10px] border-[1.5px] border-ink bg-panel px-[0.8125rem] py-2 text-xs outline-none placeholder:text-fgdim"
          />
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !code.trim()}
          className="cursor-pointer rounded-[10px] border-[1.5px] border-ink bg-brand px-4 py-2.5 text-sm font-bold text-[#1a1a1a] disabled:cursor-default disabled:opacity-40"
        >
          {busy ? t('auth.login.busy') : t('auth.login.pair')}
        </button>
      </div>
      {error && <div className="mt-3 max-w-[22.5rem] text-center text-[0.71875rem] text-[#9c3b33]">{error}</div>}
      <div className="mt-6 max-w-[22.5rem] text-center font-mono text-[0.625rem] text-fgdim">{t('auth.login.hint')}</div>
    </div>
  );
}
