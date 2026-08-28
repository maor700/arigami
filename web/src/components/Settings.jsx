import { useEffect, useRef, useState } from 'react';
import { usePrefs, setPrefs, PREF_LIMITS } from '../lib/prefs.js';
import { api } from '../lib/api.js';
import { subscribePush, unsubscribePush, isPushSubscribed } from '../lib/push.js';
import { Wave } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { LOGOS, LOGO_IDS, DEFAULT_ACCENT } from '../lib/logos.js';
import { useT } from '../lib/i18n.js';
import { LANGS, LANG_IDS } from '../lib/langs.js';

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full border-[1.5px] border-ink transition-colors disabled:cursor-default disabled:opacity-40 ${on ? 'bg-brand' : 'bg-white'}`}
    >
      <span
        className="absolute top-[2px] h-[15px] w-[15px] rounded-full border border-ink bg-white transition-[left]"
        style={{ left: on ? 21 : 2 }}
      />
    </button>
  );
}

// Inline origami logo mark — facet fills follow --color-brand (the accent).
function LogoMark({ id, size = 20 }) {
  const preset = LOGOS[id] || LOGOS.crane;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      {preset.paths.map((p, i) => (
        <path key={i} d={p.d} fill="var(--color-brand)" fillOpacity={p.o} />
      ))}
    </svg>
  );
}

const LINK_BTN =
  'shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-brand';

function CopyRow({ url }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 border-b border-hair py-3">
      <code className="min-w-0 flex-1 truncate rounded-md border border-hair bg-bg px-2 py-1.5 font-mono text-[11px] text-fg">
        {url}
      </code>
      <button
        type="button"
        onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className={LINK_BTN}
      >
        {copied ? t('chrome.copy.copied') : t('chrome.copy.copy')}
      </button>
    </div>
  );
}

// Reach the cockpit from your phone over Tailscale — private to your devices,
// never a public URL. The direct tailnet URL works as soon as Tailscale is up;
// HTTPS serve is an optional upgrade (needs HTTPS Certificates on the tailnet).
function RemoteAccess() {
  const t = useT();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () =>
    api.get('/remote').then(setSt).catch(() => setSt({ available: false, reason: t('chrome.remote.unreachable') }));
  useEffect(() => { load(); }, []);

  const toggle = async (on) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/remote', { enable: on });
      setSt(r);
      setErr(r?.error || '');
    } catch (e) {
      setErr(String(e?.message || e));
    }
    setBusy(false);
  };

  return (
    <>
      <div className="mt-6 mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
        {t('chrome.remote.section')}
      </div>
      {!st ? (
        <div className="py-4 font-mono text-[11px] text-fgdim">{t('chrome.remote.checking')}</div>
      ) : !st.available ? (
        <Field label="Tailscale" hint={t('chrome.remote.notInstalled')}>
          <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className={LINK_BTN}>
            {t('chrome.remote.get')}
          </a>
        </Field>
      ) : !st.loggedIn ? (
        <Field label="Tailscale" hint={st.reason || t('chrome.remote.signInHint')}>
          <button type="button" onClick={load} className={LINK_BTN}>{t('chrome.remote.recheck')}</button>
        </Field>
      ) : (
        <>
          <div className="border-b border-hair py-4">
            <div className="text-[13px] font-bold text-fg">{t('chrome.remote.openOnPhone')}</div>
            <div className="mt-0.5 text-[11.5px] text-fgdim">
              {t('chrome.remote.openOnPhone.hint')}
            </div>
          </div>
          {st.directUrl && <CopyRow url={st.directUrl} />}

          <Field
            label={t('chrome.remote.https')}
            hint={
              st.serving
                ? t('chrome.remote.https.on')
                : t('chrome.remote.https.off')
            }
          >
            <Toggle on={!!st.serving} disabled={busy} onChange={toggle} />
          </Field>
          {st.serving && st.httpsUrl && <CopyRow url={st.httpsUrl} />}
          {err && (
            <div className="py-2 text-[11px] leading-snug text-danger">
              {err}{' '}
              <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" className="underline">
                {t('chrome.remote.adminConsole')}
              </a>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <span className="flex overflow-hidden rounded-lg border-[1.5px] border-ink">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`cursor-pointer px-3.5 py-1.5 text-[11.5px] ${i > 0 ? 'border-l-[1.5px] border-ink' : ''} ${
            value === opt.value ? 'bg-brand font-bold text-[#1a1a1a]' : 'bg-panel text-fgdim'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="flex items-center gap-4 border-b border-hair py-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] text-fgdim">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// Microphone device picker. Device labels are only exposed after the page has
// been granted mic permission once — until then we offer a one-tap "Allow" that
// requests access and re-enumerates, then lists the real device names.
function MicPicker({ value, onChange }) {
  const t = useT();
  const [devices, setDevices] = useState([]);
  const [needsPerm, setNeedsPerm] = useState(false);

  const enumerate = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all.filter((d) => d.kind === 'audioinput');
      setDevices(mics);
      // No labels means permission hasn't been granted yet.
      setNeedsPerm(mics.length > 0 && !mics.some((d) => d.label));
    } catch {
      setDevices([]);
    }
  };

  useEffect(() => {
    enumerate();
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerate);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grant = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await enumerate();
    } catch {
      /* permission denied — leave as default */
    }
  };

  if (needsPerm) {
    return (
      <button
        type="button"
        onClick={grant}
        className="shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-brand hover:text-[#1a1a1a]"
      >
        {t('chrome.voice.mic.allow')}
      </button>
    );
  }

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[220px] cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] text-fg outline-none focus:border-brand"
    >
      <option value="">{t('chrome.voice.mic.systemDefault')}</option>
      {devices.map((d, i) => (
        <option key={d.deviceId || i} value={d.deviceId}>
          {d.label || t('chrome.voice.mic.fallback', { n: i + 1 })}
        </option>
      ))}
    </select>
  );
}

function WhatsAppBridge() {
  const t = useT();
  const [status, setStatus] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const [error, setError] = useState(null);

  const load = () =>
    api.get('/whatsapp/status').then(setStatus).catch(() => setStatus({ status: 'disconnected', qrUrl: null, user: null }));

  useEffect(() => {
    load();
  }, []);

  // Poll whenever bridge is in a transient state
  useEffect(() => {
    clearInterval(pollRef.current);
    if (status?.status === 'qr' || status?.status === 'starting') {
      pollRef.current = setInterval(load, 3000);
    }
    return () => clearInterval(pollRef.current);
  }, [status?.status]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.post('/whatsapp/connect', {}));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try { await api.post('/whatsapp/disconnect', {}); } catch {}
    finally { setBusy(false); load(); }
  };

  const s = status?.status ?? 'disconnected';
  const dot =
    s === 'connected' ? 'bg-[#2f9c82]' :
    s === 'qr' || s === 'starting' ? 'bg-amber-400 animate-pulse' :
    'bg-fgdim';

  return (
    <>
      <div className="mt-6 mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
        WhatsApp
      </div>

      <div className="rounded-xl border border-hair bg-panel p-3">
        {/* Status row */}
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
          <span className="flex-1 text-[12px] text-fg">
            {s === 'connected'
              ? `Connected${status?.user ? ` · ${status.user}` : ''}`
              : s === 'qr'
              ? 'Waiting for QR scan…'
              : s === 'starting'
              ? 'Starting…'
              : 'Disconnected'}
          </span>
          {s === 'connected' ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="cursor-pointer rounded-lg border border-hair bg-white px-2.5 py-1 text-[10.5px] text-[#9c3b33] hover:bg-[#FBECEA] disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={busy || s === 'starting' || s === 'qr'}
              className="cursor-pointer rounded-lg border border-ink bg-brand px-2.5 py-1 text-[10.5px] font-bold text-fg hover:opacity-90 disabled:opacity-50"
            >
              {s === 'starting' ? 'Starting…' : s === 'qr' ? 'Scan QR' : 'Connect'}
            </button>
          )}
        </div>

        {/* QR code */}
        {s === 'qr' && status?.qrUrl && (
          <div className="mt-3 flex flex-col items-center gap-2 border-t border-hair pt-3">
            <p className="text-[11px] text-fgdim">Scan with WhatsApp on your phone</p>
            <img
              src={status.qrUrl}
              alt="WhatsApp QR code"
              className="h-[220px] w-[220px] rounded-lg border border-hair bg-white p-1"
            />
          </div>
        )}

        {/* QR pending but no URL yet */}
        {s === 'qr' && !status?.qrUrl && (
          <div className="mt-3 flex items-center justify-center gap-2 border-t border-hair pt-3 text-[11px] text-fgdim">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fgdim border-t-transparent" />
            Generating QR…
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-2 rounded-lg border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[11px] text-[#9c3b33]">
            {error}
          </div>
        )}
      </div>
    </>
  );
}

export default function Settings({ onClose }) {
  const prefs = usePrefs();
  const t = useT();
  const [fontMin, fontMax] = PREF_LIMITS.font;
  const [recordingHotkey, setRecordingHotkey] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (recordingHotkey) {
        e.preventDefault();
        e.stopPropagation();
        const parts = [];
        if (e.metaKey) parts.push('Cmd');
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
          parts.push(key);
        }
        if (parts.length > 1 || (parts.length === 1 && !['Cmd', 'Ctrl', 'Alt', 'Shift'].includes(parts[0]))) {
          setPrefs({ voiceHotkey: parts.join('+') });
          setRecordingHotkey(false);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, recordingHotkey]);

  const stepFont = (delta) =>
    setPrefs({ termFontSize: prefs.termFontSize + delta });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-[9px] border-b border-hair px-4">
        <Wave />
        <span className="text-sm font-bold text-fg">{t('settings.title')}</span>
        <button
          type="button"
          onClick={onClose}
          title={t('chrome.settings.closeTitle')}
          className="ml-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[560px] px-7 py-6">
          <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
            {t('settings.appearance')}
          </div>
          <Field label={t('settings.theme')} hint={t('settings.theme.hint')}>
            <Segmented
              value={prefs.theme}
              onChange={(v) => setPrefs({ theme: v })}
              options={[
                { value: 'light', label: t('common.light') },
                { value: 'dark', label: t('common.dark') },
              ]}
            />
          </Field>
          <Field label={t('settings.language')} hint={t('settings.language.hint')}>
            <select
              value={prefs.language}
              onChange={(e) => setPrefs({ language: e.target.value })}
              className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg"
            >
              <option value="auto">{t('settings.language.auto')}</option>
              {LANG_IDS.map((id) => (
                <option key={id} value={id}>
                  {LANGS[id].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.accent')} hint={t('settings.accent.hint')}>
            <span className="flex items-center gap-2">
              <label className="relative flex h-[26px] w-[38px] cursor-pointer items-center justify-center overflow-hidden rounded-lg border-[1.5px] border-ink">
                <span className="absolute inset-0" style={{ background: prefs.accent || DEFAULT_ACCENT }} />
                <input
                  type="color"
                  value={prefs.accent || DEFAULT_ACCENT}
                  onChange={(e) => setPrefs({ accent: e.target.value })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label={t('settings.accent')}
                />
              </label>
              <code className="font-mono text-[11px] text-fgdim">{prefs.accent || DEFAULT_ACCENT}</code>
              {prefs.accent ? (
                <button
                  type="button"
                  onClick={() => setPrefs({ accent: '' })}
                  className="cursor-pointer rounded-md border border-hair px-2 py-1 text-[10.5px] text-fgdim hover:border-ink hover:text-fg"
                >
                  {t('common.reset')}
                </button>
              ) : null}
            </span>
          </Field>
          <Field label={t('settings.logo')} hint={t('settings.logo.hint')}>
            <span className="flex items-center gap-1.5">
              {LOGO_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  title={LOGOS[id].label}
                  onClick={() => setPrefs({ logo: id })}
                  className={`flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg border-[1.5px] ${prefs.logo === id ? 'border-ink bg-chip' : 'border-hair hover:border-ink'}`}
                >
                  <LogoMark id={id} size={18} />
                </button>
              ))}
            </span>
          </Field>

          <div className="mt-6 mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
            {t('settings.terminal')}
          </div>
          <Field label={t('settings.fontSize')} hint={t('settings.fontSize.hint', { min: fontMin, max: fontMax })}>
            <span className="flex items-center overflow-hidden rounded-lg border-[1.5px] border-ink">
              <button
                type="button"
                onClick={() => stepFont(-1)}
                disabled={prefs.termFontSize <= fontMin}
                className="cursor-pointer bg-panel px-3 py-1.5 text-[11px] text-fg hover:bg-brand disabled:cursor-default disabled:opacity-40"
              >
                A−
              </button>
              <span className="border-x-[1.5px] border-ink bg-panel px-3 py-1.5 font-mono text-[11.5px] font-bold text-fg">
                {prefs.termFontSize}px
              </span>
              <button
                type="button"
                onClick={() => stepFont(1)}
                disabled={prefs.termFontSize >= fontMax}
                className="cursor-pointer bg-panel px-3 py-1.5 text-[13px] text-fg hover:bg-brand disabled:cursor-default disabled:opacity-40"
              >
                A+
              </button>
            </span>
          </Field>
          <Field label={t('settings.termTheme')} hint={t('settings.termTheme.hint')}>
            <Segmented
              value={prefs.termTheme}
              onChange={(v) => setPrefs({ termTheme: v })}
              options={[
                { value: 'light', label: t('common.light') },
                { value: 'dark', label: t('common.dark') },
              ]}
            />
          </Field>
          <Field label={t('settings.textDir')} hint={t('settings.textDir.hint')}>
            <Segmented
              value={prefs.termDir}
              onChange={(v) => setPrefs({ termDir: v })}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'ltr', label: t('common.ltr') },
                { value: 'rtl', label: t('common.rtl') },
              ]}
            />
          </Field>

          <div className="mt-6 mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
            {t('chrome.voice.section')}
          </div>
          <Field label={t('chrome.voice.mode')} hint={t('chrome.voice.mode.hint')}>
            <Segmented
              value={prefs.voiceMode}
              onChange={(v) => setPrefs({ voiceMode: v })}
              options={[
                { value: 'hold', label: t('chrome.voice.mode.hold') },
                { value: 'toggle', label: t('chrome.voice.mode.toggle') },
              ]}
            />
          </Field>
          <Field label={t('chrome.voice.mic')} hint={t('chrome.voice.mic.hint')}>
            <MicPicker value={prefs.voiceMicId} onChange={(v) => setPrefs({ voiceMicId: v })} />
          </Field>
          <Field label={t('settings.language')} hint={t('chrome.voice.language.hint')}>
            <Segmented
              value={prefs.voiceLanguage}
              onChange={(v) => setPrefs({ voiceLanguage: v })}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'en', label: t('chrome.voice.language.en') },
                { value: 'he', label: t('chrome.voice.language.he') },
              ]}
            />
          </Field>
          <Field label={t('chrome.voice.hotkey')} hint={t('chrome.voice.hotkey.hint')}>
            <span className="flex items-center gap-2">
              <input
                type="text"
                value={recordingHotkey ? t('chrome.voice.hotkey.pressKeys') : prefs.voiceHotkey}
                readOnly
                placeholder="Cmd+Shift+V"
                className="w-[140px] rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-center font-mono text-[11.5px] text-fg outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setRecordingHotkey((v) => !v)}
                className={`shrink-0 cursor-pointer rounded-lg border-[1.5px] px-3 py-1.5 text-[11.5px] font-bold transition-colors ${
                  recordingHotkey
                    ? 'border-brand bg-brand text-[#1a1a1a]'
                    : 'border-ink bg-panel text-fg hover:bg-brand hover:text-[#1a1a1a]'
                }`}
              >
                {recordingHotkey ? t('chrome.voice.hotkey.listening') : t('chrome.voice.hotkey.record')}
              </button>
            </span>
          </Field>
          <Field label={t('chrome.voice.autoSend')} hint={t('chrome.voice.autoSend.hint')}>
            <Toggle
              on={prefs.voiceAutoSend}
              onChange={(v) => setPrefs({ voiceAutoSend: v })}
            />
          </Field>

          <RemoteAccess />
          <WhatsAppBridge />
          <ScreenShare />
          <PushNotifications />
        </div>
      </div>
    </div>
  );
}

// Settings → Screen share: the VNC-auth password handed to the embedded
// noVNC viewer (ScreenView.jsx) on `credentialsrequired`. Write-only from the
// UI's point of view — the server only reports whether one is set.
function ScreenShare() {
  const t = useT();
  const [hasPassword, setHasPassword] = useState(null); // null = loading
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  useEffect(() => {
    api.get('/screen/settings')
      .then((r) => setHasPassword(!!r?.hasVncPassword))
      .catch(() => setHasPassword(false));
  }, []);
  const submit = async (pw) => {
    setBusy(true);
    try {
      const r = await api.put('/screen/settings', { vncPassword: pw });
      setHasPassword(!!r?.hasVncPassword);
      setValue('');
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } catch (e) {
      console.error('VNC password save error:', e);
    } finally {
      setBusy(false);
    }
  };
  if (hasPassword === null) return null;
  const btn = 'shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-brand hover:text-[#1a1a1a] disabled:opacity-50';
  return (
    <>
      <h3 className="mt-3 border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('settings.screenTitle')}
      </h3>
      <Field label={t('settings.vncPassword')} hint={t('settings.vncPassword.hint')}>
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
              className="w-[160px] rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 font-mono text-[11.5px] text-fg outline-none disabled:opacity-60"
            />
            <button type="button" disabled={busy || !value} onClick={() => submit(value)} className={btn}>
              {t('settings.vncPassword.save')}
            </button>
            {hasPassword && (
              <button type="button" disabled={busy} onClick={() => submit('')} className={btn}>
                {t('settings.vncPassword.clear')}
              </button>
            )}
          </span>
          <span className="font-mono text-[10.5px] text-fgdim">
            {savedTick ? t('settings.vncPassword.saved') : hasPassword ? t('settings.vncPassword.set') : t('settings.vncPassword.unset')}
          </span>
        </div>
      </Field>
    </>
  );
}

function PushNotifications() {
  const t = useT();
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => { isPushSubscribed().then(setOn).finally(() => setLoading(false)); }, []);
  const toggle = async (v) => {
    setLoading(true);
    try {
      if (v) await subscribePush();
      else await unsubscribePush();
      setOn(v);
    } catch (e) {
      console.error('Push toggle error:', e);
    } finally {
      setLoading(false);
    }
  };
  if (!('PushManager' in window)) return null;
  return (
    <>
      <h3 className="mt-3 border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('settings.pushTitle') || 'Push Notifications'}
      </h3>
      <Field label={t('settings.pushEnable') || 'Enable push notifications'} hint={t('settings.pushHint') || 'Get notified on your phone when listeners fire or Claude needs input'}>
        <Toggle on={on} onChange={toggle} disabled={loading} />
      </Field>
    </>
  );
}
