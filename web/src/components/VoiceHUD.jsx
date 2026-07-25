import { useEffect, useRef, useState } from 'react';
import { useVoice, stopRecording, cancel, clearPlan, startRecording } from '../lib/voice.js';
import { runAction } from '../lib/commands.js';
import { useStore } from '../lib/store.js';
import { usePrefs } from '../lib/prefs.js';
import { sessionLabel } from './ui.jsx';
import { Icon } from '../lib/icons.js';
import { faCheck, faMicrophone, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';

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

function labelForAction(a, sessions) {
  switch (a.type) {
    case 'select_session': {
      const s = sessions.find((x) => x.id === a.sessionId);
      return `Go to ${s ? sessionLabel(s) : 'session'}`;
    }
    case 'next_session': return 'Next session';
    case 'prev_session': return 'Previous session';
    case 'new_session': return 'New session';
    case 'open_changes': return 'Open changes';
    case 'interrupt': return 'Interrupt';
    case 'inject_prompt': return 'Send prompt';
    default: return a.type;
  }
}

export default function VoiceHUD() {
  const { status, transcript, plan, error, level } = useVoice();
  const { sessions } = useStore();
  const autoSend = usePrefs().voiceAutoSend;
  const [injects, setInjects] = useState([]); // pending inject actions (editable)
  const ranFor = useRef(null);

  // When a plan arrives, auto-run the safe actions once and queue injects for
  // confirmation. (interrupt is treated as confirm-worthy too — it's queued.)
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
      // Nothing to confirm and no message to show → close.
      if (pending.length === 0 && !plan.say) clearPlan();
    })();
  }, [status, plan, autoSend]);

  if (status === 'idle') return null;

  // Dismissing the HUD must also tear down any LIVE capture — otherwise closing
  // mid-recording leaves the MediaRecorder, mic stream, meter interval and 90s
  // max-timer running with no UI (mic indicator stays on, old audio bleeds into
  // the next take). `cancel()` releases all of it and resets to idle; when we're
  // not recording, `clearPlan()` is enough.
  const close = () => {
    setInjects([]);
    ranFor.current = null;
    if (status === 'recording') cancel();
    else clearPlan();
  };

  const sendInject = async (idx) => {
    const a = injects[idx];
    if (!a || !a.text.trim()) return;
    await runAction({ type: 'inject_prompt', sessionId: a.sessionId, text: a.text.trim() });
    const rest = injects.filter((_, i) => i !== idx);
    setInjects(rest);
    if (rest.length === 0) close();
  };

  return (
    <div className="fixed bottom-4 left-1/2 z-[70] w-[460px] max-w-[92vw] -translate-x-1/2">
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
          <span className="flex-1 text-[12px] font-bold">
            {status === 'recording' && 'Listening… (speak, then Stop)'}
            {status === 'thinking' && 'Transcribing & understanding…'}
            {status === 'review' && 'Voice command'}
            {status === 'error' && 'Voice error'}
          </span>
          <button type="button" onClick={close} className="cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg"><Icon icon={faXmark} /></button>
        </div>

        <div className="px-4 py-3">
          {status === 'recording' && (
            <div className="mb-2.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-hair">
                <div
                  className="h-full rounded-full transition-[width] duration-100"
                  style={{ width: `${Math.min(100, Math.round((level || 0) * 140))}%`, background: (level || 0) > 0.03 ? 'var(--color-brand, #E3B341)' : '#d9534f' }}
                />
              </div>
              <div className="mt-1 font-mono text-[10px] text-fgdim">
                {(level || 0) > 0.03 ? <>mic is picking you up <Icon icon={faCheck} /></> : 'no input detected — check your mic'}
              </div>
            </div>
          )}
          {transcript && (
            <div dir="auto" className="mb-2.5 text-[12.5px] leading-snug text-fg">“{transcript}”</div>
          )}
          {error && <div className="mb-2 text-[11.5px] text-danger">{error}</div>}
          {plan?.say && <div dir="auto" className="mb-2 text-[12px] text-fgdim">{plan.say}</div>}

          {status === 'review' && injects.length === 0 && !plan?.say && (
            <div className="text-[11.5px] text-fgdim">Done.</div>
          )}

          {injects.map((a, i) => {
            const target = sessions.find((s) => s.id === a.sessionId);
            return (
              <div key={i} className="mb-2 rounded-[9px] border border-border bg-bg p-2.5">
                <div className="mb-1.5 font-mono text-[10px] tracking-[0.05em] text-fgdim uppercase">
                  Send to {target ? sessionLabel(target) : 'current session'}
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
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => sendInject(i)}
                    className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]"
                  >
                    Send →
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-hair px-4 py-2 font-mono text-[10px] text-fgdim">
          <span>⌘⇧V mic</span>
          {status === 'recording' ? (
            <button type="button" onClick={stopRecording} className="cursor-pointer rounded-[6px] border-[1.5px] border-ink bg-brand px-3 py-1 text-[11px] font-bold text-[#1a1a1a]">
              Stop
            </button>
          ) : status === 'error' ? (
            <button type="button" onClick={() => { ranFor.current = null; startRecording(); }} className="cursor-pointer rounded-[6px] border-[1.5px] border-border px-3 py-1 text-[11px] hover:border-ink">
              Try again
            </button>
          ) : status === 'thinking' ? (
            <button type="button" onClick={cancel} className="cursor-pointer rounded-[6px] border-[1.5px] border-border px-3 py-1 text-[11px] hover:border-ink">
              Cancel
            </button>
          ) : <span />}
        </div>
      </div>
    </div>
  );
}
