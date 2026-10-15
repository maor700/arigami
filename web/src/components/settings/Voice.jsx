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
import { Field, Segmented, Section, Toggle, INPUT, useFieldLabel } from './shared.jsx';
import { Button } from '../ui/button.jsx';
import VoiceLangPicker from '../VoiceLangPicker.jsx';
import { useIsDesktop } from '../../lib/useMedia.js';

// Device labels are only exposed after mic permission was granted once —
// until then offer a one-tap "Allow" that requests access and re-enumerates.
function MicPicker({ value, onChange }) {
  const t = useT();
  const fieldLabel = useFieldLabel();
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
      <Button type="button" onClick={grant}>
        {t('chrome.voice.mic.allow')}
      </Button>
    );
  }

  return (
    <select
      {...fieldLabel}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className={`${INPUT} max-w-[220px] cursor-pointer`}
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
  const desktop = useIsDesktop();
  // Both controls here exist only to serve a keyboard chord: the hotkey itself,
  // and hold-vs-toggle, which describes how that chord behaves while held.
  // A phone has neither, and its mic button always toggles — so on touch the
  // pair is dead UI. Say what does work instead.
  if (!desktop)
    return (
      <Field label={t('chrome.voice.hotkey')} hint={t('chrome.voice.hotkey.touchHint')}>
        <span className="text-xs text-fgdim">{t('chrome.voice.hotkey.touch')}</span>
      </Field>
    );
  return (
    <>
      <Field label={t('chrome.voice.hotkey')} hint={t('chrome.voice.hotkey.hint')}>
        <span className="flex items-center gap-2">
          <input
            type="text"
            value={recording ? t('chrome.voice.hotkey.pressKeys') : prefs.voiceHotkey}
            readOnly
            placeholder="Cmd+Shift+V"
            aria-label={t('chrome.voice.hotkey')}
            dir="ltr"
            className={`${INPUT} w-[140px] text-center font-mono text-xs`}
          />
          <Button
            type="button"
            variant={recording ? 'outline' : 'default'}
            onClick={() => setRecording((v) => !v)}
            className={recording ? 'border-ring bg-muted' : ''}
          >
            {recording ? t('chrome.voice.hotkey.listening') : t('chrome.voice.hotkey.record')}
          </Button>
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
        <VoiceLangPicker />
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
