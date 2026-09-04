import { useEffect, useRef, useState } from 'react';
import { useVoice, stopRecording, cancel, clearPlan, startRecording, endConversation } from '../lib/voice.js';
import { runAction } from '../lib/commands.js';
import { useStore } from '../lib/store.js';
import { usePrefs } from '../lib/prefs.js';
import { sessionLabel } from './ui.jsx';
import { t as tr, useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faCheck, faMicrophone, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import VoiceLangPicker from './VoiceLangPicker.jsx';

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

export default function VoiceHUD() {
  const t = useT();
  const { status, mode, transcript, plan, error, level, turns, auto, relisten } = useVoice();
  const dictate = mode === 'dictate';
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
    if (status === 'recording' || status === 'thinking') cancel();
    else clearPlan();
  };

  // VOICE2: Esc ends a command conversation from anywhere (capture phase, so
  // the app-level Esc-to-interrupt never sees it while the HUD is up).
  const open = status !== 'idle';
  useEffect(() => {
    if (!open || dictate) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setInjects([]);
      ranFor.current = null;
      endConversation('stop');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dictate]);

  if (!open) return null;

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
      <div className="overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]">
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-2.5">
          {status === 'recording' ? (
            <span className="pulse-yellow h-2.5 w-2.5 rounded-full bg-danger" />
          ) : status === 'thinking' ? (
            <span className="host-spinner h-3.5 w-3.5" />
          ) : status === 'error' ? (
            <span className="text-danger"><Icon icon={faTriangleExclamation} /></span>
          ) : (
            <span className="text-[13px]"><Icon icon={faMicrophone} /></span>
          )}
          <span className="flex-1 text-[12px] font-bold" data-voice-mode={mode}>
            {status === 'recording' && (dictate ? t('dialogs.voiceDictating') : listeningForAnswer ? t('dialogs.voiceListeningAnswer') : t('dialogs.voiceListening'))}
            {status === 'thinking' && (dictate ? t('dialogs.voiceTranscribingOnly') : t('dialogs.voiceTranscribing'))}
            {status === 'review' && (relisten ? t('dialogs.voiceRelisten') : plan?.kind === 'ask' ? t('dialogs.voiceQuestion') : t('dialogs.voiceCommand'))}
            {status === 'error' && (dictate ? t('dialogs.voiceDictation') : t('dialogs.voiceError'))}
          </span>
          <button type="button" onClick={close} title={t('dialogs.cancel')} className="cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"><Icon icon={faXmark} /></button>
        </div>

        <div className="px-4 py-3">
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
              <div className="mt-1 font-mono text-[10px] text-fgdim">
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
                <div className="mb-1.5 font-mono text-[10px] tracking-[0.05em] text-fgdim uppercase">
                  {t('dialogs.voiceSendTo', { target: target ? sessionLabel(target) : t('dialogs.voiceCurrentSession') })}
                </div>
                <textarea
                  dir="auto"
                  rows={2}
                  value={a.text}
                  onChange={(e) => setInjects((arr) => arr.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  className="max-h-40 w-full resize-none rounded-[7px] border border-border bg-panel px-2.5 py-1.5 text-[12px] outline-none focus:border-ink"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { const rest = injects.filter((_, j) => j !== i); setInjects(rest); if (!rest.length) close(); }}
                    className="cursor-pointer rounded-[7px] border-[1.5px] border-border px-3 py-1 text-[11.5px] text-fgdim hover:border-ink hover:text-fg"
                  >
                    {t('dialogs.discard')}
                  </button>
                  <button
                    type="button"
                    onClick={() => sendInject(i)}
                    className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]"
                  >
                    {t('dialogs.send')} →
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-hair px-4 py-2 font-mono text-[10px] text-fgdim">
          {/* VOICE1: the mic language, changeable right here (same pref as Settings) */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0">{t('dialogs.voiceLang')}</span>
            <VoiceLangPicker compact />
            {/* one hint, truncated: how to END while the loop is live, else the shortcut */}
            {!dictate && (listeningForAnswer || relisten || plan?.kind === 'ask' || plan?.kind === 'answer'
              ? <span className="hidden min-w-0 truncate sm:inline" data-voice-stop-hint>· {t('dialogs.voiceStopHint')}</span>
              : hotkey && <span className="hidden min-w-0 truncate sm:inline" data-voice-hotkey>· {hotkey} {t('dialogs.mic')}</span>)}
          </span>
          {status === 'recording' ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {listeningForAnswer && (
                <button type="button" onClick={() => endConversation('stop')} className="cursor-pointer rounded-[6px] border-[1.5px] border-border px-3 py-1 text-[11px] hover:border-ink" data-voice-cancel>
                  {t('dialogs.cancel')}
                </button>
              )}
              <button type="button" onClick={stopRecording} className="cursor-pointer rounded-[6px] border-[1.5px] border-ink bg-brand px-3 py-1 text-[11px] font-bold text-[#1a1a1a]">
                {listeningForAnswer ? t('dialogs.voiceDoneTalking') : t('dialogs.stop')}
              </button>
            </span>
          ) : status === 'error' ? (
            <button type="button" onClick={() => { ranFor.current = null; startRecording({ mode }); }} className="cursor-pointer rounded-[6px] border-[1.5px] border-border px-3 py-1 text-[11px] hover:border-ink">
              {t('dialogs.tryAgain')}
            </button>
          ) : status === 'thinking' ? (
            <button type="button" onClick={cancel} className="cursor-pointer rounded-[6px] border-[1.5px] border-border px-3 py-1 text-[11px] hover:border-ink">
              {t('dialogs.cancel')}
            </button>
          ) : status === 'review' && !dictate && injects.length === 0 && plan?.kind !== 'act' ? (
            <button type="button" onClick={() => { ranFor.current = null; startRecording({ mode: 'command' }); }} className="cursor-pointer rounded-[6px] border-[1.5px] border-border px-3 py-1 text-[11px] hover:border-ink" data-voice-again>
              {t('dialogs.voiceSpeakAgain')}
            </button>
          ) : <span />}
        </div>
      </div>
    </div>
  );
}
