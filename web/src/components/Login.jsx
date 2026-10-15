import { useEffect, useState } from 'react';
import { afterLogin } from '../lib/store.js';
import { useT, currentLang } from '../lib/i18n.js';
import { setPrefs } from '../lib/prefs.js';
import { Logo } from './Logo.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { canShellSignIn, shellSignIn, shellSignInOnce } from '../lib/shell.js';

// C1 — full-page sign-in. Pairing: the one-time code printed by the host at
// boot (or `bin/host pair`). OIDC: a redirect to /__api/auth/oidc/start when the
// host has a provider configured. Success → afterLogin() boots the store.
// `inline code` in a locale string → <code dir="ltr"> so a command keeps its own direction inside Hebrew text.
function Rich({ text }) {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i} dir="ltr" className="whitespace-nowrap rounded-sm bg-muted px-1 font-mono text-xs">{part}</code> : part));
}

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
      setCode(''); // the wrong code must not linger in the field
      setBusy(false);
    }
  };

  const oidcStart = () => {
    const redirect = encodeURIComponent(window.location.pathname + window.location.hash);
    window.location.href = `/__api/auth/oidc/start?redirect=${redirect}`;
  };

  const lang = currentLang();
  return (
    <div className="relative flex h-screen flex-col items-center justify-center overflow-y-auto bg-bg p-6 text-fg">
      <Button variant="outline" size="sm" onClick={() => setPrefs({ language: lang === 'he' ? 'en' : 'he' })} className="absolute end-3 top-3">
        {lang === 'he' ? 'English' : 'עברית'}
      </Button>
      <Logo size="3rem" className="mb-4" />
      <div className="mb-1 text-2xl leading-tight font-semibold tracking-tight">{t('auth.login.heading')}</div>
      <div className="mb-5 max-w-[22.5rem] text-center text-sm text-fgdim">
        {hasAdmin ? <Rich text={t('auth.login.subPaired')} /> : t('auth.login.subFirst')}
        {!hasAdmin && <div className="mt-1.5 hidden text-xs leading-relaxed text-fgdim md:block"><Rich text={t('auth.login.whereCode')} /></div>}
        {!hasAdmin && <div className="mt-1.5 text-xs leading-relaxed text-fgdim md:hidden">{t('auth.login.phoneHint')}</div>}
      </div>

      {shellSignin && (
        <Button size="lg" onClick={shellSignIn} className="mb-4 w-[20rem] max-w-[90%]">
          {t('auth.login.shellSignin')}
        </Button>
      )}

      {oidc && (
        <Button size="lg" onClick={oidcStart} className="mb-4 w-[20rem] max-w-[90%]">
          {t('auth.login.oidc')}
        </Button>
      )}

      <div className="flex w-[20rem] max-w-[90%] flex-col gap-3">
        <Input
          value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); if (error) setError(null); }}
          dir="ltr"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          className="h-10 text-center font-mono text-base tracking-[0.2em] coarse:h-11"
        />
        {!hasAdmin && (
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={t('auth.login.emailPlaceholder')}
            type="email"
            autoComplete="email"
            className="h-10 coarse:h-11"
          />
        )}
        <Button variant="primary" size="lg" onClick={submit} disabled={busy || !code.trim()}>
          {busy ? t('auth.login.busy') : t('auth.login.pair')}
        </Button>
      </div>
      {error && <div role="alert" className="mt-3 max-w-[22.5rem] text-center text-xs text-err">{error}</div>}
      <div className="mt-6 max-w-[22.5rem] text-center text-xs text-fgdim">{t('auth.login.hint')}</div>
    </div>
  );
}
