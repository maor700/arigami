import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVoice, stopRecording, cancel, clearPlan, startRecording, endConversation, GROQ_KEY_GUIDE } from '../lib/voice.js';
import { runAction } from '../lib/commands.js';
import { useStore } from '../lib/store.js';
import { usePrefs, UI_SCALES } from '../lib/prefs.js';
import { useIsDesktop } from '../lib/useMedia.js';
import { useDockPos, saveDockPos, dockPlacement, dockWidth, clampDockPos, nudgeDock, DOCK_FALLBACK_H } from '../lib/voiceDock.js';
import { sessionLabel } from './ui.jsx';
import { t as tr, useT, fieldDir } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faArrowUpRightFromSquare, faCheck, faGripVertical, faMicrophone, faMicrophoneSlash, faPhoneSlash, faTriangleExclamation, faVolumeHigh, faXmark } from '@fortawesome/free-solid-svg-icons';
import { Button } from './ui/button.jsx';
import VoiceLangPicker from './VoiceLangPicker.jsx';
import { useHandsFree, stopHandsFree, toggleHandsFreeMute } from '../lib/handsfree.js';
import { useCall, hangUp, toggleMute } from '../lib/call.js';

// Actions that change app state but can't lose work → run automatically.
// inject_prompt sends words to a coding agent (possibly bypassPermissions) →
// always confirmed first.
// delete_session / archive_session are "safe" here because they only OPEN the
// existing confirmation dialog — the actual destructive step is confirmed there.
const SAFE = new Set([
  'select_session', 'next_session', 'prev_session', 'new_session', 'open_launcher',
  'open_terminal', 'open_changes', 'activate_tab', 'open_tab', 'reload_tab', 'close_tab',
  'rename_session', 'focus_input', 'set_theme', 'set_terminal', 'open_settings', 'dismiss',
  'delete_session', 'archive_session', 'restore_session',
]);

// How long a finished exchange ("Done.") stays on screen before the HUD closes.
const DONE_LINGER_MS = 1400;

function labelForAction(a, sessions) {
  switch (a.type) {
    case 'select_session': {
      const s = sessions.find((x) => x.id === a.sessionId);
      return tr('dialogs.voiceGoTo', { target: s ? sessionLabel(s) : tr('dialogs.voiceSessionFallback') });
    }
    case 'next_session': return tr('dialogs.voiceNextSession');
    case 'prev_session': return tr('dialogs.voicePrevSession');
    case 'new_session': return tr('dialogs.voiceNewSession');
    case 'open_changes': return tr('dialogs.voiceOpenChanges');
    case 'interrupt': return tr('dialogs.voiceInterrupt');
    case 'inject_prompt': return tr('dialogs.voiceSendPrompt');
    default: return a.type;
  }
}

// "Cmd+Shift+V" → "⌘⇧V" on Mac, "Ctrl+Shift+V" elsewhere (display only).
export function hotkeyLabel(hotkey, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
  if (!hotkey) return '';
  if (!mac) return hotkey.replace('Cmd', 'Ctrl');
  return hotkey.split('+').map((p) => ({ Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }[p] || p)).join('');
}

// Stage 1d (docs/VOICE.md): hands-free and call mode live in a small floating box instead of the centred
// window — by default over the bottom of the rail (desktop) / under the top bar (phone), so the chat stays
// uncovered. The header drags it; the grip also moves it with the arrow keys (Home = back to the default);
// a double-click on the header puts it back too. The spot is kept per device (lib/voiceDock.js).
const NOTE_KEYS = { needs_setup: 'dialogs.readAloudNeedsSetup', disabled: 'dialogs.readAloudDisabled', budget: 'dialogs.readAloudBudget' };

function viewport() {
  const w = typeof window !== 'undefined' ? window : null;
  return { vw: num(w?.innerWidth), vh: num(w?.innerHeight) };
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function useViewport() {
  const [vp, setVp] = useState(viewport);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const on = () => setVp(viewport());
    on();
    window.addEventListener('resize', on);
    window.visualViewport?.addEventListener?.('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      window.visualViewport?.removeEventListener?.('resize', on);
    };
  }, []);
  return vp;
}

function VoiceDock({ title, indicator, attrs, children, footer, t }) {
  const prefs = usePrefs();
  const isDesktop = useIsDesktop();
  const { vw, vh } = useViewport();
  const saved = useDockPos();
  const boxRef = useRef(null);
  const drag = useRef(null);
  const [live, setLive] = useState(null); // the position while a drag is under way
  const [h, setH] = useState(DOCK_FALLBACK_H);
  const rtl = typeof document !== 'undefined' && document.documentElement?.dir === 'rtl';
  const railPx = isDesktop ? (prefs.railWidth || 264) * (UI_SCALES[prefs.uiScale] || 1) : 0;
  const w = dockWidth({ vw, railPx, isDesktop });
  const geo = { vw, vh, w, h, rtl, isDesktop, railPx };
  const pos = live || dockPlacement({ saved, ...geo });
  const docked = !isDesktop; // phone: a compact bar docked at the bottom edge, no free drag

  // the height follows the content (a note, a longer line) — measured so the box is clamped by its real size
  useLayoutEffectSafe(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => { const nh = Math.round(el.offsetHeight || 0); if (nh) setH((cur) => (cur === nh ? cur : nh)); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [docked]);

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target?.closest?.('button:not([data-voice-dock-grip]), a, select, input, textarea')) return;
    drag.current = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y, at: pos, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const next = clampDockPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, geo);
    if (!d.moved && Math.abs(next.x - d.at.x) + Math.abs(next.y - d.at.y) < 3) return; // a click, not a drag
    d.moved = true;
    d.last = next;
    e.preventDefault();
    setLive(next);
  };
  const endDrag = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d.moved && d.last) saveDockPos(d.last);
    setLive(null);
  };
  const onGripKey = (e) => {
    const next = nudgeDock(pos, e.key, geo);
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    saveDockPos(next);
  };

  if (docked) {
    return (
      <div
        className="fixed inset-x-2 z-[70]"
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}
        data-voice-hud
        data-voice-dock="docked"
        {...attrs}
      >
        <div className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog">
          <div className="flex items-center gap-2 px-3 pt-2">
            {indicator}
            <span className="min-w-0 flex-1 truncate text-[12px] font-bold" {...title.attrs}>{title.text}</span>
          </div>
          <div className="px-3 py-1.5">{children}</div>
          <div className="flex items-center justify-between gap-1.5 border-t border-hair px-2.5 py-1.5">{footer}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className="fixed z-[70]"
      style={{ left: pos.x, top: pos.y, width: w }}
      data-voice-hud
      data-voice-dock={saved ? 'moved' : 'default'}
      {...attrs}
    >
      <div className={`overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog ${live ? 'ring-2 ring-ring' : ''}`}>
        <div
          className={`flex select-none items-center gap-2 border-b border-hair py-2 ps-1.5 pe-2.5 ${live ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(e) => { if (!e.target?.closest?.('button:not([data-voice-dock-grip]), select')) saveDockPos(null); }}
          data-voice-dock-handle
        >
          <button
            type="button"
            onKeyDown={onGripKey}
            aria-label={t('dialogs.voiceDock.move')}
            title={t('dialogs.voiceDock.move')}
            className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-[11px] text-fgdim hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            data-voice-dock-grip
          >
            <Icon icon={faGripVertical} />
          </button>
          {indicator}
          <span className="min-w-0 flex-1 truncate text-[12px] font-bold" {...title.attrs}>{title.text}</span>
        </div>
        <div className="px-3 py-2">{children}</div>
        <div className="flex items-center justify-between gap-1.5 border-t border-hair px-2.5 py-1.5">{footer}</div>
      </div>
    </div>
  );
}

// react-dom/server warns on useLayoutEffect; the box is only measured in a browser anyway.
const useLayoutEffectSafe = typeof window !== 'undefined' && typeof document !== 'undefined' && document.createElement ? useLayoutEffect : useEffect;

const Indicator = ({ phase, busy }) => (phase === 'speaking'
  ? <span className="shrink-0 text-[13px]"><Icon icon={faVolumeHigh} /></span>
  : busy ? <span className="host-spinner h-3.5 w-3.5 shrink-0" />
    : <span className="pulse-yellow h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />);

// the short live transcript: the latest sentence, two lines at most
const LastLine = ({ text, attr }) => (text
  ? <div dir="auto" className="line-clamp-2 text-[12px] leading-snug text-fg" title={text} {...{ [attr]: '' }}>“{text}”</div>
  : null);

function MuteButton({ muted, onClick, t, attrs }) {
  const label = muted ? t('dialogs.call.unmute') : t('dialogs.call.mute');
  return (
    <Button variant={muted ? 'default' : 'outline'} size="sm" onClick={onClick} aria-pressed={muted} aria-label={label} title={label} {...attrs}>
      <Icon icon={muted ? faMicrophoneSlash : faMicrophone} />
      <span className="hidden min-[360px]:inline">{label}</span>
    </Button>
  );
}

function HandsFreeHUD({ hf, status, level, error, t, onClose }) {
  const phase = hf.phase === 'idle' ? 'listening' : hf.phase;
  const note = NOTE_KEYS[hf.note] ? t(NOTE_KEYS[hf.note]) : hf.note || error;
  const title = hf.muted && phase === 'listening' ? t('dialogs.handsFree.muted') : t(`dialogs.handsFree.${phase}`);
  return (
    <VoiceDock
      t={t}
      attrs={{ 'data-voice-status': status, 'data-hands-free': hf.phase }}
      title={{ text: title, attrs: { 'data-voice-mode': 'handsfree' } }}
      indicator={hf.muted && phase === 'listening'
        ? <span className="shrink-0 text-[12px] text-fgdim"><Icon icon={faMicrophoneSlash} /></span>
        : <Indicator phase={phase} busy={phase === 'thinking'} />}
      footer={<>
        <MuteButton muted={!!hf.muted} onClick={toggleHandsFreeMute} t={t} attrs={{ 'data-hands-free-mute': hf.muted ? 'on' : 'off' }} />
        <Button variant="primary" size="sm" onClick={onClose} aria-label={t('dialogs.handsFreeStop')} title={t('dialogs.handsFreeStop')} data-hands-free-stop>
          <Icon icon={faPhoneSlash} /> {t('dialogs.handsFreeStop')}
        </Button>
      </>}
    >
      {status === 'recording' && phase === 'listening' && !hf.muted && (
        <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-hair">
          <div
            className="h-full rounded-full transition-[width] duration-100"
            style={{ width: `${Math.min(100, Math.round((level || 0) * 140))}%`, background: (level || 0) > 0.03 ? 'var(--color-brand, #E3B341)' : '#d9534f' }}
          />
        </div>
      )}
      <LastLine text={hf.lastText} attr="data-hands-free-last" />
      {note && <div className="mt-1 line-clamp-3 text-[11px] text-danger" data-hands-free-note>{note}</div>}
      {!hf.lastText && !note && <div className="line-clamp-2 text-[11px] text-fgdim max-md:hidden">{t('dialogs.handsFree.hint')}</div>}
    </VoiceDock>
  );
}

// Stage 1c: the call — connecting / listening / speaking / checking (a tool runs on the host), mute, hang up.
function CallHUD({ call, t }) {
  const phase = call.phase;
  const title = phase === 'tool' ? t('dialogs.call.tool', { tool: call.tool }) : t(`dialogs.call.${phase === 'idle' ? 'listening' : phase}`);
  return (
    <VoiceDock
      t={t}
      attrs={{ 'data-voice-call': phase }}
      title={{ text: title, attrs: { 'data-voice-mode': 'call' } }}
      indicator={<Indicator phase={phase} busy={phase === 'tool' || phase === 'connecting'} />}
      footer={<>
        <MuteButton muted={!!call.muted} onClick={toggleMute} t={t} attrs={{ 'data-voice-call-mute': call.muted ? 'on' : 'off' }} />
        <Button variant="primary" size="sm" onClick={() => hangUp('hangup')} aria-label={t('dialogs.call.hangUp')} title={t('dialogs.call.hangUp')} data-voice-call-hangup>
          <Icon icon={faPhoneSlash} /> {t('dialogs.call.hangUp')}
        </Button>
      </>}
    >
      <LastLine text={call.lastText} attr="data-voice-call-last" />
      {call.note && <div className="mt-1 line-clamp-3 text-[11px] text-danger" data-voice-call-note>{call.note}</div>}
      {!call.lastText && !call.note && <div className="line-clamp-2 text-[11px] text-fgdim max-md:hidden">{t('dialogs.call.hint')}</div>}
    </VoiceDock>
  );
}

export default function VoiceHUD() {
  const t = useT();
  const { status, mode, transcript, plan, error, level, turns, auto, relisten } = useVoice();
  const hf = useHandsFree();
  const call = useCall();
  const handsFree = hf.active;
  const dictate = mode === 'dictate' && !handsFree;
  const { sessions } = useStore();
  const prefs = usePrefs();
  const autoSend = prefs.voiceAutoSend;
  const [injects, setInjects] = useState([]); // pending inject actions (editable)
  const ranFor = useRef(null);
  const doneTimer = useRef(null);

  // When a plan arrives, auto-run the safe actions once and queue injects for
  // confirmation. (interrupt is treated as confirm-worthy too — it's queued.)
  // VOICE2: an 'act' plan ends the conversation — once everything ran and
  // nothing is queued, the HUD lingers a moment on "Done." and closes. 'ask' /
  // 'answer' plans have no actions: the loop (lib/voice.js) re-opens the mic.
  useEffect(() => {
    if (status !== 'review' || !plan || ranFor.current === plan) return;
    ranFor.current = plan;
    const pending = [];
    (async () => {
      // One shared context for the whole plan so a new_session/select_session
      // earlier in the utterance hands its session id to a later inject_prompt.
      const ctx = {};
      for (const a of plan.actions || []) {
        // inject_prompt is auto-sent only when the user opted to bypass the
        // confirmation; otherwise it's queued for the editable review below.
        if (SAFE.has(a.type) || (autoSend && a.type === 'inject_prompt' && a.text)) await runAction(a, ctx);
        else pending.push(a);
      }
      // Bake the resolved target into queued injects so the later Send lands on
      // the just-created/selected session, not the previously-active one.
      setInjects(pending.map((a) => ({ ...a, sessionId: ctx.targetSessionId || a.sessionId, text: a.text || '' })));
      if (pending.length) return;
      if (plan.kind === 'act') {
        if (doneTimer.current) clearTimeout(doneTimer.current);
        doneTimer.current = setTimeout(() => { doneTimer.current = null; clearPlan(); }, DONE_LINGER_MS);
      } else if (!plan.say) {
        clearPlan(); // nothing to confirm, nothing to show
      }
    })();
  }, [status, plan, autoSend]);
  useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current); }, []);

  // Dismissing the HUD must also tear down any LIVE capture — otherwise closing
  // mid-recording leaves the MediaRecorder, mic stream, meter interval and 90s
  // max-timer running with no UI (mic indicator stays on, old audio bleeds into
  // the next take). `cancel()` releases all of it and resets to idle; when we're
  // not recording, `clearPlan()` is enough.
  const close = () => {
    setInjects([]);
    ranFor.current = null;
    if (doneTimer.current) { clearTimeout(doneTimer.current); doneTimer.current = null; }
    if (call.active) { hangUp('hangup'); return; }
    if (handsFree) { stopHandsFree('stop'); return; }
    if (status === 'recording' || status === 'thinking') cancel();
    else clearPlan();
  };

  // VOICE2: Esc ends a command conversation from anywhere (capture phase, so
  // the app-level Esc-to-interrupt never sees it while the HUD is up).
  const open = status !== 'idle' || handsFree || call.active;
  useEffect(() => {
    if (!open || dictate) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setInjects([]);
      ranFor.current = null;
      if (call.active) hangUp('hangup');
      else if (handsFree) stopHandsFree('stop');
      else endConversation('stop');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dictate, handsFree, call.active]);

  if (!open) return null;
  if (call.active) return <CallHUD call={call} t={t} />;
  if (handsFree) return <HandsFreeHUD hf={hf} status={status} level={level} error={error} t={t} onClose={close} />;

  const sendInject = async (idx) => {
    const a = injects[idx];
    if (!a || !a.text.trim()) return;
    await runAction({ type: 'inject_prompt', sessionId: a.sessionId, text: a.text.trim() });
    const rest = injects.filter((_, i) => i !== idx);
    setInjects(rest);
    if (rest.length === 0) close();
  };

  const listeningForAnswer = status === 'recording' && auto;
  const hotkey = hotkeyLabel(prefs.voiceHotkey);
  // The exchange so far, minus the line already shown as the live transcript /
  // the router's current reply (both rendered below in their own slots).
  const history = dictate ? [] : turns.slice(0, Math.max(0, turns.length - (plan?.say ? 2 : 1)));
  const lastUser = !dictate && turns.length ? turns[turns.length - (plan?.say ? 2 : 1)]?.text : '';
  const shownTranscript = transcript || lastUser;

  return (
    <div className="fixed bottom-4 left-1/2 z-[70] w-[460px] max-w-[92vw] -translate-x-1/2" data-voice-hud data-voice-status={status}>
      <div className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog">
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-2.5">
          {status === 'recording' ? (
            <span className="pulse-yellow h-2.5 w-2.5 rounded-full bg-danger" />
          ) : status === 'thinking' ? (
            <span className="host-spinner h-3.5 w-3.5" />
          ) : status === 'error' ? (
            <span className="text-danger"><Icon icon={faTriangleExclamation} /></span>
          ) : status === 'nokey' ? (
            <span className="text-[13px] text-fgdim"><Icon icon={faMicrophoneSlash} /></span>
          ) : (
            <span className="text-[13px]"><Icon icon={faMicrophone} /></span>
          )}
          <span className="flex-1 text-[12px] font-bold" data-voice-mode={mode}>
            {status === 'recording' && (dictate ? t('dialogs.voiceDictating') : listeningForAnswer ? t('dialogs.voiceListeningAnswer') : t('dialogs.voiceListening'))}
            {status === 'thinking' && (dictate ? t('dialogs.voiceTranscribingOnly') : t('dialogs.voiceTranscribing'))}
            {status === 'review' && (relisten ? t('dialogs.voiceRelisten') : plan?.kind === 'ask' ? t('dialogs.voiceQuestion') : t('dialogs.voiceCommand'))}
            {status === 'error' && (dictate ? t('dialogs.voiceDictation') : t('dialogs.voiceError'))}
            {status === 'nokey' && t('dialogs.voiceNoKeyTitle')}
          </span>
          <button type="button" onClick={close} title={t('dialogs.cancel')} className="cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"><Icon icon={faXmark} /></button>
        </div>

        <div className="px-4 py-3">
          {/* no Groq key on the host: say so, and where to get one */}
          {status === 'nokey' && (
            <div data-voice-nokey className="text-[12px] leading-snug text-fg">
              <p className="mb-2">{t('dialogs.voiceNoKeyBody')}</p>
              <a
                href={GROQ_KEY_GUIDE}
                target="_blank"
                rel="noreferrer"
                data-voice-nokey-guide
                className="inline-flex min-h-7 items-center gap-1.5 font-medium text-info underline underline-offset-2 coarse:min-h-11"
              >
                {t('dialogs.voiceNoKeyGuide')} <Icon icon={faArrowUpRightFromSquare} className="text-[10px] rtl:-scale-x-100" />
              </a>
            </div>
          )}
          {/* VOICE2: the earlier turns of this exchange, chat-style */}
          {history.length > 0 && (
            <div className="mb-2.5 max-h-32 overflow-y-auto border-s-2 border-hair ps-2.5" data-voice-turns>
              {history.map((tn, i) => (
                <div key={i} dir="auto" className={`text-[11.5px] leading-snug ${tn.role === 'user' ? 'text-fg' : 'text-fgdim'}`}>
                  {tn.role === 'user' ? `“${tn.text}”` : tn.text}
                </div>
              ))}
            </div>
          )}
          {status === 'recording' && (
            <div className="mb-2.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-hair">
                <div
                  className="h-full rounded-full transition-[width] duration-100"
                  style={{ width: `${Math.min(100, Math.round((level || 0) * 140))}%`, background: (level || 0) > 0.03 ? 'var(--color-brand, #E3B341)' : '#d9534f' }}
                />
              </div>
              <div className="mt-1 font-mono text-[11.5px] md:text-[10px] text-fgdim">
                {(level || 0) > 0.03 ? <>{t('dialogs.voiceMicPicking')} <Icon icon={faCheck} /></> : t('dialogs.voiceNoInput')}
              </div>
            </div>
          )}
          {shownTranscript && status !== 'recording' && (
            <div dir="auto" className="mb-2.5 text-[12.5px] leading-snug text-fg">“{shownTranscript}”</div>
          )}
          {error && <div className="mb-2 text-[11.5px] text-danger">{error}</div>}
          {plan?.say && (
            <div dir="auto" data-voice-say data-voice-kind={plan.kind} className={`mb-2 ${plan.kind === 'ask' ? 'text-[13px] font-bold text-fg' : 'text-[12px] text-fgdim'}`}>
              {plan.say}
            </div>
          )}
          {/* the question is still on screen while the mic re-opens for the answer */}
          {status === 'recording' && listeningForAnswer && !plan?.say && turns.length > 0 && turns[turns.length - 1].role === 'assistant' && (
            <div dir="auto" data-voice-say className="mb-2 text-[13px] font-bold text-fg">{turns[turns.length - 1].text}</div>
          )}

          {status === 'review' && injects.length === 0 && plan?.kind === 'act' && (
            <div className="text-[11.5px] text-fgdim">{t('dialogs.voiceDone')}</div>
          )}

          {injects.map((a, i) => {
            const target = sessions.find((s) => s.id === a.sessionId);
            return (
              <div key={i} className="mb-2 rounded-[9px] border border-border bg-bg p-2.5" data-voice-inject>
                <div className="mb-1.5 font-mono text-[11.5px] md:text-[10px] tracking-[0.05em] text-fgdim uppercase">
                  {t('dialogs.voiceSendTo', { target: target ? sessionLabel(target) : t('dialogs.voiceCurrentSession') })}
                </div>
                <textarea
                  dir={fieldDir(a.text)}
                  rows={2}
                  value={a.text}
                  onChange={(e) => setInjects((arr) => arr.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  className="max-h-40 w-full resize-none rounded-[7px] border border-border bg-panel px-2.5 py-1.5 text-[12px] outline-none focus:border-ring"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => { const rest = injects.filter((_, j) => j !== i); setInjects(rest); if (!rest.length) close(); }}>
                    {t('dialogs.discard')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => sendInject(i)}>
                    {t('dialogs.send')} <span className="rtl:rotate-180" aria-hidden="true">→</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-hair px-4 py-2 font-mono text-[11.5px] md:text-[10px] text-fgdim">
          {/* VOICE1: the mic language, changeable right here (same pref as Settings) */}
          {status === 'nokey' ? <span /> : <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0">{t('dialogs.voiceLang')}</span>
            <VoiceLangPicker compact />
            {/* one hint, truncated: how to END while the loop is live, else the shortcut */}
            {!dictate && (listeningForAnswer || relisten || plan?.kind === 'ask' || plan?.kind === 'answer'
              ? <span className="hidden min-w-0 truncate sm:inline" data-voice-stop-hint>· {t('dialogs.voiceStopHint')}</span>
              : hotkey && <span className="hidden min-w-0 truncate sm:inline" data-voice-hotkey>· {hotkey} {t('dialogs.mic')}</span>)}
          </span>}
          {status === 'nokey' ? (
            <Button variant="outline" size="sm" onClick={close}>
              {t('dialogs.close')}
            </Button>
          ) : status === 'recording' ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {listeningForAnswer && (
                <Button variant="outline" size="sm" onClick={() => endConversation('stop')} data-voice-cancel>
                  {t('dialogs.cancel')}
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={stopRecording}>
                {listeningForAnswer ? t('dialogs.voiceDoneTalking') : t('dialogs.stop')}
              </Button>
            </span>
          ) : status === 'error' ? (
            <Button variant="outline" size="sm" onClick={() => { ranFor.current = null; startRecording({ mode }); }}>
              {t('dialogs.tryAgain')}
            </Button>
          ) : status === 'thinking' ? (
            <Button variant="outline" size="sm" onClick={cancel}>
              {t('dialogs.cancel')}
            </Button>
          ) : status === 'review' && !dictate && injects.length === 0 && plan?.kind !== 'act' ? (
            <Button variant="outline" size="sm" onClick={() => { ranFor.current = null; startRecording({ mode: 'command' }); }} data-voice-again>
              {t('dialogs.voiceSpeakAgain')}
            </Button>
          ) : <span />}
        </div>
      </div>
    </div>
  );
}
