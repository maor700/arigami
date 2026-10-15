// The language the mic listens in (VOICE1). One pref (`prefs.voiceLang`),
// edited from two places: Settings › General › Advanced › Voice, and the
// speech window itself. 'auto' follows the interface language; the badge on
// the mic buttons shows the resolved 2-letter code.
import { usePrefs, setPrefs, voiceLangFrom } from '../lib/prefs.js';
import { resolveLang } from '../lib/langs.js';
import { VOICE_LANGS, VOICE_LANG_IDS } from '../lib/langs.js';
import { useT } from '../lib/i18n.js';
import { INPUT } from './settings/shared.jsx';

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
      className={`${INPUT} cursor-pointer ${compact ? 'h-7 max-w-[150px] px-1.5 text-xs' : 'max-w-[220px]'}`}
    >
      <option value="auto">{t('dialogs.voiceLangAuto', { lang: `${ui} · ${VOICE_LANGS[ui]}` })}</option>
      {VOICE_LANG_IDS.map((id) => (
        <option key={id} value={id}>{id} · {VOICE_LANGS[id]}</option>
      ))}
    </select>
  );
}
