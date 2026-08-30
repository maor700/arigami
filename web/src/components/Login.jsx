import { useState } from 'react';
import { afterLogin } from '../lib/store.js';
import { useT } from '../lib/i18n.js';

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
      <span className="mb-4 flex items-end gap-0.5" aria-hidden="true">
        {[14, 22, 17, 26].map((h, i) => (
          <span key={i} className="inline-block w-1 bg-brand" style={{ height: h }} />
        ))}
      </span>
      <div className="mb-1 text-[26px] leading-tight font-bold">{t('auth.login.heading')}</div>
      <div className="mb-4 max-w-[360px] text-center text-[11.5px] text-fgdim">
        {hasAdmin ? t('auth.login.subPaired') : t('auth.login.subFirst')}
        {!hasAdmin && <div className="mt-1.5 text-[11px] leading-relaxed text-fgdim">{t('auth.login.whereCode')}</div>}
      </div>

      {oidc && (
        <button
          type="button"
          onClick={oidcStart}
          className="mb-4 w-[320px] max-w-[90%] cursor-pointer rounded-[10px] border-[1.5px] border-ink bg-panel px-4 py-2.5 text-sm font-bold text-fg hover:bg-brand"
        >
          {t('auth.login.oidc')}
        </button>
      )}

      <div className="flex w-[320px] max-w-[90%] flex-col gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          className="rounded-[10px] border-[1.5px] border-ink bg-panel px-[13px] py-2.5 text-center font-mono text-base tracking-[0.2em] outline-none placeholder:text-fgdim focus:shadow-[2px_2px_0_rgba(42,42,42,0.16)]"
        />
        {!hasAdmin && (
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={t('auth.login.emailPlaceholder')}
            type="email"
            autoComplete="email"
            className="rounded-[10px] border-[1.5px] border-ink bg-panel px-[13px] py-2 text-xs outline-none placeholder:text-fgdim"
          />
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !code.trim()}
          className="cursor-pointer rounded-[10px] bg-ink px-4 py-2.5 text-sm font-bold text-bg disabled:cursor-default disabled:opacity-40"
        >
          {busy ? t('auth.login.busy') : t('auth.login.pair')}
        </button>
      </div>
      {error && <div className="mt-3 max-w-[360px] text-center text-[11.5px] text-[#9c3b33]">{error}</div>}
      <div className="mt-6 max-w-[360px] text-center font-mono text-[10px] text-fgdim">{t('auth.login.hint')}</div>
    </div>
  );
}
