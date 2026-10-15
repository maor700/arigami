// Settings › General (AUDIT2 — was "Appearance"; the Voice and Automation
// pages folded in here). On screen by default: theme, language, chat font
// size, and — only when the server reports voiceEnabled — the voice hotkey and
// mode. Everything else the old three pages had is in the Advanced drawer:
// accent colour, terminal defaults (theme/direction), the rest of voice
// (mic, recognition language, auto-send; plus hotkey/mode while voice is off),
// the Brain heartbeat and the telemetry toggle. prefs keys are unchanged.
// The origami logo chooser stays out of the UI (SETTINGS-IA §1.1 #4).
// LEARN1: the Memory section (autonomous memory learning — mode, learning log,
// pending strip, manual block) sits here, on the page, under the chrome block:
// it is about how the assistant behaves for the human, like language/voice,
// not about the machine (Host). Deep link: #/settings/appearance/memory.
import { usePrefs, setPrefs, UI_SCALE_IDS } from '../../lib/prefs.js';
import { DEFAULT_ACCENT } from '../../lib/logos.js';
import { LANGS, LANG_IDS } from '../../lib/langs.js';
import { useT } from '../../lib/i18n.js';
import { Field, Segmented, Section, Advanced, BTN_SM, INPUT } from './shared.jsx';
import ChatTextSize from './ChatTextSize.jsx';
import { VoiceMain, VoiceAdvanced } from './Voice.jsx';
import { BrainHeartbeat, TelemetryToggle } from './Automation.jsx';
import MemoryLearning from './MemoryLearning.jsx';

export const GENERAL_ADVANCED_IDS = ['terminal', 'voice-advanced', 'heartbeat', 'telemetry'];

export default function General({ section = '', voiceEnabled = false, recording, setRecording }) {
  const prefs = usePrefs();
  const t = useT();
  const lightDark = [
    { value: 'light', label: t('common.light') },
    { value: 'dark', label: t('common.dark') },
  ];
  // While voice is off its two main controls live in the drawer too, so a
  // deep link to #/settings/voice must open the drawer.
  const advIds = voiceEnabled ? GENERAL_ADVANCED_IDS : [...GENERAL_ADVANCED_IDS, 'voice'];

  return (
    <>
      <Section id="chrome" title={t('settings.appearance')} first>
        <Field label={t('settings.theme')} hint={t('settings.theme.hint')}>
          <Segmented
            value={prefs.themeMode}
            onChange={(v) => setPrefs({ themeMode: v })}
            options={[{ value: 'system', label: t('common.system') }, ...lightDark]}
          />
        </Field>
        <Field label={t('settings.termTheme')} hint={t('settings.termTheme.hint')}>
          <Segmented
            value={prefs.termTheme}
            onChange={(v) => setPrefs({ termTheme: v })}
            options={[{ value: 'auto', label: t('settings.chatTheme.auto') }, ...lightDark]}
          />
        </Field>
        <Field label={t('settings.language')} hint={t('settings.language.hint')}>
          <select
            value={prefs.language}
            onChange={(e) => setPrefs({ language: e.target.value })}
            className={`${INPUT} cursor-pointer`}
          >
            <option value="auto">{t('settings.language.auto')}</option>
            {LANG_IDS.map((id) => (
              <option key={id} value={id}>{LANGS[id].label}</option>
            ))}
          </select>
        </Field>
        <Field label={t('settings.uiScale')} hint={t('settings.uiScale.hint')}>
          <Segmented
            value={prefs.uiScale}
            onChange={(v) => setPrefs({ uiScale: v })}
            options={UI_SCALE_IDS.map((id) => ({ value: id, label: t(`settings.uiScale.${id}`) }))}
          />
        </Field>
        <ChatTextSize />
        <Field label={t('settings.accent')} hint={t('settings.accent.hint')}>
          <span className="flex items-center gap-2">
            <label className="relative flex h-[1.625rem] w-[2.375rem] cursor-pointer coarse:h-11 coarse:w-11 items-center justify-center overflow-hidden rounded-md border border-input">
              <span className="absolute inset-0" style={{ background: prefs.accent || DEFAULT_ACCENT }} />
              <input
                type="color"
                value={prefs.accent || DEFAULT_ACCENT}
                onChange={(e) => setPrefs({ accent: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label={t('settings.accent')}
              />
            </label>
            <code dir="ltr" className="font-mono text-xs text-fgdim">{prefs.accent || DEFAULT_ACCENT}</code>
            {prefs.accent ? (
              <button type="button" onClick={() => setPrefs({ accent: '' })} className={BTN_SM}>
                {t('common.reset')}
              </button>
            ) : null}
          </span>
        </Field>
      </Section>

      <MemoryLearning />

      {voiceEnabled && (
        <Section id="voice" title={t('chrome.voice.section')}>
          <VoiceMain recording={recording} setRecording={setRecording} />
        </Section>
      )}

      <Advanced section={section} ids={advIds}>

        <Section id="terminal" title={t('settings.terminal')}>
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
        </Section>

        <Section id={voiceEnabled ? 'voice-advanced' : 'voice'} title={t('chrome.voice.section')}>
          {!voiceEnabled && (
            <>
              <div data-voice-off className="mb-1 text-xs text-fgdim">{t('settings.voice.off')}</div>
              <VoiceMain recording={recording} setRecording={setRecording} />
            </>
          )}
          <VoiceAdvanced />
        </Section>

        <BrainHeartbeat />
        <TelemetryToggle />
      </Advanced>
    </>
  );
}
