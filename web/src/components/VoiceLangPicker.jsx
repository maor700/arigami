// The language the mic listens in (VOICE1). One pref (`prefs.voiceLang`),
// edited from two places: Settings › General › Advanced › Voice, and the
// speech window itself. 'auto' follows the interface language; the badge on
// the mic buttons shows the resolved 2-letter code.
import { usePrefs, setPrefs, voiceLangFrom } from '../lib/prefs.js';
import { resolveLang } from '../lib/langs.js';
import { VOICE_LANGS, VOICE_LANG_IDS } from '../lib/langs.js';
import { useT } from '../lib/i18n.js';

export function useVoiceLang() {
  return voiceLangFrom(usePrefs());
}

export default function VoiceLangPicker({ compact = false }) {
  const prefs = usePrefs();
  const t = useT();
  const ui = resolveLang(prefs.language);
  return (
    <select
      data-voice-lang
      aria-label={t('dialogs.voiceLang')}
      value={prefs.voiceLang}
      onChange={(e) => setPrefs({ voiceLang: e.target.value })}
      className={
        compact
          ? 'max-w-[150px] cursor-pointer rounded-[6px] border-[1.5px] border-border bg-panel px-1.5 py-[3px] font-mono text-[10.5px] text-fg outline-none hover:border-ink focus:border-brand'
          : 'max-w-[220px] cursor-pointer rounded-lg border-[1.5px] border-ink bg-panel px-3 py-1.5 text-[11.5px] text-fg outline-none focus:border-brand'
      }
    >
      <option value="auto">{t('dialogs.voiceLangAuto', { lang: `${ui} · ${VOICE_LANGS[ui]}` })}</option>
      {VOICE_LANG_IDS.map((id) => (
        <option key={id} value={id}>{id} · {VOICE_LANGS[id]}</option>
      ))}
    </select>
  );
}
