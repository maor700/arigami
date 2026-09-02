// Settings › General (AUDIT2 — was "Appearance"; the Voice and Automation
// pages folded in here). On screen by default: theme, language, chat font
// size, and — only when the server reports voiceEnabled — the voice hotkey and
// mode. Everything else the old three pages had is in the Advanced drawer:
// accent colour, terminal defaults (theme/direction), the rest of voice
// (mic, recognition language, auto-send; plus hotkey/mode while voice is off),
// the Brain heartbeat and the telemetry toggle. prefs keys are unchanged.
// The origami logo chooser stays out of the UI (SETTINGS-IA §1.1 #4).
// LEARN1: the זיכרון section (autonomous memory learning — mode, learning log,
// pending strip, manual block) sits here, on the page, under the chrome block:
// it is about how the assistant behaves for the human, like language/voice,
// not about the machine (מארח). Deep link: #/settings/appearance/memory.
import { usePrefs, setPrefs, PREF_LIMITS } from '../../lib/prefs.js';
import { DEFAULT_ACCENT } from '../../lib/logos.js';
import { LANGS, LANG_IDS } from '../../lib/langs.js';
import { useT } from '../../lib/i18n.js';
import { Field, Segmented, Section, Advanced } from './shared.jsx';
import { VoiceMain, VoiceAdvanced } from './Voice.jsx';
import { BrainHeartbeat, TelemetryToggle } from './Automation.jsx';
import MemoryLearning from './MemoryLearning.jsx';

export const GENERAL_ADVANCED_IDS = ['accent', 'terminal', 'voice-advanced', 'heartbeat', 'telemetry'];

export default function General({ section = '', voiceEnabled = false, recording, setRecording }) {
  const prefs = usePrefs();
  const t = useT();
  const [fontMin, fontMax] = PREF_LIMITS.font;
  const stepFont = (delta) => setPrefs({ termFontSize: prefs.termFontSize + delta });
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
          <Segmented value={prefs.theme} onChange={(v) => setPrefs({ theme: v })} options={lightDark} />
        </Field>
        <Field label={t('settings.language')} hint={t('settings.language.hint')}>
          <select
            value={prefs.language}
            onChange={(e) => setPrefs({ language: e.target.value })}
            className="cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg"
          >
            <option value="auto">{t('settings.language.auto')}</option>
            {LANG_IDS.map((id) => (
              <option key={id} value={id}>{LANGS[id].label}</option>
            ))}
          </select>
        </Field>
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
            <span className="border-x-[1.5px] border-ink bg-panel px-3 py-1.5 font-mono text-[11.5px] font-bold text-fg">{prefs.termFontSize}px</span>
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
      </Section>

      <MemoryLearning />

      {voiceEnabled && (
        <Section id="voice" title={t('chrome.voice.section')}>
          <VoiceMain recording={recording} setRecording={setRecording} />
        </Section>
      )}

      <Advanced section={section} ids={advIds}>
        <Section id="accent" title={t('settings.appearance')}>
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
        </Section>

        <Section id="terminal" title={t('settings.terminal')}>
          <Field label={t('settings.termTheme')} hint={t('settings.termTheme.hint')}>
            <Segmented value={prefs.termTheme} onChange={(v) => setPrefs({ termTheme: v })} options={lightDark} />
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
        </Section>

        <Section id={voiceEnabled ? 'voice-advanced' : 'voice'} title={t('chrome.voice.section')}>
          {!voiceEnabled && (
            <>
              <div data-voice-off className="mb-1 text-[11px] text-fgdim">{t('settings.voice.off')}</div>
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
