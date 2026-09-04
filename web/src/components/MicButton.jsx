// The ONE mic trigger (VOICE1), mounted twice:
//   mode 'dictate' — in the session composer: the transcript goes into the draft.
//   mode 'command' — in the rail (desktop + mobile drawer): the voice-command router.
// Both wear a tiny badge with the language the mic listens in (he/en/…) and
// turn into a red dot while THIS mode is recording. `className` replaces the
// button's box styling so each host keeps its own button size.
import { useVoice, toggleRecording } from '../lib/voice.js';
import { useVoiceLang } from './VoiceLangPicker.jsx';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faCircle, faMicrophone } from '@fortawesome/free-solid-svg-icons';

const BOX = 'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-[1.5px] text-[13px]';

export default function MicButton({ mode = 'command', className = BOX, title }) {
  const t = useT();
  const { status, mode: activeMode } = useVoice();
  const lang = useVoiceLang();
  const rec = status === 'recording' && activeMode === mode;
  const label = title || (mode === 'dictate' ? t('rail.dictateHint') : t('rail.voiceControlHint'));
  return (
    <button
      type="button"
      data-mic={mode}
      title={label}
      aria-label={label}
      onClick={() => toggleRecording({ mode })}
      className={`relative ${className} ${
        rec
          ? 'border-danger bg-[#fdf6f5] text-danger'
          : 'border-border bg-bg text-fgdim hover:border-ink hover:text-fg'
      }`}
    >
      <Icon icon={rec ? faCircle : faMicrophone} className={rec ? 'text-[9px]' : undefined} />
      <span
        data-mic-lang
        dir="ltr"
        className="pointer-events-none absolute -end-1 -bottom-1 rounded-[4px] border border-border bg-panel px-[3px] font-mono text-[8px] leading-[11px] text-fgdim"
      >
        {lang}
      </span>
    </button>
  );
}
