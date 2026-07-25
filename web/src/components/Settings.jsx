import { useEffect, useState } from 'react';
import { usePrefs, setPrefs, PREF_LIMITS } from '../lib/prefs.js';
import { api } from '../lib/api.js';
import { Wave } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { LOGOS, LOGO_IDS, DEFAULT_ACCENT } from '../lib/logos.js';

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
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

// Reach the cockpit from your phone over Tailscale — private to your devices,
// never a public URL. The direct tailnet URL works as soon as Tailscale is up;
// HTTPS serve is an optional upgrade (needs HTTPS Certificates on the tailnet).
function RemoteAccess() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () =>
    api.get('/remote').then(setSt).catch(() => setSt({ available: false, reason: 'Could not reach the host.' }));
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
        Remote access
      </div>
      {!st ? (
        <div className="py-4 font-mono text-[11px] text-fgdim">checking Tailscale…</div>
      ) : !st.available ? (
        <Field label="Tailscale" hint="Not installed. Install Tailscale to reach the cockpit from your phone — private to your devices, no public URL.">
          <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className={LINK_BTN}>
            Get Tailscale ↗
          </a>
        </Field>
      ) : !st.loggedIn ? (
        <Field label="Tailscale" hint={st.reason || 'Open the Tailscale app and sign in, then recheck.'}>
          <button type="button" onClick={load} className={LINK_BTN}>Recheck</button>
        </Field>
      ) : (
        <>
          <div className="border-b border-hair py-4">
            <div className="text-[13px] font-bold text-fg">Open on your phone</div>
            <div className="mt-0.5 text-[11.5px] text-fgdim">
              With Tailscale running on both devices. Encrypted over your tailnet — chat works now.
            </div>
          </div>
          {st.directUrl && <CopyRow url={st.directUrl} />}

          <Field
            label="HTTPS (cleaner URL + embedded app tabs)"
            hint={
              st.serving
                ? 'On — the https:// URL below also works.'
                : 'Optional. Serve over https://<host>/ — needs HTTPS Certificates enabled for your tailnet.'
            }
          >
            <Toggle on={!!st.serving} disabled={busy} onChange={toggle} />
          </Field>
          {st.serving && st.httpsUrl && <CopyRow url={st.httpsUrl} />}
          {err && (
            <div className="py-2 text-[11px] leading-snug text-danger">
              {err}{' '}
              <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" className="underline">
                open admin console ↗
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
        Allow mic to list devices
      </button>
    );
  }

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[220px] cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] text-fg outline-none focus:border-brand"
    >
      <option value="">System default</option>
      {devices.map((d, i) => (
        <option key={d.deviceId || i} value={d.deviceId}>
          {d.label || `Microphone ${i + 1}`}
        </option>
      ))}
    </select>
  );
}

export default function Settings({ onClose }) {
  const prefs = usePrefs();
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
        <span className="text-sm font-bold text-fg">Settings</span>
        <button
          type="button"
          onClick={onClose}
          title="Close settings (esc)"
          className="ml-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[560px] px-7 py-6">
          <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
            Appearance
          </div>
          <Field label="Theme" hint="Light or dark host chrome.">
            <Segmented
              value={prefs.theme}
              onChange={(v) => setPrefs({ theme: v })}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Field>
          <Field label="Accent color" hint="Brand color for buttons, links, highlights, and the logo.">
            <span className="flex items-center gap-2">
              <label className="relative flex h-[26px] w-[38px] cursor-pointer items-center justify-center overflow-hidden rounded-lg border-[1.5px] border-ink">
                <span className="absolute inset-0" style={{ background: prefs.accent || DEFAULT_ACCENT }} />
                <input
                  type="color"
                  value={prefs.accent || DEFAULT_ACCENT}
                  onChange={(e) => setPrefs({ accent: e.target.value })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="Accent color"
                />
              </label>
              <code className="font-mono text-[11px] text-fgdim">{prefs.accent || DEFAULT_ACCENT}</code>
              {prefs.accent ? (
                <button
                  type="button"
                  onClick={() => setPrefs({ accent: '' })}
                  className="cursor-pointer rounded-md border border-hair px-2 py-1 text-[10.5px] text-fgdim hover:border-ink hover:text-fg"
                >
                  Reset
                </button>
              ) : null}
            </span>
          </Field>
          <Field label="Logo" hint="Origami mark shown in the browser tab.">
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
            Terminal
          </div>
          <Field label="Font size" hint={`Chat output text size (${fontMin}–${fontMax}px).`}>
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
          <Field label="Terminal theme" hint="Default light/dark for the chat terminal. Each terminal has its own 🌙/☀ toggle in its header.">
            <Segmented
              value={prefs.termTheme}
              onChange={(v) => setPrefs({ termTheme: v })}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Field>
          <Field label="Text direction" hint="Default chat direction — Auto detects per message. Each terminal has its own dir toggle in its header.">
            <Segmented
              value={prefs.termDir}
              onChange={(v) => setPrefs({ termDir: v })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'ltr', label: 'LTR' },
                { value: 'rtl', label: 'RTL' },
              ]}
            />
          </Field>

          <div className="mt-6 mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
            Voice control
          </div>
          <Field label="Mode" hint="Hold to talk: record only while the hotkey is held. Press to toggle: tap once to start, tap again (or Stop) to end.">
            <Segmented
              value={prefs.voiceMode}
              onChange={(v) => setPrefs({ voiceMode: v })}
              options={[
                { value: 'hold', label: 'Hold to talk' },
                { value: 'toggle', label: 'Press to toggle' },
              ]}
            />
          </Field>
          <Field label="Microphone" hint="Which input device to record from.">
            <MicPicker value={prefs.voiceMicId} onChange={(v) => setPrefs({ voiceMicId: v })} />
          </Field>
          <Field label="Language" hint="STT recognition language. Auto lets Whisper detect (good for Hebrew/English code-switching).">
            <Segmented
              value={prefs.voiceLanguage}
              onChange={(v) => setPrefs({ voiceLanguage: v })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'en', label: 'English' },
                { value: 'he', label: 'Hebrew' },
              ]}
            />
          </Field>
          <Field label="Record hotkey" hint="Keyboard shortcut to record. Click Record, then press the keys.">
            <span className="flex items-center gap-2">
              <input
                type="text"
                value={recordingHotkey ? 'Press keys…' : prefs.voiceHotkey}
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
                {recordingHotkey ? 'Listening…' : 'Record'}
              </button>
            </span>
          </Field>
          <Field label="Auto-send prompts" hint="Automatically send voice-injected prompts without asking for confirmation.">
            <Toggle
              on={prefs.voiceAutoSend}
              onChange={(v) => setPrefs({ voiceAutoSend: v })}
            />
          </Field>

          <RemoteAccess />
        </div>
      </div>
    </div>
  );
}
