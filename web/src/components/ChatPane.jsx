import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { answerPermission, cancelScreenRequest, openScreenTakeover, loadOlderChat, loadFullChatEvent, chatHasMore, useStore, SCREEN_CANCEL_NOTE } from '../lib/store.js';
import { api } from '../lib/api.js';
import ScreenView from './ScreenView.jsx';
import SetupCard from './setup/SetupCard.jsx';
import { MergeEvent, MergePanel } from './MergeCard.jsx';
import OpenUICard from './OpenUICard.jsx';
import { HostCard } from '../openui/host.jsx';
import { SCREEN_PRIORITY, isVncInputTarget } from '../lib/useScreenConnection.js';
import { usePrefs, termViewFrom } from '../lib/prefs.js';
import { hiddenInSimple, isAction, groupHasSubstance } from '../lib/chatMode.js';
import { agoTime } from '../lib/time.js';
import { Icon } from '../lib/icons.js';
import { useT, dirOf } from '../lib/i18n.js';
import { engineLabel } from '../lib/engines.js';
import {
  faArrowDown,
  faArrowRotateRight,
  faBoxArchive,
  faCheck,
  faChevronDown,
  faChevronUp,
  faCircle,
  faCopy,
  faFile,
  faImage,
  faReply,
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

// Fires a custom event that ChatFooter listens for to populate the quote
// preview above the composer. Decoupled: ChatPane doesn't import ChatFooter.
function QuoteButton({ event, className = '' }) {
  const t = useT();
  const onClick = (e) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('host:quote', { detail: { event } }));
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('chat.quote') || 'Quote'}
      aria-label={t('chat.quote') || 'Quote'}
      className={`cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--term-fg)] [@media(pointer:coarse)]:px-1.5 [@media(pointer:coarse)]:py-1 [@media(pointer:coarse)]:opacity-100 ${className}`}
    >
      <Icon icon={faReply} />
    </button>
  );
}

// Small hover-revealed copy button — shown outright on touch devices (no
// hover there). Parent must set `group` for the hover reveal to work.
function CopyButton({ text, className = '' }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const onCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission denied — no-op */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? t('chat.copied') : t('chat.copy')}
      aria-label={t('chat.copy')}
      className={`cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--term-fg)] [@media(pointer:coarse)]:px-1.5 [@media(pointer:coarse)]:py-1 [@media(pointer:coarse)]:opacity-100 ${className}`}
    >
      <Icon icon={copied ? faCheck : faCopy} />
    </button>
  );
}

function UserMsg({ event }) {
  const t = useT();
  const atts = Array.isArray(event.attachments) ? event.attachments : [];
  const text = textOf(event);
  const d = dirOf(text); // the bubble's side follows the prompt's own language
  useNow(30_000); // Event is memoized, so each stamp refreshes itself
  return (
    // Align the bubble to the side that matches its text — Hebrew/RTL → right,
    // English/LTR → left — regardless of the app language. Setting the row's dir
    // to the text direction makes `items-start` resolve to that physical side.
    <div dir={d} className="group my-2.5 flex flex-col items-start">
      <span className="ms-1 mb-0.5 flex items-center gap-1 font-mono text-[8.5px] font-bold tracking-[0.12em] text-[var(--term-userborder)] uppercase">
        <span className="h-[5px] w-[5px] rounded-full bg-brand" /> {t('chat.you')}
        {event.ts && (
          <span className="font-normal tracking-normal normal-case opacity-70">· {agoTime(event.ts)}</span>
        )}
        <CopyButton text={text} className="text-[11.5px] md:text-[10px]" />
        <QuoteButton event={event} className="text-[11.5px] md:text-[10px]" />
      </span>
      <div
        dir={d}
        className={`max-w-[85%] rounded-[13px] border border-[var(--term-userborder)] bg-[var(--term-userbg)] px-3.5 py-2 font-mono text-[12px] leading-relaxed font-medium whitespace-pre-wrap text-[var(--term-userfg)] shadow-[0_1px_3px_rgba(0,0,0,0.12)] ${d === 'rtl' ? 'rounded-tr-[4px]' : 'rounded-tl-[4px]'}`}
      >
        {text}
        {atts.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${text ? 'mt-1.5' : ''}`}>
            {atts.map((a, i) => {
              // ZIP3: entriesTotal > entryCount with no hard error means a
              // partial extraction — show "N/M", not a bare count that reads
              // as a clean success.
              const partial = a.archive && !a.archive.error && a.archive.entriesTotal > 0 && a.archive.entriesTotal !== a.archive.entryCount;
              const problem = a.archive && (a.archive.error || partial);
              return (
                <span
                  key={i}
                  title={a.archive?.dir || undefined}
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] md:text-[10px] ${problem ? 'border-danger text-danger' : 'border-[var(--term-userborder)]'} bg-black/10`}
                >
                  <Icon icon={a.archive ? faBoxArchive : a.isImage ? faImage : faFile} /> {a.name}
                  {a.archive && !a.archive.error && !partial && ` (${a.archive.entryCount})`}
                  {partial && ` (${a.archive.entryCount}/${a.archive.entriesTotal})`}
                  {a.archive?.error && ` (${t('chat.archiveExtractFailed')})`}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMsg({ event, recap }) {
  // The turn's final message gets a faint tint only — no border — so it reads
  // as gently set apart without shouting. Content is unchanged.
  const text = textOf(event);
  useNow(30_000); // Event is memoized, so each stamp refreshes itself
  return (
    <div className={`group md my-1.5${recap ? ' rounded-[6px] bg-brand/[0.03] px-2 py-1' : ''}`}>
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      {event.ts && (
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] md:text-[9.5px] text-[var(--term-faint)]">
          <span className="opacity-70">{agoTime(event.ts)}</span>
          <CopyButton text={text} />
          <QuoteButton event={event} />
        </div>
      )}
    </div>
  );
}

function Thinking({ event }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-faint)] italic hover:text-[var(--term-dim)]"
      >
        <Icon icon={faWandMagicSparkles} /> {t('chat.thinking')}{open ? '' : '…'}
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
      className="thin-scroll max-h-72 overflow-auto rounded-md px-2.5 py-1.5 text-[11.5px] md:text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--term-fg)]"
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
  if (typeof input.patch === 'string' && input.patch) return <CodeBlock sign="" text={input.patch} />; // codex fileChange
  if (input.command != null) return <CodeBlock sign="" text={input.command} />;
  return <CodeBlock sign="" text={prettyInput(input)} />;
}

function ToolUse({ event, sessionId }) {
  const [open, setOpen] = useState(false);
  // CHATWS: the wire row may carry clipped input (a big Write) — pull the full
  // row the first time it is expanded.
  useEffect(() => {
    if (open && event.clipped && event.seq) loadFullChatEvent(sessionId, event.seq);
  }, [open, event.clipped, event.seq, sessionId]);
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
        <span className="ml-auto shrink-0 text-[11px] md:text-[9px] text-[var(--term-faint)]"><Icon icon={open ? faChevronUp : faChevronDown} /></span>
      </button>
      {open && (
        <div className="mt-1 mb-1.5 rounded-lg border border-[var(--term-border)] bg-[var(--term-codebg)] p-1.5">
          <ToolDetail event={event} />
        </div>
      )}
    </div>
  );
}

function ToolResult({ event, sessionId }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const isError = event.isError ?? event.is_error ?? false;
  const text = textOf(event).trimEnd();
  if (!text) return null;
  const lines = text.split('\n');
  // CHATWS: a clipped row (server cut the body for the wire) is always "long"
  // — "more" first fetches the full row, then expands it.
  const clipped = !!event.clipped;
  const long = clipped || lines.length > 5 || text.length > 600;
  const shown = open || !long ? text : `${lines.slice(0, 5).join('\n').slice(0, 600)}…`;
  const toggle = async () => {
    if (!open && clipped && event.seq) {
      setFetching(true);
      await loadFullChatEvent(sessionId, event.seq);
      setFetching(false);
    }
    setOpen((v) => !v);
  };
  const moreLabel = clipped && event.fullBytes
    ? t('chat.showFull', { kb: Math.max(1, Math.round(event.fullBytes / 1024)) })
    : t('chat.more');
  return (
    <div
      dir="ltr"
      className={`my-0.5 pl-4 font-mono text-[11.5px] md:text-[10.5px] leading-relaxed whitespace-pre-wrap ${
        isError ? 'text-diffdel' : 'text-[var(--term-dim)]'
      }`}
    >
      {shown}
      {long && (
        <button
          type="button"
          onClick={toggle}
          disabled={fetching}
          className="ml-1.5 cursor-pointer text-[var(--term-faint)] underline hover:text-[var(--term-dim)] disabled:opacity-50"
        >
          {fetching ? <span className="host-spinner inline-block h-2.5 w-2.5" /> : open ? t('chat.less') : moreLabel}
        </button>
      )}
    </div>
  );
}

function ResultLine({ event }) {
  const t = useT();
  const isError = event.isError ?? event.is_error ?? event.subtype === 'error';
  // The success `result` just echoes the final assistant message (already shown
  // above) — render a subtle end-of-turn marker instead of duplicating it as
  // raw text. Errors still show their message.
  if (!isError) {
    const meta = [
      event.numTurns != null ? t(event.numTurns === 1 ? 'chat.turnOne' : 'chat.turnMany', { n: event.numTurns }) : null,
      event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : null,
      event.costUsd ? `$${Number(event.costUsd).toFixed(3)}` : null,
    ].filter(Boolean).join(' · ');
    return (
      <div className="my-2 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-dim)]">
        <span className="text-diffadd"><Icon icon={faCheck} /></span> {t('chat.done')}{meta ? ` · ${meta}` : ''}
      </div>
    );
  }
  const text = textOf(event) || t('chat.errored');
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

// Info-styled line for host-generated notices (session restarted, conversation
// cleared, account auto-switched…) — distinct from ErrorLine so these read as
// neutral status, not alarms.
function SystemLine({ event }) {
  return (
    <div className="my-1.5 font-mono text-[11px] whitespace-pre-wrap text-[var(--term-dim)]">
      <Icon icon={faArrowRotateRight} /> {textOf(event)}
    </div>
  );
}

function AskUserQuestion({ sessionId, event, live }) {
  const t = useT();
  // The chosen label per question index — purely local, the answer is posted
  // as a normal chat message (same call ChatFooter uses).
  const [picked, setPicked] = useState({});
  const [skipped, setSkipped] = useState({});
  const [busy, setBusy] = useState(false);
  // CHAT1: what became of the answer — null | 'tool' | 'message' | {error}.
  const [outcome, setOutcome] = useState(null);
  const questions = Array.isArray(event.input?.questions) ? event.input.questions : [];
  // CHAT1: picks that already reached the host (the permission-answer the
  // server echoed, folded onto this event) survive a reload and show on the
  // other device. A card the host closed WITHOUT an answer ('deny': timed
  // out, session restarted) says so — a click still works, the answer then
  // goes in as a normal message.
  const serverAnswers = event.answers && typeof event.answers === 'object' ? event.answers : null;
  const closed = event.answered === 'deny' && !serverAnswers;

  // Answer the whole AskUserQuestion once every question has a pick (or is
  // skipped). The host resolves the tool's pending permission with the picks
  // (the CLI's own answer channel — the blocked turn resumes at once) and
  // says whether it did ({delivered:'tool'}) or had to send a plain message
  // because nothing was pending any more ({delivered:'message'}).
  const allAnswered = (p, sk) => questions.every((_q, qi) => p[qi] != null || sk[qi]);

  const submit = async (finalPicked, finalSkipped) => {
    setBusy(true);
    setOutcome(null);
    const answers = questions.map((q, qi) => ({
      question: q.question || q.header || `Question ${qi + 1}`,
      answer: finalPicked[qi] != null ? finalPicked[qi] : null,
    }));
    const content = answers.map((a) => `${a.question}: ${a.answer ?? '(no answer)'}`).join('\n');
    try {
      let delivered = 'message';
      if (event.toolUseId) {
        const r = await api.post(`/sessions/${sessionId}/question/answer`, { toolUseId: event.toolUseId, content, answers });
        delivered = r?.delivered === 'message' ? 'message' : 'tool';
      } else {
        // Fallback for events without a tool_use id: deliver as a message.
        await api.post(`/sessions/${sessionId}/message`, { text: content });
      }
      setOutcome(delivered);
      window.dispatchEvent(new CustomEvent('host:focus-input')); // back to the composer
    } catch (e) {
      // The answer did NOT reach the session: say so and put the buttons
      // back — never a card that looks answered while the chat waits.
      setOutcome({ error: String(e?.message || e).replace(/^HTTP \d+ — /, '') });
      setPicked({});
      setSkipped({});
    }
    setBusy(false);
  };

  const choose = (qi, label) => {
    if (busy || picked[qi] != null || skipped[qi]) return;
    const np = { ...picked, [qi]: label };
    setPicked(np);
    if (allAnswered(np, skipped)) submit(np, skipped);
  };

  // Escape hatch: leave this question unanswered ('(no answer)' in the result) —
  // e.g. none of the options fit, or the turn behind it already died.
  const skip = (qi) => {
    if (busy || picked[qi] != null || skipped[qi]) return;
    const ns = { ...skipped, [qi]: true };
    setSkipped(ns);
    if (allAnswered(picked, ns)) submit(picked, ns);
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
      const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'button') || isVncInputTarget(el));
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
        <span className="font-bold text-[var(--term-accent-strong)]">{t('chat.questionForYou')}</span>
      </div>
      {questions.map((q, qi) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const chosen = picked[qi] != null ? picked[qi] : serverAnswers ? serverAnswers[q.question] : undefined;
        const wasSkipped = skipped[qi] || (!!serverAnswers && chosen == null);
        return (
          <div key={qi} className="mt-3 first:mt-2.5">
            {q.header && (
              <div className="mb-0.5 font-mono text-[11.5px] md:text-[10px] tracking-[0.06em] text-[var(--term-accent-dim)] uppercase">
                {q.header}
              </div>
            )}
            {q.question && (
              <div className="mb-2 text-[12px] leading-snug text-[var(--term-accent-fg)]">{q.question}</div>
            )}
            {wasSkipped ? (
              <span className="font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]"><Icon icon={faXmark} /> {t('chat.skipped')}</span>
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
                        <span className="mr-1.5 font-mono text-[11.5px] md:text-[10px] text-[var(--term-accent-dim)]">{oi + 1}</span>
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
                className="mt-1.5 cursor-pointer font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)] underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
              >
                {t('chat.skipThisQuestion')}
              </button>
            )}
              </>
            )}
          </div>
        );
      })}
      {outcome && typeof outcome === 'object' && (
        <div data-question-error dir="auto" className="mt-2.5 text-[11px] font-bold text-[#9c3b33]">
          {t('chat.answerFailed')} <span className="font-mono font-normal">{outcome.error}</span>
        </div>
      )}
      {outcome === 'message' && (
        <div data-question-note dir="auto" className="mt-2.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">{t('chat.answerSentAsMessage')}</div>
      )}
      {closed && !outcome && !Object.keys(picked).length && (
        <div data-question-closed dir="auto" className="mt-2.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">{t('chat.questionClosed')}</div>
      )}
    </div>
  );
}

function PermissionRequest({ sessionId, event, live: isLive }) {
  const t = useT();
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
      const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'button') || isVncInputTarget(el));
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
        <span className="font-bold text-[var(--term-accent-strong)]">{t('chat.permissionRequest')}</span>
        <span className="text-[var(--term-accent-dim)]">{toolName}</span>
      </div>
      {event.input != null && (
        <pre className="thin-scroll mt-2 max-h-40 overflow-auto rounded-lg bg-[var(--term-codebg)] p-2 font-mono text-[11.5px] md:text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--term-dim)]">
          {prettyInput(event.input)}
        </pre>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        {answered ? (
          <span className="font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">
            {answered === 'allow' ? <><Icon icon={faCheck} /> {t('chat.allowed')}</> : <><Icon icon={faXmark} /> {t('chat.denied')}</>}
            {event.answeredMessage ? ` (${event.answeredMessage})` : ''}
          </span>
        ) : expired ? (
          <span className="font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">
            <Icon icon={faXmark} /> {t('chat.requestExpired')}
          </span>
        ) : (
          <>
            <button
              ref={allowRef}
              type="button"
              disabled={busy}
              onClick={() => answer('allow')}
              title={t('chat.allowHint')}
              className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50"
            >
              {t('chat.allow')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => answer('deny')}
              title={t('chat.denyHint')}
              className="cursor-pointer rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-3.5 py-1.5 text-[11.5px] text-[var(--term-accent-dim)] hover:bg-[var(--term-accent-bg)] disabled:opacity-50"
            >
              {t('chat.deny')}
            </button>
            <span className="ml-1 font-mono text-[11.5px] md:text-[10px] text-[var(--term-accent-dim)]">Enter/y · Esc/n</span>
          </>
        )}
      </div>
    </div>
  );
}

// host.request_screen — the agent asks the human to look at / drive the
// shared desktop (manual login, 2FA, CAPTCHA, payment…). Blocking, same
// underlying mechanism as PermissionRequest (server holds the MCP tool call
// open until answered). While unanswered the card is a small WATCH view
// (view-only, never accepts input) + reason/hint + two buttons:
//   Take over — opens the interactive ScreenModal (the same modal the rail
//     icon opens) with this request's context; Done/Cancel live there.
//   Cancel — ends the request with takenOver:false, note "cancelled by user".
// Once answered the card freezes to a static line and unmounts the viewer,
// so old resolved cards in history don't hold open VNC connections.
function ScreenRequestCard({ sessionId, event }) {
  // "<engine> wants you to look at the screen" — the request came from THIS
  // session's engine, so a Codex session must not say Claude.
  const engine = engineLabel(useStore().sessions.find((s) => s.id === sessionId)?.engine);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const answered = event.answered;

  const cancel = async () => {
    setBusy(true);
    try {
      await cancelScreenRequest(sessionId, event.requestId);
      window.dispatchEvent(new CustomEvent('host:focus-input'));
    } catch {
      setBusy(false);
    }
  };

  const reasonLabel = event.reason ? t(`chat.screenReason.${event.reason}`) : '';
  const btnPrimary =
    'cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3.5 py-1.5 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:opacity-50';
  const btnSecondary =
    'cursor-pointer rounded-[7px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-3 py-1.5 text-[11.5px] font-bold text-[var(--term-accent-fg)] hover:bg-[var(--term-accent-border)] disabled:opacity-50';
  const answeredLabel = event.takenOver
    ? t('chat.screenRequestTakenOverDone')
    : event.note === SCREEN_CANCEL_NOTE
      ? t('chat.screenRequestCancelled')
      : t('chat.screenRequestDone');

  return (
    <div className="my-2.5 rounded-[10px] border border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] p-3">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="pulse-yellow h-[7px] w-[7px] rounded-full bg-brand" />
        <span className="font-bold text-[var(--term-accent-strong)]">{t('chat.screenRequest', { engine })}</span>
        {reasonLabel && (
          <span className="rounded-full border border-[var(--term-accent-border)] px-2 py-[1px] text-[11.5px] md:text-[10px] font-bold uppercase tracking-wide text-[var(--term-accent-strong)]">
            {reasonLabel}
          </span>
        )}
        {!answered && (
          <span className="ms-auto text-[11.5px] md:text-[10px] text-[var(--term-accent-dim)]">{t('chat.screenModeWatch')}</span>
        )}
      </div>
      {event.prompt && (
        <div dir="auto" className="mt-2 text-[12px] leading-snug text-[var(--term-accent-fg)]">{event.prompt}</div>
      )}
      {event.hint && (
        <div dir="auto" className="mt-1.5 text-[11.5px] leading-snug text-[var(--term-accent-dim)]">
          <span className="font-bold">{t('chat.screenHint')}:</span> {event.hint}
        </div>
      )}
      {answered ? (
        <div className="mt-2.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-accent-dim)]">
          <Icon icon={faCheck} /> {answeredLabel}
          {event.note && event.note !== SCREEN_CANCEL_NOTE ? ` — ${event.note}` : ''}
        </div>
      ) : (
        <>
          <ScreenView priority={SCREEN_PRIORITY.card} viewOnly sessionId={sessionId} className="mt-2.5 h-[240px] w-full rounded-lg" />
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <button type="button" disabled={busy} onClick={cancel} title={t('screen.cancelRequestHint')} className={btnSecondary}>
              {t('screen.cancelRequest')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => openScreenTakeover(sessionId, event.requestId)}
              title={t('screen.takeOverHint')}
              className={btnPrimary}
            >
              {t('chat.screenTakeOver')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Simple mode: the folded "behind the scenes" line --------------- */

// SIMPLE1: one assistant turn's tool calls / results / thinking / status lines,
// folded into a muted line that expands inline to the terminal rendering.
// `group` is filled in by the ChatPane loop AFTER this element is created (the
// slot sits where the turn's first folded event was), so read it at render.
function BehindScenes({ sessionId, group, streaming }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!groupHasSubstance(group.events)) return null;
  const n = group.events.filter(isAction).length;
  const label = n === 0 ? t('chat.behindScenes') : n === 1 ? t('chat.behindScenesOne') : t('chat.behindScenesN', { n });
  return (
    <div className="my-1" data-behind-scenes={group.events.length} data-actions={n}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-faint)] hover:bg-[var(--term-hover)] hover:text-[var(--term-dim)]"
      >
        <Icon icon={open ? faChevronUp : faChevronDown} className="text-[11px] md:text-[9px]" />
        <span>{label}</span>
        {streaming && <span className="host-spinner h-2.5 w-2.5" />}
      </button>
      {open && (
        <div className="mt-1 mb-1.5 border-s-2 border-[var(--term-border)] ps-2.5">
          {group.rows.map((r) => (
            <div key={r.key} data-event-id={r.event.id || r.key}>
              <Event sessionId={sessionId} event={r.event} recap={r.recap} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// CHATWS: what the pane shows from the first paint until the tail page lands —
// a few greyed rows shaped like a conversation, so the transcript never
// "pops in" from an empty pane. Pure CSS pulse, no layout shift on arrival.
function ChatSkeleton({ label }) {
  const rows = [
    { w: '38%', me: true },
    { w: '72%' },
    { w: '55%' },
    { w: '30%', me: true },
    { w: '80%' },
    { w: '64%' },
  ];
  return (
    <div className="chat-skeleton flex flex-col gap-3 py-3" data-testid="chat-skeleton" aria-busy="true" aria-label={label}>
      {rows.map((r, i) => (
        <div key={i} className={`flex ${r.me ? 'justify-end' : 'justify-start'}`}>
          <div
            className="h-3.5 animate-pulse rounded-md bg-[var(--term-hover)] opacity-70"
            style={{ width: r.w, animationDelay: `${i * 0.12}s` }}
          />
        </div>
      ))}
      <div className="pt-1 text-center font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-faint)]">
        <span className="host-spinner inline-block h-2.5 w-2.5" /> {label}
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
      return <ToolUse event={event} sessionId={sessionId} />;
    }
    case 'tool-result':
      return <ToolResult event={event} sessionId={sessionId} />;
    case 'result':
      return <ResultLine event={event} />;
    case 'error':
      return <ErrorLine event={event} />;
    case 'action-auto':
      return <HostCard name="ActionAutoLine" props={{ event }} />;
    case 'delegated':
      // A4: a composer @mention / `/as` handed the text to an agent.
      return <HostCard name="DelegatedLine" props={{ event }} />;
    case 'agent-adopt':
      // UX2: "Adopt agent" — this session took on (or gave back) an agent's identity.
      return <HostCard name="AgentAdoptLine" props={{ event, sessionId }} />;
    case 'system':
      return <SystemLine event={event} />;
    case 'permission-request': {
      // AskUserQuestion is auto-approved server-side and answered through the
      // "Question for you" card, so its permission bubble is redundant — never
      // render it (covers any such event persisted before the server change).
      const tn = event.toolName ?? event.tool_name ?? event.name;
      if (tn === 'AskUserQuestion') return null;
      return <PermissionRequest sessionId={sessionId} event={event} live={live} />;
    }
    case 'screen-request':
      return <ScreenRequestCard sessionId={sessionId} event={event} />;
    case 'screenshot':
      // Consecutive screenshots are folded into the first one's row (see the
      // grouping in ChatPane below); `shots` carries the whole run.
      return <HostCard name="ScreenshotCard" props={{ shots: event.shots || [event] }} />;
    case 'artifact':
      return <HostCard name="ArtifactCard" props={{ sessionId, event }} />;
    case 'setup':
      // S2: host.request_setup — "the agent needs <capability>" with the
      // auto/manual decision (see setup/SetupCard.jsx).
      return <SetupCard sessionId={sessionId} event={event} />;
    case 'merge':
      // F7: host-executed merge result (merged / conflict) — in the child and
      // mirrored into its master.
      return <MergeEvent event={event} />;
    case 'agent-card':
      // A1: create_agent / update_agent — the human edits + confirms the draft here.
      return <HostCard name="AgentCard" props={{ sessionId, event }} />;
    case 'ext-card':
      // EXT: an extension's own card — title + markdown + prompt buttons.
      return <HostCard name="ExtCard" props={{ sessionId, event }} />;
    case 'openui':
      // OPENUI: render_ui — an OpenUI Lang block rendered with the cockpit's library.
      return <OpenUICard sessionId={sessionId} event={event} />;
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

// The slot decides "still streaming" from the transcript itself: the group is
// live while its last folded event is also the transcript's tail (no prose /
// result after it yet) — the counter then shows a spinner and keeps growing.
function BehindScenesSlot({ sessionId, group, events }) {
  const last = group.events[group.events.length - 1];
  const tail = events[events.length - 1];
  const streaming = !!last && last === tail && last.kind !== 'result';
  return <BehindScenes sessionId={sessionId} group={group} streaming={streaming} />;
}

export default function ChatPane({ sessionId, events, working, action, loading, awaiting, mode = 'full' }) {
  const t = useT();
  // SIMPLE1: 'simple' folds tool activity per turn (see lib/chatMode.js).
  const simple = mode === 'simple';
  // F7: the merge panel keys off metadata.review/merged (wire form is enough).
  const session = useStore().sessions.find((s) => s.id === sessionId) || null;
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

  // CHATWS: scrolling near the top pulls the previous page by itself (the
  // button below stays as the explicit path). The ref is filled once
  // revealEarlier exists further down; a guard stops a second pull while one
  // is in flight.
  const topLoadRef = useRef(null);
  const lastTopRef = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = dist < 48;
    setAway(dist > 160);
    // Only a scroll that MOVED UP into the top band counts — the programmatic
    // snap-to-bottom on load/switch also fires `scroll` while the pane is
    // still short, and must not pull a page.
    const up = el.scrollTop < lastTopRef.current;
    lastTopRef.current = el.scrollTop;
    if (up && el.scrollTop < 120 && dist > 160) topLoadRef.current?.();
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

  // The pane shrinks when the mobile keyboard opens (and on any window
  // resize); if the user was at the bottom, keep them there — otherwise the
  // newest rows slide under the composer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // new session selected → snap to bottom, back to the default window
  useEffect(() => {
    stickRef.current = true;
    lastTopRef.current = 0;
    setAway(false);
    setShown(WINDOW);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  const hiddenCount = Math.max(0, events.length - shown);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderBusyRef = useRef(false);
  const serverHasMore = chatHasMore(sessionId);

  const revealEarlier = async () => {
    if (olderBusyRef.current) return;
    const el = scrollRef.current;
    anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    if (hiddenCount > 0) {
      // Reveal already-loaded events first
      setShown((n) => n + REVEAL);
    } else if (serverHasMore) {
      // Fetch older page from server
      olderBusyRef.current = true;
      setLoadingOlder(true);
      try {
        await loadOlderChat(sessionId);
        setShown((n) => n + REVEAL);
      } finally {
        setLoadingOlder(false);
        olderBusyRef.current = false;
      }
    }
  };
  topLoadRef.current = hiddenCount > 0 || serverHasMore ? revealEarlier : null;

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
      data-chat-mode={mode}
      className={`term ${view.theme === 'light' ? 'term-light' : ''} thin-scroll h-full overflow-y-auto bg-[var(--term-bg)] px-4 py-3.5`}
    >
      <div className="term-events" style={scale === 1 ? undefined : { zoom: scale }}>
        {(hiddenCount > 0 || serverHasMore) && (
          <div className="pb-2 text-center">
            <button
              type="button"
              onClick={revealEarlier}
              disabled={loadingOlder}
              className="cursor-pointer rounded-md border border-[var(--term-border)] px-2.5 py-1 font-mono text-[11.5px] md:text-[10.5px] text-[var(--term-dim)] hover:bg-[var(--term-hover)] disabled:opacity-50"
            >
              {loadingOlder
                ? <><span className="host-spinner inline-block h-3 w-3" /> {t('chat.loadingTranscript')}</>
                : <><Icon icon={faChevronUp} /> {hiddenCount > 0 ? t('chat.showEarlier', { n: hiddenCount }) : t('chat.loadEarlier') || 'Load earlier messages'}</>
              }
            </button>
          </div>
        )}
        {events.length === 0 &&
          (loading ? (
            <ChatSkeleton label={t('chat.loadingTranscript')} />
          ) : (
            <div className="py-6 text-center font-mono text-[11px] text-[var(--term-faint)]">
              {t('chat.noMessages')}
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
          // Screenshot timeline: a run of consecutive `screenshot` events
          // (e.g. the Watch-mode auto-snapshots) renders as ONE strip card on
          // the first row; the rest of the run is skipped. Grouped over the
          // visible slice only — the run object is rebuilt per render, so the
          // memoized Event re-renders when the run grows.
          // The agent's capture_screen calls also leave tool-use / tool-result
          // rows around each screenshot (use → screenshot → result). Those
          // rows are hidden — the card IS the tool's visible output — and are
          // transparent to grouping, so consecutive manual captures fold into
          // one strip too. A failed call keeps its (error) tool-result.
          const isCapUse = (e) => e.kind === 'tool-use' && /(^|__)capture_screen$/.test(String(e.name ?? e.tool ?? e.toolName ?? ''));
          const capIds = new Set();
          events.forEach((e) => { if (isCapUse(e) && e.toolUseId) capIds.add(e.toolUseId); });
          const isCapRow = (e) =>
            isCapUse(e) || (e.kind === 'tool-result' && capIds.has(e.toolUseId) && !(e.isError ?? e.is_error));
          const out = [];
          const visible = events.slice(hiddenCount);
          // SIMPLE1: in Simple mode each turn's folded events collect into one
          // group, rendered as a BehindScenes slot where the first of them was.
          // A `user` event starts a new turn (and a new group).
          let group = null;
          for (let j = 0; j < visible.length; j++) {
            const e = visible[j];
            const i = hiddenCount + j;
            if (isCapRow(e)) continue;
            if (simple) {
              if (e.kind === 'user') group = null;
              if (hiddenInSimple(e)) {
                if (!group) {
                  group = { events: [], rows: [] };
                  const g = group;
                  out.push(
                    <BehindScenesSlot key={`bs:${keys[i]}`} sessionId={sessionId} group={g} events={events} />
                  );
                }
                group.events.push(e);
                group.rows.push({ key: keys[i], event: e, recap: recap.has(i) });
                continue;
              }
            }
            if (e.kind === 'screenshot') {
              const shots = [e];
              for (let k = j + 1; k < visible.length; k++) {
                if (isCapRow(visible[k])) continue;
                if (visible[k].kind !== 'screenshot') break;
                shots.push(visible[k]);
                j = k;
              }
              const ev = shots.length > 1 ? { ...e, shots } : e;
              out.push(<div key={keys[i]} data-event-id={e.id || keys[i]}><Event sessionId={sessionId} event={ev} /></div>);
              continue;
            }
            const live = !!awaiting && ((isAsk(e) && i === lastAskIdx) || (isPerm(e) && i === lastPermIdx));
            out.push(<div key={keys[i]} data-event-id={e.id || keys[i]}><Event sessionId={sessionId} event={e} live={live} recap={recap.has(i)} /></div>);
          }
          return out;
        })()}
        {action && <HostCard name="ActionCard" props={{ sessionId, action }} />}
        {/* F7: after the human approved, the merge is one click — here, at the
            end of the transcript, until it's merged. */}
        {session?.metadata?.review?.state === 'approved' && !session?.metadata?.merged && (
          <MergePanel session={session} dark />
        )}
        {working && (
          <div className="my-2 flex items-center gap-2 font-mono text-[11px] text-[var(--term-dim)]">
            <span className="host-spinner h-3 w-3" />
            {t('chat.working')}
          </div>
        )}
      </div>
    </div>
    {away && (
      <button
        type="button"
        onClick={jumpToBottom}
        title={t('chat.jumpToLatest')}
        aria-label={t('chat.jumpToLatest')}
        className="absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-ink bg-panel text-[13px] text-fg shadow-[2px_2px_0_rgba(42,42,42,0.35)] hover:bg-chip"
      >
        <Icon icon={faArrowDown} />
      </button>
    )}
    </div>
  );
}
