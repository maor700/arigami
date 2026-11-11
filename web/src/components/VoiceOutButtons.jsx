// Composer buttons for voice OUT (stage 1b): "read answers aloud" (toggle; Stop while speaking) and hands-free.
// Both render nothing without a TTS source — a host with no voice provider and no browser opt-in sees no change.
import { useStore } from '../lib/store.js';
import { usePrefs, setPrefs } from '../lib/prefs.js';
import { ttsSource, handsFreeAvailable, useSpeak, bargeIn, unlockAudio } from '../lib/speak.js';
import { useHandsFree, toggleHandsFree } from '../lib/handsfree.js';
import { useCall, toggleCall, toggleGlobalCall, callAvailable } from '../lib/call.js';
import { useT } from '../lib/i18n.js';
import { HeadphonesIcon, PhoneCallIcon, PhoneOffIcon, SquareIcon, Volume2Icon, VolumeXIcon } from 'lucide-react';
import { Tip, TooltipProvider } from './ui/index.js';

const BOX = 'relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sm coarse:size-11 [&_svg]:size-4';
const IDLE = 'border-border text-muted-foreground hover:bg-muted hover:text-foreground';
const LIVE = 'border-destructive bg-[var(--hb-err-bg)] text-destructive';

export function ReadAloudButton({ sessionId, className = BOX }) {
  const t = useT();
  const { config } = useStore();
  const prefs = usePrefs();
  const sp = useSpeak();
  const source = ttsSource(config, prefs);
  if (!source) return null;
  const on = prefs.voiceReadAloud === true;
  const speakingHere = sp.active && (!sessionId || sp.sessionId === sessionId);
  const label = speakingHere ? t('dialogs.readAloudStop') : on ? t('dialogs.readAloudOn') : t('dialogs.readAloudOff');
  const hint = source === 'browser' ? ` · ${t('dialogs.readAloudBrowser')}` : '';
  return (
    <TooltipProvider>
      <Tip label={label + (speakingHere ? '' : hint)}>
        <button
          type="button"
          data-read-aloud={speakingHere ? 'stop' : on ? 'on' : 'off'}
          aria-label={label}
          aria-pressed={on}
          onClick={() => { unlockAudio(); if (speakingHere) bargeIn({ sessionId }); else setPrefs({ voiceReadAloud: !on }); }}
          className={`${className} ${speakingHere ? LIVE : on ? 'border-border text-foreground hover:bg-muted' : IDLE}`}
        >
          {speakingHere ? <SquareIcon className="fill-current !size-3" /> : on ? <Volume2Icon /> : <VolumeXIcon />}
        </button>
      </Tip>
    </TooltipProvider>
  );
}

export function HandsFreeButton({ sessionId, className = BOX }) {
  const t = useT();
  const { config } = useStore();
  const prefs = usePrefs();
  const hf = useHandsFree();
  if (!handsFreeAvailable(config, prefs)) return null;
  const active = hf.active && hf.sessionId === sessionId;
  const label = active ? t('dialogs.handsFreeStop') : t('dialogs.handsFree');
  return (
    <TooltipProvider>
      <Tip label={label}>
        <button
          type="button"
          data-hands-free={active ? 'on' : 'off'}
          aria-label={label}
          aria-pressed={active}
          onClick={() => toggleHandsFree(sessionId)}
          className={`${className} ${active ? LIVE : IDLE}`}
        >
          <HeadphonesIcon />
        </button>
      </Tip>
    </TooltipProvider>
  );
}

// Stage 1c: a call with the realtime clerk — only while a realtime provider is connected (nothing otherwise).
export function CallButton({ sessionId, className = BOX }) {
  const t = useT();
  const { config } = useStore();
  const call = useCall();
  if (!callAvailable(config)) return null;
  const active = call.active && call.sessionId === sessionId;
  const label = active ? t('dialogs.call.hangUp') : t('dialogs.call');
  return (
    <TooltipProvider>
      <Tip label={label}>
        <button
          type="button"
          data-voice-call={active ? 'on' : 'off'}
          aria-label={label}
          aria-pressed={active}
          onClick={() => { unlockAudio(); toggleCall(sessionId); }}
          className={`${className} ${active ? LIVE : IDLE}`}
        >
          <PhoneCallIcon />
        </button>
      </Tip>
    </TooltipProvider>
  );
}

// Stage 1d: the rail's global phone — one call for everything, anchored in the voice home session, the open session as the
// clerk's default subject; on while ANY call is live (one at a time). No realtime provider → nothing.
export function RailCallButton({ contextSessionId, className = BOX }) {
  const t = useT();
  const { config } = useStore();
  const call = useCall();
  if (!callAvailable(config)) return null;
  const active = call.active;
  const label = active ? t('dialogs.call.hangUp') : `${t('dialogs.call')} — ${t('dialogs.call.globalHint')}`;
  return (
    <TooltipProvider>
      <Tip label={label}>
        <button
          type="button"
          data-rail-call={active ? 'on' : 'off'}
          aria-label={active ? t('dialogs.call.hangUp') : t('dialogs.call')}
          aria-pressed={active}
          onClick={() => { unlockAudio(); toggleGlobalCall(contextSessionId); }}
          className={`${className} border ${active ? LIVE : IDLE}`}
        >
          {active ? <PhoneOffIcon /> : <PhoneCallIcon />}
        </button>
      </Tip>
    </TooltipProvider>
  );
}
