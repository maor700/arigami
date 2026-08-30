import { useEffect, useRef, useState } from 'react';
import { usePrefs, setPrefs, PREF_LIMITS } from '../lib/prefs.js';
import { api } from '../lib/api.js';
import { useStore, signOut } from '../lib/store.js';
import { subscribePush, unsubscribePush, isPushSubscribed } from '../lib/push.js';
import { Wave } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { LOGOS, LOGO_IDS, DEFAULT_ACCENT } from '../lib/logos.js';
import { useT } from '../lib/i18n.js';
import { confirmDialog } from '../lib/confirm.js';
import { toast, toastError } from '../lib/toast.js';
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

// Settings → Webhooks (C3): the sms share-token (URL for the phone's SMS
// forwarder, rotate/revoke), Slack/GitHub secrets, custom HMAC hooks, and the
// Tailscale Funnel toggle that exposes ONLY /__api/webhooks to the internet.
function WebhooksCard() {
  const t = useT();
  const { auth } = useStore();
  const [cfgv, setCfgv] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [secretDraft, setSecretDraft] = useState({ slack: '', github: '' });
  const [customId, setCustomId] = useState('');
  const [fresh, setFresh] = useState(null); // {id, secret, url} shown once
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';

  const load = () => {
    if (!admin) return;
    api.get('/webhooks/config').then(setCfgv).catch(() => setCfgv(null));
    api.get('/remote/funnel').then(setFunnel).catch(() => setFunnel(null));
  };
  useEffect(load, [admin]);
  if (!admin) return null;

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(String(e?.message || e)); toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  const rotate = () => run(async () => {
    if (cfgv?.sms && !(await confirmDialog(t('chrome.webhooks.sms.rotateConfirm')))) return;
    await api.post('/webhooks/token', {}); load();
  });
  const revoke = () => run(async () => { if (await confirmDialog(t('chrome.webhooks.sms.revokeConfirm'))) { await api.del('/webhooks/token'); load(); } });
  const saveSecret = (kind) => run(async () => { await api.put(`/webhooks/${kind}/secret`, { secret: secretDraft[kind] }); setSecretDraft((d) => ({ ...d, [kind]: '' })); load(); });
  const addCustom = () => run(async () => { const r = await api.post('/webhooks/custom', { id: customId.trim() }); setFresh(r); setCustomId(''); load(); });
  const delCustom = (id) => run(async () => { if (await confirmDialog(t('chrome.webhooks.custom.removeConfirm', { id }))) { await api.del(`/webhooks/custom/${id}`); load(); } });
  const toggleFunnel = (on) => run(async () => {
    if (on && !(await confirmDialog(t('chrome.webhooks.funnel.confirm')))) return;
    const r = await api.post('/remote/funnel', { enable: on });
    setFunnel(r); if (r?.error) setErr(r.error);
  });

  const btn = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1 text-[11px] text-fg hover:bg-brand disabled:opacity-40';
  const input = 'w-[180px] rounded-lg border-[1.5px] border-ink bg-panel px-2 py-1 font-mono text-[11px] text-fg outline-none';
  const row = 'flex items-center justify-between gap-2 border-b border-hair py-1.5 text-[11.5px] last:border-b-0';
  const sms = cfgv?.sms;
  return (
    <>
      <div className="mt-6 mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('chrome.webhooks.section')}</div>
      {!cfgv ? (
        <div className="py-4 font-mono text-[11px] text-fgdim">{t('chrome.webhooks.loading')}</div>
      ) : (
        <>
          {!cfgv.publicUrl && <div className="py-2 text-[11px] text-fgdim">{t('chrome.webhooks.noPublicUrl')}</div>}
          <Field
            label={t('chrome.webhooks.sms')}
            hint={sms ? (sms.live ? t('chrome.webhooks.sms.live', { date: new Date(sms.exp).toLocaleDateString() }) : t('chrome.webhooks.sms.expired')) : t('chrome.webhooks.sms.none')}
          >
            <span className="flex gap-2">
              <button type="button" disabled={busy} onClick={rotate} className={btn}>{sms ? t('chrome.webhooks.sms.rotate') : t('chrome.webhooks.sms.create')}</button>
              {sms && <button type="button" disabled={busy} onClick={revoke} className={btn}>{t('chrome.webhooks.sms.revoke')}</button>}
            </span>
          </Field>
          {sms && <CopyRow url={sms.url + '&from={sms_number}&body={sms_message}'} />}

          {['slack', 'github'].map((kind) => (
            <Field key={kind} label={t(`chrome.webhooks.${kind}`)} hint={`${cfgv[kind].url} · ${cfgv[kind].configured ? t('chrome.webhooks.secret.set', { source: cfgv[kind].source }) : t('chrome.webhooks.secret.missing')}`}>
              <span className="flex gap-2">
                <input type="password" autoComplete="off" value={secretDraft[kind]} onChange={(e) => setSecretDraft((d) => ({ ...d, [kind]: e.target.value }))} placeholder={t('chrome.webhooks.secret.placeholder')} className={input} disabled={cfgv[kind].source === 'env'} />
                <button type="button" disabled={busy || cfgv[kind].source === 'env'} onClick={() => saveSecret(kind)} className={btn}>{secretDraft[kind] ? t('chrome.webhooks.secret.save') : t('chrome.webhooks.secret.clear')}</button>
              </span>
            </Field>
          ))}

          <Field label={t('chrome.webhooks.custom')} hint={t('chrome.webhooks.custom.hint')}>
            <span className="flex gap-2">
              <input type="text" value={customId} onChange={(e) => setCustomId(e.target.value)} placeholder="my-hook" className={input} />
              <button type="button" disabled={busy || !/^[A-Za-z0-9_.-]{1,64}$/.test(customId.trim())} onClick={addCustom} className={btn}>{t('chrome.webhooks.custom.add')}</button>
            </span>
          </Field>
          {fresh && (
            <div className="border-b border-hair py-2 text-[11px]">
              <div className="text-fgdim">{t('chrome.webhooks.custom.once', { id: fresh.id })}</div>
              <CopyRow url={fresh.secret} />
              <CopyRow url={fresh.url} />
              <button type="button" onClick={() => setFresh(null)} className={btn}>{t('chrome.webhooks.custom.done')}</button>
            </div>
          )}
          {cfgv.custom.map((c) => (
            <div key={c.id} className={row}>
              <span className="min-w-0 flex-1 truncate font-mono">{c.path}{c.label ? ` · ${c.label}` : ''}</span>
              <button type="button" disabled={busy} onClick={() => delCustom(c.id)} className={btn}>{t('chrome.webhooks.custom.remove')}</button>
            </div>
          ))}

          {funnel?.loggedIn && (
            <Field label={t('chrome.webhooks.funnel')} hint={funnel.funnel ? t('chrome.webhooks.funnel.on', { url: funnel.funnelUrl || '' }) : t('chrome.webhooks.funnel.off')}>
              <Toggle on={!!funnel.funnel} disabled={busy} onChange={toggleFunnel} />
            </Field>
          )}
          {err && <div className="py-2 text-[11px] leading-snug text-danger">{err}</div>}
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
          <WebhooksCard />
          <WhatsAppBridge />
          <ScreenShare />
          <PushNotifications />
          <BrainHeartbeat />
          <TelemetryCard />
          <HostCard />
          <UsersCard />
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

// Settings → Brain heartbeat (M4.3): off by default. Toggling creates/removes
// the backing CronTrigger server-side (server/brain.ts setHeartbeat) — this
// component only reflects/drives that, it holds no state of its own beyond
// what GET /__api/brain returns.
function BrainHeartbeat() {
  const t = useT();
  const [status, setStatus] = useState(null); // null = loading
  const [every, setEvery] = useState('30m');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get('/brain')
      .then((r) => {
        setStatus(r.heartbeat);
        setEvery(r.heartbeat.every);
      })
      .catch(() => setStatus({ enabled: false, every: '30m' }));
  useEffect(() => { load(); }, []);

  const toggle = async (enabled) => {
    setBusy(true);
    try {
      const r = await api.put('/brain/heartbeat', { enabled, every });
      setStatus(r);
    } catch (e) {
      console.error('Brain heartbeat toggle error:', e);
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;
  return (
    <>
      <h3 className="mt-3 border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('brain.heartbeatTitle')}
      </h3>
      <Field label={t('brain.heartbeatTitle')} hint={t('brain.heartbeatHint')}>
        <Toggle on={status.enabled} onChange={toggle} disabled={busy} />
      </Field>
      <Field label={t('brain.heartbeatEvery')} hint={t('brain.heartbeatEveryHint')}>
        <input
          type="text"
          value={every}
          disabled={busy}
          onChange={(e) => setEvery(e.target.value)}
          onBlur={() => status.enabled && every.trim() && every !== status.every && toggle(true)}
          placeholder="30m"
          className="w-[100px] rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-center font-mono text-[11.5px] text-fg outline-none disabled:opacity-60"
        />
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

// Settings → Host (B4-lite): version/commit, restart now / when idle, upgrade.
// Mutations go through POST /__api/host/* with the X-Arigami-Confirm header
// (server/host-control.ts). Progress arrives as `host` bus events (store.js →
// state.hostEvent); the reconnect after the restart is what ws.onclose/onopen
// already do — we just toast "back" on the down→open transition.
function hostPost(path, method = 'POST', body) {
  const raw = body instanceof Blob;
  return fetch(`/__api${path}`, {
    method,
    headers: { 'Content-Type': raw ? 'application/gzip' : 'application/json', 'X-Arigami-Confirm': 'yes' },
    body: method === 'POST' ? (raw ? body : JSON.stringify(body ?? {})) : undefined,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(body?.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return body;
  });
}

function fmtUptime(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 90) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

// D3 — opt-in telemetry: toggle, "preview payload" (the exact JSON the host
// would POST next), and "reset anonymous ID" (= delete my data).
function TelemetryCard() {
  const t = useT();
  const { auth } = useStore();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';
  const load = () => api.get('/telemetry').then(setSt).catch(() => setSt(null));
  useEffect(() => { load(); }, []);
  const run = async (fn) => {
    setBusy(true);
    try { setSt(await fn()); } catch (e) { toastError(e?.message || String(e)); } finally { setBusy(false); }
  };
  const toggle = (on) => run(() => api.post('/telemetry', { enabled: on }));
  const rotate = async () => {
    if (!(await confirmDialog({ title: t('telemetry.rotate.confirmTitle'), body: t('telemetry.rotate.confirmBody'), confirmLabel: t('telemetry.rotate') }))) return;
    run(async () => { const r = await api.post('/telemetry/rotate', {}); toast(t('telemetry.rotated')); return r; });
  };
  const btn = 'shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-brand hover:text-[#1a1a1a] disabled:cursor-default disabled:opacity-50';
  const pinned = st && (st.reason === 'dnt' || st.reason === 'env');
  return (
    <>
      <h3 className="mt-3 border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('telemetry.title')}
      </h3>
      <Field
        label={t('telemetry.enable')}
        hint={st?.reason === 'dnt' ? t('telemetry.dnt') : st?.reason === 'env' ? t('telemetry.env', { state: st.enabled ? 'on' : 'off' }) : t('telemetry.hint')}
      >
        <Toggle on={!!st?.enabled} disabled={!st || busy || !admin || pinned} onChange={toggle} />
      </Field>
      <Field label={t('telemetry.preview')} hint={st?.lastSentAt ? t('telemetry.lastSent', { when: new Date(st.lastSentAt).toLocaleString(), n: st.pending }) : t('telemetry.neverSent', { n: st?.pending ?? 0 })}>
        <button type="button" className={btn} disabled={!st} onClick={() => setShow((v) => !v)}>{show ? t('telemetry.hidePreview') : t('telemetry.showPreview')}</button>
      </Field>
      {show && st?.preview && (
        <pre dir="ltr" className="mb-2 max-h-[260px] overflow-auto rounded-[8px] border border-hair bg-bg p-3 font-mono text-[10.5px] leading-snug text-fg">{JSON.stringify(st.preview, null, 2)}</pre>
      )}
      <Field label={t('telemetry.id')} hint={t('telemetry.id.hint')}>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-fgdim" dir="ltr">{st?.id ? st.id.slice(0, 8) + '…' : '…'}</span>
          <button type="button" className={btn} disabled={!st || busy || !admin} onClick={rotate}>{t('telemetry.rotate')}</button>
        </span>
      </Field>
      {st?.lastError && <div className="py-1 font-mono text-[10.5px] text-fgdim">{t('telemetry.lastError', { error: st.lastError })}</div>}
    </>
  );
}

// B4-full — Settings → Host → Export / Import (server/backup.ts). Export is a
// plain download of GET /__api/host/export?mode=full|bundle (admin cookie);
// import POSTs the chosen .tgz as a raw body. A full restore ends in a host
// restart (same reconnect/toast path as the Restart buttons above).
function BackupField({ disabled, onRestarting, reload }) {
  const t = useT();
  const [exporting, setExporting] = useState(null);
  const [importing, setImporting] = useState(false);
  const [force, setForce] = useState(false);
  const fileRef = useRef(null);
  const btn = 'shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-brand hover:text-[#1a1a1a] disabled:cursor-default disabled:opacity-50';

  const download = async (mode) => {
    setExporting(mode);
    try {
      const r = await fetch(`/__api/host/export?mode=${mode}`);
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b?.error || `HTTP ${r.status}`);
      }
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || `arigami-${mode}.tgz`;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toastError(e?.message || String(e));
    } finally {
      setExporting(null);
    }
  };

  const onFile = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    const ok = await confirmDialog({
      title: t('host.confirmImport.title'),
      body: t('host.confirmImport.body', { file: file.name }),
      confirmLabel: t('host.confirmImport.ok'),
    });
    if (!ok) return;
    setImporting(true);
    try {
      const r = await hostPost(`/host/import${force ? '?force=1' : ''}`, 'POST', file);
      if (r.kind === 'bundle') {
        toast(t('host.importDoneBundle', { name: r.name, repos: r.repos?.length || 0, skills: r.skills?.length || 0, cron: r.cron?.length || 0 }));
      } else if (r.restart) {
        onRestarting?.();
        toast(t('host.importDoneFull', { version: r.manifest?.version || '?', bak: r.backupDir || '—' }));
      } else {
        toast(t('host.importDoneFullNoRestart', { bak: r.backupDir || '—' }));
      }
      reload?.();
    } catch (e) {
      if (e?.status === 409 && /working/.test(e.message)) toastError(t('host.err.busy'));
      else if (e?.status === 409 && /newer/.test(e.message)) toastError(t('host.err.newer'));
      else if (e?.status === 403) toastError(t('host.err.forbidden'));
      else toastError(e?.message || String(e));
    } finally {
      setImporting(false);
    }
  };

  const off = disabled || importing || !!exporting;
  return (
    <Field label={t('host.backup')} hint={t('host.backup.hint')}>
      <div className="flex flex-col items-end gap-1.5">
        <span className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" disabled={off} onClick={() => download('full')} className={btn}>
            {exporting === 'full' ? t('host.exporting') : t('host.exportFull')}
          </button>
          <button type="button" disabled={off} onClick={() => download('bundle')} className={btn}>
            {exporting === 'bundle' ? t('host.exporting') : t('host.exportBundle')}
          </button>
          <button type="button" disabled={off} onClick={() => fileRef.current?.click()} className={btn}>
            {importing ? t('host.importing') : t('host.import')}
          </button>
          <input ref={fileRef} type="file" accept=".tgz,.tar.gz,application/gzip,application/x-gzip" className="hidden" onChange={onFile} />
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10.5px] text-fgdim">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={off} />
          {t('host.importForce')}
        </label>
      </div>
    </Field>
  );
}

function HostCard() {
  const t = useT();
  const { conn, hostEvent } = useStore();
  const [ver, setVer] = useState(null);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [log, setLog] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const wasDown = useRef(false);
  const restarting = useRef(false);

  const load = () => {
    api.get('/host/status').then(setSt).catch(() => setSt(null));
    api.get('/version').then(setVer).catch(() => setVer(null));
  };
  useEffect(() => { load(); }, []);

  // Reconnect after a restart we triggered → refresh + toast.
  useEffect(() => {
    if (conn !== 'open') { wasDown.current = true; return; }
    if (wasDown.current) {
      wasDown.current = false;
      if (restarting.current) { restarting.current = false; toast(t('host.back')); }
      setLog([]);
      load();
    }
  }, [conn]);

  // Live progress from the bus.
  useEffect(() => {
    if (!hostEvent) return;
    const ev = hostEvent;
    if (ev.kind === 'upgrade-progress') {
      setLog((l) => [...l.slice(-199), ev.line]);
      setSt((s) => (s ? { ...s, upgrade: { ...(s.upgrade || {}), step: ev.step, finishedAt: null } } : s));
      return;
    }
    if (ev.kind === 'upgrade-failed') { toastError(t('host.upgradeFailed', { error: ev.error })); setShowLog(true); }
    if (ev.kind === 'upgrade-done') toast(t('host.upgradeDone'));
    if (ev.kind === 'restarting' || ev.kind === 'restart-draining') restarting.current = true;
    load();
  }, [hostEvent]);

  const fail = (e) => {
    if (e?.status === 409 && /supervisor/.test(e.message)) toastError(t('host.err.noSupervisor'));
    else if (e?.status === 403) toastError(t('host.err.forbidden'));
    else toastError(e?.message || String(e));
  };
  const act = async (fn) => {
    setBusy(true);
    try { await fn(); load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const restartNow = async () => {
    const n = st?.busySessions || 0;
    const ok = await confirmDialog({
      title: t('host.confirmRestart.title'),
      body: n ? t('host.confirmRestart.body', { n }) : '',
      confirmLabel: t('host.confirmRestart.ok'),
      danger: true,
    });
    if (!ok) return;
    restarting.current = true;
    act(() => hostPost('/host/restart?when=now'));
  };
  const restartIdle = () => act(() => hostPost('/host/restart?when=idle'));
  const cancelPending = () => act(() => hostPost('/host/restart', 'DELETE'));
  const upgrade = async (when) => {
    const ok = await confirmDialog({
      title: t('host.confirmUpgrade.title'),
      body: t('host.confirmUpgrade.body'),
      confirmLabel: t('host.confirmUpgrade.ok'),
      danger: true,
    });
    if (!ok) return;
    setLog([]);
    setShowLog(true);
    act(() => hostPost(`/host/upgrade?when=${when}`));
  };
  const check = async () => {
    setChecking(true);
    try { setVer(await api.get('/version?refresh=1')); } catch (e) { fail(e); } finally { setChecking(false); }
  };

  const btn = 'shrink-0 cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-brand hover:text-[#1a1a1a] disabled:cursor-default disabled:opacity-50';
  const noSup = st && st.manager === 'none';
  const pending = st?.pendingRestart;
  const phase = st?.phase;
  const upg = st?.upgrade;
  const upgRunning = !!upg && upg.finishedAt === null;
  const disabled = busy || noSup || phase === 'draining' || phase === 'exiting' || upgRunning;

  return (
    <>
      <h3 className="mt-3 border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('host.title')}
      </h3>
      <Field label={t('host.version')} hint={t('host.version.hint')}>
        <div className="flex flex-col items-end gap-1">
          <span className="font-mono text-[11.5px] text-fg" dir="ltr">
            {ver ? `v${ver.version} · ${ver.commit || '?'}${ver.branch ? ` · ${ver.branch}` : ''}` : '…'}
          </span>
          <span className="flex items-center gap-2 font-mono text-[10.5px] text-fgdim">
            {ver && (ver.ahead === null
              ? t('host.noUpstream')
              : ver.ahead > 0
                ? <span className="text-[#CE8324]">{t('host.updateAvailable', { n: ver.ahead })}</span>
                : t('host.upToDate'))}
            <button type="button" disabled={checking} onClick={check} className="cursor-pointer underline disabled:opacity-50">
              {checking ? t('host.checking') : t('host.check')}
            </button>
          </span>
        </div>
      </Field>
      <Field label={t('host.manager')} hint={t('host.manager.hint')}>
        <span className="font-mono text-[11.5px] text-fg" dir="ltr">
          {st ? `${st.manager} · ${t('host.uptime', { t: fmtUptime(st.uptimeSec) })}${st.busySessions ? ` · ${t('host.busy', { n: st.busySessions })}` : ''}` : '…'}
        </span>
      </Field>
      <Field label={t('host.restart')} hint={t('host.restart.hint')}>
        <div className="flex flex-col items-end gap-1.5">
          <span className="flex items-center gap-2">
            {pending === 'idle' && phase === 'pending-idle' ? (
              <button type="button" disabled={busy} onClick={cancelPending} className={btn}>{t('host.cancelPending')}</button>
            ) : (
              <button type="button" disabled={disabled} onClick={restartIdle} className={btn}>{t('host.restartIdle')}</button>
            )}
            <button type="button" disabled={disabled} onClick={restartNow} className={btn}>{t('host.restartNow')}</button>
          </span>
          {phase === 'pending-idle' && (
            <span className="font-mono text-[10.5px] text-[#CE8324]">{t('host.pendingIdle', { n: st.busySessions })}</span>
          )}
          {phase === 'draining' && <span className="font-mono text-[10.5px] text-[#CE8324]">{t('host.draining')}</span>}
          {phase === 'exiting' && <span className="font-mono text-[10.5px] text-[#CE8324]">{t('host.restarting')}</span>}
        </div>
      </Field>
      <Field label={t('host.upgrade')} hint={st && !st.allowUpgrade ? t('host.upgradeDisabled') : t('host.upgrade.hint')}>
        <div className="flex flex-col items-end gap-1.5">
          <span className="flex items-center gap-2">
            <button type="button" disabled={disabled || !st?.allowUpgrade} onClick={() => upgrade('idle')} className={btn}>{t('host.upgradeIdleBtn')}</button>
            <button type="button" disabled={disabled || !st?.allowUpgrade} onClick={() => upgrade('now')} className={btn}>{t('host.upgradeBtn')}</button>
          </span>
          {upgRunning && <span className="font-mono text-[10.5px] text-[#CE8324]">{t('host.upgradeRunning', { step: upg.step || '…' })}</span>}
          {(log.length > 0 || upg?.log?.length > 0) && (
            <button type="button" onClick={() => setShowLog((v) => !v)} className="cursor-pointer font-mono text-[10.5px] text-fgdim underline">
              {t('host.log')}
            </button>
          )}
        </div>
      </Field>
      <BackupField disabled={busy || phase === 'draining' || phase === 'exiting' || upgRunning} onRestarting={() => { restarting.current = true; }} reload={load} />
      {showLog && (log.length > 0 || upg?.log?.length > 0) && (
        <pre dir="ltr" className="thin-scroll mb-3 max-h-[220px] overflow-auto rounded-lg border border-hair bg-bg p-2 font-mono text-[10.5px] leading-snug text-fg">
          {(log.length ? log : upg.log).join('\n')}
        </pre>
      )}
    </>
  );
}

// C1 — Users & access: who you are, sign out, admin: pairing code for another
// device/user, users list, API tokens for CLIs.
function UsersCard() {
  const t = useT();
  const { auth } = useStore();
  const [users, setUsers] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null); // {token} shown once
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const admin = !!auth?.isAdmin;
  const off = auth?.authMode === 'off';

  const load = () => {
    if (!auth || off) return;
    api.get('/auth/users').then((r) => setUsers(r.users || [])).catch(() => {});
    if (admin) api.get('/auth/tokens').then((r) => setTokens(r.tokens || [])).catch(() => {});
  };
  useEffect(() => { load(); }, [auth?.user?.id, admin, off]);

  if (!auth) return null;

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    signOut();
  };
  const issueCode = async () => {
    setBusy(true);
    try { setCode((await api.post('/auth/pairing-code')).code); } catch (e) { toastError(String(e.message || e)); } finally { setBusy(false); }
  };
  const createToken = async () => {
    setBusy(true);
    try {
      const r = await api.post('/auth/tokens', { label: label || 'cli' });
      setFresh(r);
      setLabel('');
      load();
    } catch (e) { toastError(String(e.message || e)); } finally { setBusy(false); }
  };
  const delToken = async (id) => { await api.del(`/auth/tokens/${id}`).catch(() => {}); load(); };
  const delUser = async (id) => { await api.del(`/auth/users/${id}`).catch((e) => toastError(String(e.message || e))); load(); };

  const row = 'flex items-center justify-between gap-2 border-b border-hair py-1.5 text-[11.5px] last:border-b-0';
  const btn = 'cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1 text-[11px] text-fg hover:bg-brand disabled:opacity-40';
  return (
    <>
      <h3 className="mt-3 border-t border-hair pt-3 text-[11px] font-bold uppercase tracking-wide text-fgdim">
        {t('auth.settings.title')}
      </h3>
      {off ? (
        <div className="text-[11.5px] text-fgdim">{t('auth.settings.off')}</div>
      ) : (
        <>
          <Field label={t('auth.settings.you')} hint={auth.user ? `${auth.user.email} · ${auth.user.role}` : auth.principal}>
            <button type="button" onClick={logout} className={btn}>{t('auth.settings.logout')}</button>
          </Field>
          {admin && (
            <Field label={t('auth.settings.pairAnother')} hint={code ? t('auth.settings.pairCodeHint') : t('auth.settings.pairAnotherHint')}>
              {code ? (
                <span className="font-mono text-sm font-bold tracking-[0.15em]">{code}</span>
              ) : (
                <button type="button" disabled={busy} onClick={issueCode} className={btn}>{t('auth.settings.issueCode')}</button>
              )}
            </Field>
          )}
          {users.length > 0 && (
            <div className="mt-2 rounded-lg border border-hair px-3 py-1">
              {users.map((u) => (
                <div key={u.id} className={row}>
                  <span className="min-w-0 truncate">
                    <span className="font-bold">{u.email}</span>
                    <span className="ml-2 font-mono text-[10px] text-fgdim">{u.role}{u.oidcSub ? ' · oidc' : ''}</span>
                  </span>
                  {admin && u.id !== auth.user?.id && (
                    <button type="button" onClick={() => delUser(u.id)} className="cursor-pointer text-[10px] text-fgdim hover:text-fg">{t('auth.settings.remove')}</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {admin && (
            <>
              <Field label={t('auth.settings.tokens')} hint={t('auth.settings.tokensHint')}>
                <span className="flex items-center gap-1.5">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('auth.settings.tokenLabel')}
                    className="w-[110px] rounded-lg border-[1.5px] border-ink bg-panel px-2 py-1 text-[11px] outline-none"
                  />
                  <button type="button" disabled={busy} onClick={createToken} className={btn}>{t('auth.settings.createToken')}</button>
                </span>
              </Field>
              {fresh && (
                <div className="mt-1 rounded-lg border border-hair bg-panel px-3 py-2 text-[11px]">
                  <div className="mb-1 text-fgdim">{t('auth.settings.tokenOnce')}</div>
                  <code className="break-all font-mono text-[11px] select-all">{fresh.token}</code>
                </div>
              )}
              {tokens.length > 0 && (
                <div className="mt-2 rounded-lg border border-hair px-3 py-1">
                  {tokens.map((tk) => (
                    <div key={tk.id} className={row}>
                      <span className="min-w-0 truncate">
                        <span className="font-bold">{tk.label}</span>
                        <span className="ml-2 font-mono text-[10px] text-fgdim">{tk.email} · {tk.createdAt?.slice(0, 10)}</span>
                      </span>
                      <button type="button" onClick={() => delToken(tk.id)} className="cursor-pointer text-[10px] text-fgdim hover:text-fg">{t('auth.settings.revoke')}</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
