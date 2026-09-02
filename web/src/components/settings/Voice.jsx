// Settings › General › Voice (AUDIT2): the two controls a person actually
// touches — hotkey (recorded live) and push-to-talk mode — are `VoiceMain`;
// microphone, recognition language and auto-send are `VoiceAdvanced`. The
// General page shows VoiceMain inline only when the server reports
// `voiceEnabled:true` (a Groq key exists); otherwise both blocks sit in the
// Advanced drawer under one "voice is off" hint. Consumers: App.jsx (hotkey,
// mode) and lib/voice.js (mic, language, auto-send). Nothing was removed.
import { useEffect, useState } from 'react';
import { usePrefs, setPrefs } from '../../lib/prefs.js';
import { useT } from '../../lib/i18n.js';
import { Field, Segmented, Section, Toggle } from './shared.jsx';

// Device labels are only exposed after mic permission was granted once —
// until then offer a one-tap "Allow" that requests access and re-enumerates.
function MicPicker({ value, onChange }) {
  const t = useT();
  const [devices, setDevices] = useState([]);
  const [needsPerm, setNeedsPerm] = useState(false);

  const enumerate = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all.filter((d) => d.kind === 'audioinput');
      setDevices(mics);
      setNeedsPerm(mics.length > 0 && !mics.some((d) => d.label));
    } catch {
      setDevices([]);
    }
  };

  useEffect(() => {
    const on = () => { enumerate(); };
    on();
    navigator.mediaDevices?.addEventListener?.('devicechange', on);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', on);
  }, []);

  const grant = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((tr) => tr.stop());
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
        <option key={d.deviceId || i} value={d.deviceId}>{d.label || t('chrome.voice.mic.fallback', { n: i + 1 })}</option>
      ))}
    </select>
  );
}

// `recording` is owned by the Settings shell (it also swallows Escape while
// a hotkey is being recorded) — see Settings.jsx.
export function VoiceMain({ recording, setRecording }) {
  const prefs = usePrefs();
  const t = useT();
  return (
    <>
      <Field label={t('chrome.voice.hotkey')} hint={t('chrome.voice.hotkey.hint')}>
        <span className="flex items-center gap-2">
          <input
            type="text"
            value={recording ? t('chrome.voice.hotkey.pressKeys') : prefs.voiceHotkey}
            readOnly
            placeholder="Cmd+Shift+V"
            className="w-[140px] rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-center font-mono text-[11.5px] text-fg outline-none"
          />
          <button
            type="button"
            onClick={() => setRecording((v) => !v)}
            className={`shrink-0 cursor-pointer rounded-lg border-[1.5px] px-3 py-1.5 text-[11.5px] font-bold transition-colors ${
              recording ? 'border-brand bg-brand text-[#1a1a1a]' : 'border-ink bg-panel text-fg hover:bg-brand hover:text-[#1a1a1a]'
            }`}
          >
            {recording ? t('chrome.voice.hotkey.listening') : t('chrome.voice.hotkey.record')}
          </button>
        </span>
      </Field>
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
    </>
  );
}

export function VoiceAdvanced() {
  const prefs = usePrefs();
  const t = useT();
  return (
    <>
      <Field label={t('chrome.voice.mic')} hint={t('chrome.voice.mic.hint')}>
        <MicPicker value={prefs.voiceMicId} onChange={(v) => setPrefs({ voiceMicId: v })} />
      </Field>
      <Field label={t('chrome.voice.language')} hint={t('chrome.voice.language.hint')}>
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
      <Field label={t('chrome.voice.autoSend')} hint={t('chrome.voice.autoSend.hint')}>
        <Toggle on={prefs.voiceAutoSend} onChange={(v) => setPrefs({ voiceAutoSend: v })} />
      </Field>
    </>
  );
}

// The whole block in one section — what the old standalone Voice page was.
export default function Voice({ recording, setRecording, first = false }) {
  const t = useT();
  return (
    <Section id="voice" title={t('chrome.voice.section')} first={first}>
      <VoiceMain recording={recording} setRecording={setRecording} />
      <VoiceAdvanced />
    </Section>
  );
}
