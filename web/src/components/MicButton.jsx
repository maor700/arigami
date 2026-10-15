// The ONE mic trigger (VOICE1), mounted twice:
//   mode 'dictate' — in the session composer: the transcript goes into the draft.
//   mode 'command' — in the rail (desktop + mobile drawer): the voice-command router.
// Both wear a tiny badge with the language the mic listens in (he/en/…) and
// turn into a red dot while THIS mode is recording. `className` replaces the
// button's box styling so each host keeps its own button size.
import { useVoice, toggleRecording } from '../lib/voice.js';
import { useVoiceLang } from './VoiceLangPicker.jsx';
import { useT } from '../lib/i18n.js';
import { CircleIcon, MicIcon } from 'lucide-react';
import { Tip, TooltipProvider } from './ui/index.js';

const BOX = 'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sm coarse:size-11 [&_svg]:size-4';

export default function MicButton({ mode = 'command', className = BOX, title }) {
  const t = useT();
  const { status, mode: activeMode } = useVoice();
  const lang = useVoiceLang();
  const rec = status === 'recording' && activeMode === mode;
  const label = title || (mode === 'dictate' ? t('rail.dictateHint') : t('rail.voiceControlHint'));
  return (
    <TooltipProvider>
    <Tip label={label}>
      <button
        type="button"
        data-mic={mode}
        aria-label={label}
        onClick={() => toggleRecording({ mode })}
        className={`relative ${className} ${
          rec
            ? 'border-destructive bg-[var(--hb-err-bg)] text-destructive'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        {rec ? <CircleIcon className="fill-current !size-3" /> : <MicIcon />}
        <span
          data-mic-lang
          dir="ltr"
          className="pointer-events-none absolute -end-0.5 -bottom-0.5 rounded-sm bg-muted px-[3px] text-[9px] leading-[11px] text-muted-foreground"
        >
          {lang}
        </span>
      </button>
    </Tip>
    </TooltipProvider>
  );
}
