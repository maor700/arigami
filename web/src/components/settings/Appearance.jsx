// Settings › Appearance: theme, language, accent, chat font size and the
// terminal defaults (theme/direction — each terminal still has its own toggle
// in its header; these are the fallbacks termViewFrom() uses).
// The origami logo chooser was dropped from the UI (SETTINGS-IA §1.1 #4): the
// value only drove the favicon. prefs.logo is still honoured if set.
import { usePrefs, setPrefs, PREF_LIMITS } from '../../lib/prefs.js';
import { DEFAULT_ACCENT } from '../../lib/logos.js';
import { LANGS, LANG_IDS } from '../../lib/langs.js';
import { useT } from '../../lib/i18n.js';
import { Field, Segmented, Section } from './shared.jsx';

export default function Appearance() {
  const prefs = usePrefs();
  const t = useT();
  const [fontMin, fontMax] = PREF_LIMITS.font;
  const stepFont = (delta) => setPrefs({ termFontSize: prefs.termFontSize + delta });
  const lightDark = [
    { value: 'light', label: t('common.light') },
    { value: 'dark', label: t('common.dark') },
  ];

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
    </>
  );
}
