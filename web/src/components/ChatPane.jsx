import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { answerPermission } from '../lib/store.js';
import { api } from '../lib/api.js';
import { usePrefs, termViewFrom } from '../lib/prefs.js';
import { agoTime } from '../lib/time.js';
import { Icon } from '../lib/icons.js';
import {
  faArrowDown,
  faCheck,
  faChevronDown,
  faChevronUp,
  faCircle,
  faFile,
  faImage,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

// Re-render tick so the humanized "2m ago" stamps on chat lines stay fresh.
function useNow(intervalMs) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

/* ---------- helpers ------------------------------------------------------ */

function textOf(e) {
  const t = e.text ?? e.content ?? e.message ?? e.output ?? '';
  if (typeof t === 'string') return t;
  if (Array.isArray(t))
    return t
      .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  try {
    return JSON.stringify(t, null, 2);
  } catch {
    return String(t);
  }
}

function diffStats(e) {
  const d = e.diff || e.stats || {};
  const add = e.additions ?? d.added ?? d.additions ?? d.plus;
  const del = e.deletions ?? d.removed ?? d.deletions ?? d.minus;
  if (add == null && del == null) return null;
  return { add, del };
}

function toolSummary(e) {
  if (e.summary) return e.summary;
  const input = e.input || {};
  const v =
    input.file_path ||
    input.path ||
    input.notebook_path ||
    input.command ||
    input.pattern ||
    input.query ||
    input.url ||
    input.prompt ||
    '';
  const s = typeof v === 'string' ? v : '';
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

function prettyInput(input) {
  if (input == null) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/* ---------- per-kind renderers ------------------------------------------- */

function UserMsg({ event }) {
  const atts = Array.isArray(event.attachments) ? event.attachments : [];
  const text = textOf(event);
  useNow(30_000); // Event is memoized, so each stamp refreshes itself
  return (
    <div className="my-2.5 flex flex-col items-end">
      <span className="mr-1 mb-0.5 flex items-center gap-1 font-mono text-[8.5px] font-bold tracking-[0.12em] text-[var(--term-userborder)] uppercase">
        <span className="h-[5px] w-[5px] rounded-full bg-brand" /> you
        {event.ts && (
          <span className="font-normal tracking-normal normal-case opacity-70">· {agoTime(event.ts)}</span>
        )}
      </span>
      <div
        dir="auto"
        className="max-w-[85%] rounded-[13px] rounded-tr-[4px] border border-[var(--term-userborder)] bg-[var(--term-userbg)] px-3.5 py-2 font-mono text-[12px] leading-relaxed font-medium whitespace-pre-wrap text-[var(--term-userfg)] shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
      >
        {text}
        {atts.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${text ? 'mt-1.5' : ''}`}>
            {atts.map((a, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--term-userborder)] bg-black/10 px-1.5 py-0.5 text-[10px]"
              >
                <Icon icon={a.isImage ? faImage : faFile} /> {a.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMsg({ event, recap }) {
  // The turn's final message gets a faint tint only — no border — so it reads
  // as gently set apart without shouting. Content is unchanged.
  return (
    <div className={`md my-1.5${recap ? ' rounded-[6px] bg-brand/[0.03] px-2 py-1' : ''}`}>
      <Markdown remarkPlugins={[remarkGfm]}>{textOf(event)}</Markdown>
    </div>
  );
}

function Thinking({ event }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer font-mono text-[10.5px] text-[var(--term-faint)] italic hover:text-[var(--term-dim)]"
      >
        <Icon icon={faWandMagicSparkles} /> thinking{open ? '' : '…'}
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-[var(--term-border)] pl-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-[var(--term-dim)] italic">
          {textOf(event)}
        </div>
      )}
    </div>
  );
}

// A code/diff slab — always LTR (code never flips for RTL prose) with a thin
// add/del/plain tint.
function CodeBlock({ text, sign }) {
  const bg = sign === '+' ? 'rgba(95,181,106,0.14)' : sign === '-' ? 'rgba(217,128,120,0.14)' : 'var(--term-codebg)';
  return (
    <pre
      dir="ltr"
      className="thin-scroll max-h-72 overflow-auto rounded-md px-2.5 py-1.5 text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--term-fg)]"
      style={{ background: bg }}
    >
      {String(text ?? '')}
    </pre>
  );
}

// Readable view of a tool's input: edits become old→new diffs, writes/commands
// become code, everything else falls back to pretty JSON.
function ToolDetail({ event }) {
  const name = String(event.name ?? event.tool ?? event.toolName ?? '');
  const input = event.input || {};
  if (/multiedit/i.test(name) && Array.isArray(input.edits)) {
    return (
      <div className="flex flex-col gap-2">
        {input.edits.map((ed, i) => (
          <div key={i} className="flex flex-col gap-1">
            {ed.old_string != null && <CodeBlock sign="-" text={ed.old_string} />}
            {ed.new_string != null && <CodeBlock sign="+" text={ed.new_string} />}
          </div>
        ))}
      </div>
    );
  }
  if (/edit|str.?replace/i.test(name) && (input.old_string != null || input.new_string != null)) {
    return (
      <div className="flex flex-col gap-1">
        {input.old_string != null && <CodeBlock sign="-" text={input.old_string} />}
        {input.new_string != null && <CodeBlock sign="+" text={input.new_string} />}
      </div>
    );
  }
  if (/write|create|notebook/i.test(name) && (input.content != null || input.new_source != null)) {
    return <CodeBlock sign="" text={input.content ?? input.new_source} />;
  }
  if (input.command != null) return <CodeBlock sign="" text={input.command} />;
  return <CodeBlock sign="" text={prettyInput(input)} />;
}

function ToolUse({ event }) {
  const [open, setOpen] = useState(false);
  const name = event.name ?? event.tool ?? event.toolName ?? 'tool';
  const stats = diffStats(event);
  const summary = toolSummary(event);
  const isWrite = /edit|write|create/i.test(String(name));
  return (
    <div className="my-0.5 font-mono text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded px-1 py-0.5 text-left whitespace-nowrap hover:bg-[var(--term-hover)]"
      >
        <span style={{ color: isWrite ? '#5fb56a' : '#5fa8d6' }}><Icon icon={faCircle} className="text-[7px]" /></span>
        <span className="shrink-0 font-bold text-[var(--term-fg)]">{name}</span>
        {summary && <span dir="ltr" className="truncate text-[var(--term-dim)]">{summary}</span>}
        {stats && (
          <span className="ml-1 shrink-0">
            {stats.add != null && <span className="text-diffadd">+{stats.add}</span>}
            {stats.del != null && <span className="ml-1.5 text-diffdel">−{stats.del}</span>}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[9px] text-[var(--term-faint)]"><Icon icon={open ? faChevronUp : faChevronDown} /></span>
      </button>
      {open && (
        <div className="mt-1 mb-1.5 rounded-lg border border-[var(--term-border)] bg-[var(--term-codebg)] p-1.5">
          <ToolDetail event={event} />
        </div>
      )}
    </div>
  );
}

function ToolResult({ event }) {
  const [open, setOpen] = useState(false);
  const isError = event.isError ?? event.is_error ?? false;
  const text = textOf(event).trimEnd();
  if (!text) return null;
  const lines = text.split('\n');
  const long = lines.length > 5 || text.length > 600;
  const shown = open || !long ? text : `${lines.slice(0, 5).join('\n').slice(0, 600)}…`;
  return (
    <div
      dir="ltr"
      className={`my-0.5 pl-4 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap ${
        isError ? 'text-diffdel' : 'text-[var(--term-dim)]'
      }`}
    >
      {shown}
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-1.5 cursor-pointer text-[var(--term-faint)] underline hover:text-[var(--term-dim)]"
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  );
}

function ResultLine({ event }) {
  const isError = event.isError ?? event.is_error ?? event.subtype === 'error';
  // The success `result` just echoes the final assistant message (already shown
  // above) — render a subtle end-of-turn marker instead of duplicating it as
  // raw text. Errors still show their message.
  if (!isError) {
    const meta = [
      event.numTurns != null ? `${event.numTurns} turn${event.numTurns === 1 ? '' : 's'}` : null,
      event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : null,
      event.costUsd ? `$${Number(event.costUsd).toFixed(3)}` : null,
    ].filter(Boolean).join(' · ');
    return (
      <div className="my-2 font-mono text-[10.5px] text-[var(--term-dim)]">
        <span className="text-diffadd"><Icon icon={faCheck} /></span> done{meta ? ` · ${meta}` : ''}
      </div>
    );
  }
  const text = textOf(event) || 'Errored.';
  return (
    <div dir="auto" className="my-2 font-mono text-[11.5px] whitespace-pre-wrap text-diffdel">
      <span className="text-diffdel"><Icon icon={faXmark} /></span> {text.length > 400 ? `${text.slice(0, 400)}…` : text}
    </div>
  );
}

function ErrorLine({ event }) {
  return (
    <div className="my-1.5 font-mono text-[11px] whitespace-pre-wrap text-diffdel">
      <Icon icon={faXmark} /> {textOf(event)}
    </div>
  );
}

function AskUserQuestion({ sessionId, event, live }) {
  // The chosen label per question index — purely local, the answer is posted
  // as a normal chat message (same call ChatFooter uses).
  const [picked, setPicked] = useState({});
  const [skipped, setSkipped] = useState({});
  const [busy, setBusy] = useState(false);
  const questions = Array.isArray(event.input?.questions) ? event.input.questions : [];

  const choose = async (qi, label) => {
    if (busy || picked[qi] != null || skipped[qi]) return;
    setBusy(true);
    try {
      await api.post(`/sessions/${sessionId}/message`, { text: label });
      setPicked((p) => ({ ...p, [qi]: label }));
      window.dispatchEvent(new CustomEvent('host:focus-input')); // back to the composer
    } catch {
      /* leave un-picked so the user can retry */
    }
    setBusy(false);
  };

  // Escape hatch for a stuck question: exit without forcing a matching
  // option pick — e.g. none of the options fit, or the turn behind this
  // question already died and answering does nothing anyway.
  const skip = async (qi) => {
    if (busy || picked[qi] != null || skipped[qi]) return;
    setBusy(true);
    try {
      await api.post(`/sessions/${sessionId}/message`, { text: '(skipped this question)' });
    } catch {
      /* exit the stuck card locally even if the message failed to send */
    }
    setSkipped((p) => ({ ...p, [qi]: true }));
    window.dispatchEvent(new CustomEvent('host:focus-input')); // back to the composer
    setBusy(false);
  };

  // Keyboard: answer the first unanswered question with number keys (1–9),
  // Esc/s to skip. Focus the first option so arrows/Enter work too. Only while a
  // question is outstanding, so digits don't get captured once you're done.
  const cardRef = useRef(null);
  const activeQi = questions.findIndex((q, qi) => picked[qi] == null && !skipped[qi]);
  useEffect(() => {
    // Only the LIVE question grabs focus and the arrow/number/Esc keys. `live`
    // (computed in ChatPane) = the session is awaiting-input AND this is the
    // most-recent question card — so earlier unanswered questions in the same
    // transcript don't also bind handlers and fight over focus.
    if (!live || activeQi < 0 || busy) return;
    cardRef.current?.querySelector('button[data-opt]')?.focus();
    const onKey = (e) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'button'));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const opts = Array.isArray(questions[activeQi]?.options) ? questions[activeQi].options : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Move the highlight between the active question's option buttons; Enter
        // then picks the focused one (native button activation).
        const btns = [...(cardRef.current?.querySelectorAll('button[data-opt]') || [])];
        if (!btns.length) return;
        e.preventDefault(); e.stopPropagation();
        const cur = btns.indexOf(el);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const start = cur < 0 ? (step > 0 ? -1 : 0) : cur;
        btns[(start + step + btns.length) % btns.length].focus();
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < opts.length) {
          e.preventDefault(); e.stopPropagation();
          const o = opts[idx];
          choose(activeQi, typeof o === 'string' ? o : o?.label ?? '');
        }
      } else if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
        e.preventDefault(); e.stopPropagation();
        skip(activeQi);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQi, busy, live]);

  return (
    <div ref={cardRef} className="my-2.5 rounded-[10px] border border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] p-3">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="pulse-yellow h-[7px] w-[7px] rounded-full bg-brand" />
        <span className="font-bold text-[var(--term-accent-strong)]">Question for you</span>
      </div>
      {questions.map((q, qi) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const chosen = picked[qi];
        const wasSkipped = skipped[qi];
        return (
          <div key={qi} className="mt-3 first:mt-2.5">
            {q.header && (
              <div className="mb-0.5 font-mono text-[10px] tracking-[0.06em] text-[var(--term-accent-dim)] uppercase">
                {q.header}
              </div>
            )}
            {q.question && (
              <div className="mb-2 text-[12px] leading-snug text-[var(--term-accent-fg)]">{q.question}</div>
            )}
            {wasSkipped ? (
              <span className="font-mono text-[10.5px] text-[var(--term-accent-dim)]"><Icon icon={faXmark} /> skipped</span>
            ) : (
              <>
            <div className="flex flex-col gap-1.5">
              {options.map((opt, oi) => {
                const label = typeof opt === 'string' ? opt : opt?.label ?? '';
                const description = typeof opt === 'string' ? '' : opt?.description ?? '';
                const isChosen = chosen === label;
                const settled = chosen != null;
                return (
                  <button
                    key={oi}
                    type="button"
                    data-opt={qi === activeQi ? '' : undefined}
                    disabled={busy || settled}
                    onClick={() => choose(qi, label)}
                    className={`cursor-pointer rounded-[7px] border-[1.5px] px-3 py-2 text-left outline-none transition-shadow focus-visible:border-brand focus-visible:shadow-[0_0_0_2px_var(--term-accent-strong)] disabled:cursor-default ${
                      isChosen
                        ? 'border-ink bg-brand text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]'
                        : settled
                          ? 'border-[var(--term-accent-border)] bg-transparent opacity-40'
                          : 'border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] hover:border-brand'
                    }`}
                  >
                    <span
                      className={`block text-[12px] font-bold ${isChosen ? 'text-[#1a1a1a]' : 'text-[var(--term-accent-strong)]'}`}
                    >
                      {oi < 9 && !settled && (
                        <span className="mr-1.5 font-mono text-[10px] text-[var(--term-accent-dim)]">{oi + 1}</span>
                      )}
                      {label}
                      {isChosen && <Icon icon={faCheck} className="ml-1" />}
                    </span>
                    {description && (
                      <span
                        className={`mt-0.5 block text-[11px] leading-snug ${isChosen ? 'text-[#4a3f12]' : 'text-[var(--term-accent-dim)]'}`}
                      >
                        {description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {chosen == null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => skip(qi)}
                className="mt-1.5 cursor-pointer font-mono text-[10.5px] text-[var(--term-accent-dim)] underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
              >
                skip this question
              </button>
            )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PermissionRequest({ sessionId, event, live: isLive }) {
  const [busy, setBusy] = useState(false);
  // If the server already resolved this request (timeout, or the process
  // died) before we clicked, retrying would just 404 forever — treat any
  // answer failure as "gone" so the card stops offering live buttons.
  const [expired, setExpired] = useState(false);
  const answered = event.answered;
  const toolName = event.toolName ?? event.tool_name ?? event.name ?? 'tool';
  const allowRef = useRef(null);
  const answer = async (behavior) => {
    setBusy(true);
    try {
      await answerPermission(sessionId, event.requestId ?? event.request_id, behavior);
      // Hand focus back to the composer so keyboard flow continues.
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch {
      setBusy(false);
      setExpired(true);
    }
  };
  // A live request is the actionable card: focus Allow so Enter approves, and
  // bind Enter/Esc (and y/n) globally so keyboard users can answer without a
  // mouse. `isLive` (from ChatPane) = the session is blocked on the MOST RECENT
  // request, so an old/stale card never grabs focus/keys.
  const live = !answered && !expired && !busy && isLive;
  useEffect(() => {
    if (!live) return;
    allowRef.current?.focus();
    const onKey = (e) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'button'));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') { e.preventDefault(); e.stopPropagation(); answer('allow'); }
      else if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') { e.preventDefault(); e.stopPropagation(); answer('deny'); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  return (
    <div className="my-2.5 rounded-[10px] border border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] p-3">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="pulse-yellow h-[7px] w-[7px] rounded-full bg-brand" />
        <span className="font-bold text-[var(--term-accent-strong)]">Permission request</span>
        <span className="text-[var(--term-accent-dim)]">{toolName}</span>
      </div>
      {event.input != null && (
        <pre className="thin-scroll mt-2 max-h-40 overflow-auto rounded-lg bg-[var(--term-codebg)] p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--term-dim)]">
          {prettyInput(event.input)}
        </pre>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        {answered ? (
          <span className="font-mono text-[10.5px] text-[var(--term-accent-dim)]">
            {answered === 'allow' ? <><Icon icon={faCheck} /> allowed</> : <><Icon icon={faXmark} /> denied</>}
            {event.answeredMessage ? ` (${event.answeredMessage})` : ''}
          </span>
        ) : expired ? (
          <span className="font-mono text-[10.5px] text-[var(--term-accent-dim)]">
            <Icon icon={faXmark} /> no longer answerable — this request has expired
          </span>
        ) : (
          <>
            <button
              ref={allowRef}
              type="button"
              disabled={busy}
              onClick={() => answer('allow')}
              title="Allow (Enter / y)"
              className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50"
            >
              Allow
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => answer('deny')}
              title="Deny (Esc / n)"
              className="cursor-pointer rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-3.5 py-1.5 text-[11.5px] text-[var(--term-accent-dim)] hover:bg-[var(--term-accent-bg)] disabled:opacity-50"
            >
              Deny
            </button>
            <span className="ml-1 font-mono text-[10px] text-[var(--term-accent-dim)]">Enter/y · Esc/n</span>
          </>
        )}
      </div>
    </div>
  );
}

// host.request_action — rendered inline in the transcript (not pinned under the
// input). Buttons are human-click-only; the answer is delivered as a message.
function ActionCard({ sessionId, action }) {
  const [busy, setBusy] = useState(false);
  if (!action || !Array.isArray(action.buttons)) return null;
  const answer = async (value) => {
    setBusy(true);
    try { await api.post(`/sessions/${sessionId}/action/answer`, { value }); } catch { setBusy(false); }
  };
  // Escape hatch: none of the options fit (or the prompt is stale) — clear the
  // sticky bar and keep chatting. The tool call already returned, so this
  // doesn't leave the model waiting.
  const dismiss = async () => {
    setBusy(true);
    try { await api.post(`/sessions/${sessionId}/action/dismiss`, {}); } catch { setBusy(false); }
  };
  const btnClass = (style) =>
    style === 'primary'
      ? 'border-ink bg-brand text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a]'
      : style === 'danger'
        ? 'border-danger bg-danger text-white'
        : 'border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] text-[var(--term-accent-strong)] hover:border-brand';
  return (
    <div className="my-2.5 rounded-[10px] border border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] p-3">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="pulse-yellow h-[7px] w-[7px] rounded-full bg-brand" />
        <span className="font-bold text-[var(--term-accent-strong)]">Action needed</span>
        <button
          type="button"
          disabled={busy}
          onClick={dismiss}
          title="Dismiss — none of these"
          aria-label="Dismiss"
          className="ml-auto cursor-pointer rounded px-1.5 text-[13px] leading-none text-[var(--term-accent-dim)] hover:text-[var(--term-accent-strong)] disabled:opacity-40"
        >
          <Icon icon={faXmark} />
        </button>
      </div>
      <div dir="auto" className="mt-2 text-[12px] leading-snug text-[var(--term-accent-fg)]">{action.prompt}</div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {action.buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            disabled={busy}
            onClick={() => answer(b.value)}
            className={`cursor-pointer rounded-[7px] border-[1.5px] px-3.5 py-1.5 text-[11.5px] font-bold disabled:opacity-50 ${btnClass(b.style)}`}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- the pane ------------------------------------------------------ */

// Memoized: the store keeps every settled event's object identity stable and
// only replaces the trailing (streaming) one, so a delta re-renders exactly one
// row instead of re-parsing markdown for the whole transcript.
const Event = memo(function Event({ sessionId, event, live, recap }) {
  switch (event.kind) {
    case 'user':
      return <UserMsg event={event} />;
    case 'assistant-text':
    case 'assistant':
      return <AssistantMsg event={event} recap={recap} />;
    case 'thinking':
      return <Thinking event={event} />;
    case 'tool-use': {
      const name = event.name ?? event.tool ?? event.toolName;
      if (name === 'AskUserQuestion')
        return <AskUserQuestion sessionId={sessionId} event={event} live={live} />;
      return <ToolUse event={event} />;
    }
    case 'tool-result':
      return <ToolResult event={event} />;
    case 'result':
      return <ResultLine event={event} />;
    case 'error':
      return <ErrorLine event={event} />;
    case 'permission-request': {
      // AskUserQuestion is auto-approved server-side and answered through the
      // "Question for you" card, so its permission bubble is redundant — never
      // render it (covers any such event persisted before the server change).
      const tn = event.toolName ?? event.tool_name ?? event.name;
      if (tn === 'AskUserQuestion') return null;
      return <PermissionRequest sessionId={sessionId} event={event} live={live} />;
    }
    default:
      return null; // unknown kinds are skipped, not crashed on
  }
});

// Long transcripts: only the trailing window is mounted; "show earlier" widens
// it. This caps the DOM instead of virtualizing — chat rows have local UI state
// (expanded tools, picked answers) that a real virtualizer would drop on
// unmount, and heights here are too dynamic (streaming markdown) to measure
// reliably.
const WINDOW = 150;
const REVEAL = 300;

export default function ChatPane({ sessionId, events, working, action, loading, awaiting }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  // Scrolled away from the bottom → show the floating "jump to latest" button.
  const [away, setAway] = useState(false);
  const [shown, setShown] = useState(WINDOW);
  // Distance-from-bottom captured when revealing earlier rows, so the content
  // the user was looking at stays put after the prepend.
  const anchorRef = useRef(null);
  const prefs = usePrefs();
  const termFontSize = prefs.termFontSize;
  const view = termViewFrom(prefs, sessionId);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = dist < 48;
    setAway(dist > 160);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAway(false);
  };

  // Streaming deltas merge into the LAST event and the final message replaces
  // the partial, so `events.length` never changes mid-stream — depend on the
  // trailing event's text length too, or the pane stops following a long reply
  // until the next discrete event appends.
  const lastLen = events[events.length - 1]?.text?.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length, lastLen, working]);

  // new session selected → snap to bottom, back to the default window
  useEffect(() => {
    stickRef.current = true;
    setAway(false);
    setShown(WINDOW);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  const hiddenCount = Math.max(0, events.length - shown);

  const revealEarlier = () => {
    const el = scrollRef.current;
    anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setShown((n) => n + REVEAL);
  };

  // Re-anchor after the earlier rows mount, before the browser paints.
  useLayoutEffect(() => {
    if (anchorRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchorRef.current;
    anchorRef.current = null;
  }, [shown]);

  // The renderers use fixed-px Tailwind classes, so scale the whole output via
  // CSS zoom relative to the 12px default (clean, overrides fixed sizes).
  const scale = (termFontSize || 12) / 12;

  return (
    <div className="relative min-h-0 flex-1">
    <div
      ref={scrollRef}
      onScroll={onScroll}
      dir={view.dir || 'auto'}
      className={`term ${view.theme === 'light' ? 'term-light' : ''} thin-scroll h-full overflow-y-auto bg-[var(--term-bg)] px-4 py-3.5`}
    >
      <div className="term-events" style={scale === 1 ? undefined : { zoom: scale }}>
        {hiddenCount > 0 && (
          <div className="pb-2 text-center">
            <button
              type="button"
              onClick={revealEarlier}
              className="cursor-pointer rounded-md border border-[var(--term-border)] px-2.5 py-1 font-mono text-[10.5px] text-[var(--term-dim)] hover:bg-[var(--term-hover)]"
            >
              <Icon icon={faChevronUp} /> show earlier ({hiddenCount} hidden)
            </button>
          </div>
        )}
        {events.length === 0 &&
          (loading ? (
            <div className="flex items-center justify-center gap-2 py-6 font-mono text-[11px] text-[var(--term-faint)]">
              <span className="host-spinner h-3 w-3" /> loading transcript…
            </div>
          ) : (
            <div className="py-6 text-center font-mono text-[11px] text-[var(--term-faint)]">
              No messages yet — say something below.
            </div>
          ))}
        {(() => {
          // Stable keys independent of absolute position: when history
          // rehydrates it prepends the persisted snapshot, shifting every
          // index — index keys would remount each event and reset per-event
          // local UI state (expanded ToolUse/Thinking, a picked answer in an
          // AskUserQuestion card). Derive the key from identity/content, with a
          // per-key counter to keep duplicate (kind,ts) pairs distinct.
          const seen = new Map();
          // A transcript can hold several unanswered question / permission cards
          // (earlier turns that were interrupted). Only the MOST RECENT one is
          // the card the session is actually blocked on — so only it may grab
          // focus and the keyboard. Find those indices once.
          const isAsk = (e) => e.kind === 'tool-use' && (e.name ?? e.tool ?? e.toolName) === 'AskUserQuestion';
          const isPerm = (e) => e.kind === 'permission-request' && (e.toolName ?? e.tool_name ?? e.name) !== 'AskUserQuestion';
          let lastAskIdx = -1, lastPermIdx = -1;
          // "Recap" = each completed turn's final assistant message (the last
          // assistant-text before a success `result`) — given a faint tint so
          // the turn's takeaway reads as slightly set apart. In-progress turns
          // have no result yet, so their tail tints only once the turn ends.
          const recap = new Set();
          let pendingAssistant = -1;
          events.forEach((e, i) => {
            if (isAsk(e)) lastAskIdx = i;
            else if (isPerm(e)) lastPermIdx = i;
            if (e.kind === 'assistant-text' || e.kind === 'assistant') pendingAssistant = i;
            else if (e.kind === 'result' && !(e.isError ?? e.is_error)) {
              if (pendingAssistant >= 0) recap.add(pendingAssistant);
              pendingAssistant = -1;
            }
          });
          // Keys are derived over the FULL list (not the visible slice) so the
          // duplicate-(kind,ts) counter doesn't renumber — and remount — rows
          // as the window slides.
          const keys = events.map((e) => {
            let k = e.id ?? e.requestId;
            if (!k) {
              const base = `${e.kind ?? 'k'}:${e.ts ?? 'n'}`;
              const n = seen.get(base) || 0;
              seen.set(base, n + 1);
              k = n ? `${base}#${n}` : base;
            }
            return k;
          });
          return events.slice(hiddenCount).map((e, j) => {
            const i = hiddenCount + j;
            const live = !!awaiting && ((isAsk(e) && i === lastAskIdx) || (isPerm(e) && i === lastPermIdx));
            return <Event key={keys[i]} sessionId={sessionId} event={e} live={live} recap={recap.has(i)} />;
          });
        })()}
        {action && <ActionCard sessionId={sessionId} action={action} />}
        {working && (
          <div className="my-2 flex items-center gap-2 font-mono text-[11px] text-[var(--term-dim)]">
            <span className="host-spinner h-3 w-3" />
            working…
          </div>
        )}
      </div>
    </div>
    {away && (
      <button
        type="button"
        onClick={jumpToBottom}
        title="Jump to latest"
        aria-label="Jump to latest"
        className="absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-ink bg-panel text-[13px] text-fg shadow-[2px_2px_0_rgba(42,42,42,0.35)] hover:bg-chip"
      >
        <Icon icon={faArrowDown} />
      </button>
    )}
    </div>
  );
}
