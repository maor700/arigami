import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { loadOlderChat, loadFullChatEvent, chatHasMore, useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import DiffCard from './DiffCard.jsx';
import { isEditEvent, summarizeEdits } from '../lib/editDiff.js';
import ScreenView from './ScreenView.jsx';
import OpenUICard from './OpenUICard.jsx';
import { HostCard } from '../openui/host.jsx';
import { usePrefs, termViewFrom } from '../lib/prefs.js';
import { hiddenInSimple, isAction, groupHasSubstance } from '../lib/chatMode.js';
import { agoTime } from '../lib/time.js';
import { useT, dirOf } from '../lib/i18n.js';
import { prettyInput } from '../lib/pretty-input.js';
import {
  ArchiveIcon,
  ArrowDownIcon,
  ChevronUpIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CopyIcon,
  CornerUpLeftIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlugIcon,
  RotateCcwIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Tip, TooltipProvider } from './ui/index.js';

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


/* ---------- per-kind renderers ------------------------------------------- */

// One small icon button for the hover actions under a message (copy / quote).
// Shown on hover on desktop, always on touch (no hover there). The parent
// must carry `group`.
function RowAction({ label, onClick, children, className = '' }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-[var(--term-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--term-hover)] hover:text-[var(--term-fg)] focus-visible:opacity-100 coarse:size-11 coarse:opacity-100 [&_svg]:size-3.5 ${className}`}
      >
        {children}
      </button>
    </Tip>
  );
}

// Fires a custom event that ChatFooter listens for to populate the quote
// preview above the composer. Decoupled: ChatPane doesn't import ChatFooter.
function QuoteButton({ event }) {
  const t = useT();
  const onClick = (e) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('host:quote', { detail: { event } }));
  };
  return (
    <RowAction label={t('chat.quote') || 'Quote'} onClick={onClick}>
      <CornerUpLeftIcon className="rtl:-scale-x-100" />
    </RowAction>
  );
}

function CopyButton({ text }) {
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
    <RowAction label={copied ? t('chat.copied') : t('chat.copy')} onClick={onCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </RowAction>
  );
}

// The quiet meta line under a message: time + copy + quote.
function MsgMeta({ event, text }) {
  return (
    <div className="mt-0.5 flex items-center gap-0.5 text-2xs text-[var(--term-faint)] tabular-nums">
      {event.ts && <span className="me-1">{agoTime(event.ts)}</span>}
      <CopyButton text={text} />
      <QuoteButton event={event} />
    </div>
  );
}

function UserMsg({ event }) {
  const t = useT();
  const atts = Array.isArray(event.attachments) ? event.attachments : [];
  const text = textOf(event);
  const d = dirOf(text); // the bubble's side follows the prompt's own language
  useNow(30_000); // Event is memoized, so each stamp refreshes itself
  return (
    // Align the block to the side that matches its text — Hebrew/RTL → right,
    // English/LTR → left — regardless of the app language. Setting the row's dir
    // to the text direction makes `items-start` resolve to that physical side.
    <div dir={d} data-user-msg className="group my-4 flex flex-col items-start">
      <span className="sr-only">{t('chat.you')}</span>
      <div
        dir={d}
        className="max-w-[85%] rounded-lg border border-[var(--term-userborder)] bg-[var(--term-userbg)] px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap text-[var(--term-userfg)]"
      >
        {text}
        {atts.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${text ? 'mt-2' : ''}`}>
            {atts.map((a, i) => {
              // ZIP3: entriesTotal > entryCount with no hard error means a
              // partial extraction — show "N/M", not a bare count that reads
              // as a clean success.
              const partial = a.archive && !a.archive.error && a.archive.entriesTotal > 0 && a.archive.entriesTotal !== a.archive.entryCount;
              const problem = a.archive && (a.archive.error || partial);
              const AttIcon = a.archive ? ArchiveIcon : a.isImage ? ImageIcon : FileIcon;
              return (
                <span
                  key={i}
                  title={a.archive?.dir || undefined}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs [&_svg]:size-3 ${problem ? 'border-danger text-danger' : 'border-[var(--term-userborder)] text-[var(--term-dim)]'}`}
                >
                  <AttIcon /> <bdi dir="ltr">{a.name}</bdi>
                  {a.archive && !a.archive.error && !partial && ` (${a.archive.entryCount})`}
                  {partial && ` (${a.archive.entryCount}/${a.archive.entriesTotal})`}
                  {a.archive?.error && ` (${t('chat.archiveExtractFailed')})`}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <MsgMeta event={event} text={text} />
    </div>
  );
}

function AssistantMsg({ event, recap }) {
  // Assistant prose is plain text on the page — no bubble. The turn's final
  // message (the "recap") is not tinted any more; only the content matters.
  const text = textOf(event);
  useNow(30_000); // Event is memoized, so each stamp refreshes itself
  return (
    <div className="group md my-3" data-recap={recap ? '1' : undefined}>
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      {event.ts && <MsgMeta event={event} text={text} />}
    </div>
  );
}

function Thinking({ event }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1">
      <CollapsibleTrigger className="group/t flex min-h-6 cursor-pointer items-center gap-1.5 rounded-md px-1 text-xs text-[var(--term-faint)] italic hover:text-[var(--term-dim)] coarse:min-h-11 [&_svg]:size-3.5">
        <BrainIcon /> {t('chat.thinking')}{open ? '' : '…'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div dir="auto" className="mt-1 border-s border-[var(--term-border)] ps-3 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--term-dim)] italic">
          {textOf(event)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// A code/diff slab — always LTR monospace (code never flips for RTL prose)
// with a thin add/del/plain tint.
function CodeBlock({ text, sign }) {
  const bg = sign === '+' ? 'color-mix(in oklab, var(--hb-ok) 12%, transparent)' : sign === '-' ? 'color-mix(in oklab, var(--hb-err) 12%, transparent)' : 'var(--term-codebg)';
  return (
    <pre
      dir="ltr"
      data-code
      className="thin-scroll max-h-72 overflow-auto rounded-md px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[var(--term-fg)]"
      style={{ background: bg }}
    >
      {String(text ?? '')}
    </pre>
  );
}

// The lucide glyph for a tool name (thin outline set).
export function toolIcon(name) {
  const n = String(name || '');
  if (/^bash$|shell|command|exec/i.test(n)) return TerminalIcon;
  if (/edit|write|create|notebook|patch/i.test(n)) return PencilIcon;
  if (/read|view|cat/i.test(n)) return FileTextIcon;
  if (/grep|glob|search|find|ls$/i.test(n)) return SearchIcon;
  if (/web|fetch|browser/i.test(n)) return GlobeIcon;
  if (/todo|plan/i.test(n)) return ListChecksIcon;
  if (/^task$|agent/i.test(n)) return BotIcon;
  if (/^mcp__|__/i.test(n)) return PlugIcon;
  return WrenchIcon;
}

// A todo / plan list (Claude's TodoWrite): status glyph + text, done struck
// through. `todos` = [{content, status, activeForm}].
export function TodoList({ todos }) {
  return (
    <ul className="flex flex-col gap-1" data-todo-list>
      {todos.map((td, i) => {
        const st = td?.status || 'pending';
        const Glyph = st === 'completed' ? CircleCheckIcon : st === 'in_progress' ? LoaderCircleIcon : CircleDashedIcon;
        const label = st === 'in_progress' && td?.activeForm ? td.activeForm : td?.content ?? '';
        return (
          <li key={i} data-todo-status={st} className="flex items-start gap-2 text-[13px] leading-snug">
            <Glyph className={`mt-0.5 size-3.5 shrink-0 ${st === 'completed' ? 'text-ok' : st === 'in_progress' ? 'text-[var(--term-fg)]' : 'text-[var(--term-faint)]'}`} />
            <span dir="auto" className={st === 'completed' ? 'text-[var(--term-faint)] line-through' : st === 'in_progress' ? 'text-[var(--term-strong)]' : 'text-[var(--term-dim)]'}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export const todosOf = (e) => {
  const name = String(e.name ?? e.tool ?? e.toolName ?? '');
  const todos = e.input?.todos;
  return /todo/i.test(name) && Array.isArray(todos) && todos.length ? todos : null;
};

// The plan card — a TodoWrite call shown as "Plan 2/4" with its checklist.
function PlanCard({ event }) {
  const t = useT();
  const todos = todosOf(event);
  const done = todos.filter((x) => x?.status === 'completed').length;
  return (
    <div data-plan-card className="my-2.5 rounded-lg border border-[var(--term-border)] bg-[var(--term-accent-bg)] px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--term-accent-strong)]">
        <ListChecksIcon className="size-3.5 text-[var(--term-dim)]" />
        {t('chat.plan')}
        <span className="font-normal text-[var(--term-dim)] tabular-nums">{done}/{todos.length}</span>
      </div>
      <TodoList todos={todos} />
    </div>
  );
}

// Readable view of a tool's input: edits become old→new diffs, writes/commands
// become code, everything else falls back to pretty JSON.
function ToolDetail({ event }) {
  const name = String(event.name ?? event.tool ?? event.toolName ?? '');
  const input = event.input || {};
  const todos = todosOf(event);
  if (todos) return <TodoList todos={todos} />;
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

// One tool call: a muted row (thin icon, name, target, +N −M) that expands to
// the call's detail. Radix Collapsible so keyboard/aria come for free.
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
  const Glyph = toolIcon(name);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-px" data-tool-row>
      <CollapsibleTrigger className="flex min-h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-1.5 text-start text-xs whitespace-nowrap text-[var(--term-dim)] hover:bg-[var(--term-hover)] coarse:min-h-11">
        <Glyph className="size-3.5 shrink-0 text-[var(--term-faint)]" />
        <span dir="ltr" className="shrink-0 font-medium text-[var(--term-fg)]">{name}</span>
        {summary && <span dir="ltr" className="min-w-0 truncate font-mono text-[var(--term-faint)]">{summary}</span>}
        {stats && (
          <span dir="ltr" className="ms-1 shrink-0 tabular-nums">
            {stats.add != null && <span className="text-diffadd">+{stats.add}</span>}
            {stats.del != null && <span className="ms-1.5 text-diffdel">−{stats.del}</span>}
          </span>
        )}
        <ChevronDownIcon className={`ms-auto size-3.5 shrink-0 text-[var(--term-faint)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1.5 ms-1.5 rounded-md border border-[var(--term-border)] bg-[var(--term-codebg)] p-1.5">
          <ToolDetail event={event} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Command / tool output: a quiet LTR mono block, truncated to a few lines with
// "more" (clipped rows fetch the full body first).
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
      data-tool-result
      className={`my-0.5 ms-1.5 border-s ps-3 font-mono text-xs leading-relaxed whitespace-pre-wrap ${
        isError ? 'border-diffdel text-diffdel' : 'border-[var(--term-border)] text-[var(--term-dim)]'
      }`}
    >
      {shown}
      {long && (
        <button
          type="button"
          onClick={toggle}
          disabled={fetching}
          className="ms-2 inline-flex min-h-6 cursor-pointer items-center font-sans text-[var(--term-faint)] underline underline-offset-2 hover:text-[var(--term-dim)] disabled:opacity-50 coarse:min-h-11"
        >
          {fetching ? <span className="host-spinner inline-block size-3" /> : open ? t('chat.less') : moreLabel}
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
      <div className="my-2 flex items-center gap-1.5 text-xs text-[var(--term-faint)] tabular-nums">
        <CheckIcon className="size-3.5 text-ok" /> {t('chat.done')}{meta ? ` · ${meta}` : ''}
      </div>
    );
  }
  const text = textOf(event) || t('chat.errored');
  return (
    <div dir="auto" role="alert" className="my-2 flex items-start gap-2 rounded-md border border-[var(--hb-err-line)] bg-[var(--term-accent-bg)] px-3 py-2 text-[13px] whitespace-pre-wrap text-[var(--term-fg)]">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-err" aria-hidden="true" />
      <span className="min-w-0">{text.length > 400 ? `${text.slice(0, 400)}…` : text}</span>
    </div>
  );
}

function ErrorLine({ event }) {
  return (
    <div dir="auto" role="alert" className="my-2 flex items-start gap-2 rounded-md border border-[var(--hb-err-line)] bg-[var(--term-accent-bg)] px-3 py-2 text-[13px] whitespace-pre-wrap text-[var(--term-fg)]">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-err" aria-hidden="true" />
      <span className="min-w-0">{textOf(event)}</span>
    </div>
  );
}

// Info-styled line for host-generated notices (session restarted, conversation
// cleared, account auto-switched…) — distinct from ErrorLine so these read as
// neutral status, not alarms.
function SystemLine({ event }) {
  return (
    <div dir="auto" className="my-2 flex items-start gap-1.5 text-xs whitespace-pre-wrap text-[var(--term-dim)]">
      <RotateCcwIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--term-faint)]" /> <span className="min-w-0">{textOf(event)}</span>
    </div>
  );
}

/* ---------- Simple mode: the folded "behind the scenes" line --------------- */

// The muted summary row shared by "Edited N files" and the tool-call fold.
const SUMMARY_ROW = 'flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-start text-xs text-[var(--term-dim)] hover:bg-[var(--term-hover)] hover:text-[var(--term-fg)] coarse:min-h-11 [&_svg]:size-3.5';

// SIMPLE1: one assistant turn's tool calls / results / thinking / status lines,
// folded into a muted line that expands inline to the terminal rendering.
// `group` is filled in by the ChatPane loop AFTER this element is created (the
// slot sits where the turn's first folded event was), so read it at render.
function EditSummary({ sessionId, group, results }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const edits = group.events.filter(isEditEvent);
  // A clipped Write carries a truncated body: fetch the full rows so the
  // totals are real (bounded — a turn rarely edits more than a handful).
  useEffect(() => {
    edits.filter((e) => e.clipped && e.seq).slice(0, 8).forEach((e) => loadFullChatEvent(sessionId, e.seq));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits.map((e) => `${e.seq}:${e.clipped ? 1 : 0}`).join(',')]);
  if (!edits.length) return null;
  const sum = summarizeEdits(edits, results);
  if (!sum.files) return null;
  const label = sum.files === 1 ? t('chat.diff.editedOne') : t('chat.diff.editedN', { n: sum.files });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-px" data-edit-summary={sum.files}>
      <CollapsibleTrigger className={SUMMARY_ROW}>
        <ChevronDownIcon className={`shrink-0 transition-transform ${open ? '' : '-rotate-90 rtl:rotate-90'}`} />
        <PencilIcon className="text-[var(--term-faint)]" />
        <span>{label}</span>
        <span dir="ltr" className="whitespace-nowrap tabular-nums"><span className="text-diffadd">+{sum.add}</span> <span className="text-diffdel">−{sum.del}</span></span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {edits.map((e) => (
          <DiffCard key={e.id || e.toolUseId || e.seq || e.ts} event={e} result={results.get(e.toolUseId)} sessionId={sessionId} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function BehindScenes({ sessionId, group, streaming, results }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!groupHasSubstance(group.events)) return null;
  const n = group.events.filter(isAction).length;
  const label = n === 0 ? t('chat.behindScenes') : n === 1 ? t('chat.behindScenesOne') : t('chat.behindScenesN', { n });
  // a glyph per distinct kind of call in the group (max 4), like the summary row of a CLI
  const kinds = [];
  group.events.filter(isAction).forEach((e) => {
    const g = toolIcon(e.name ?? e.tool ?? e.toolName);
    if (!kinds.includes(g) && kinds.length < 4) kinds.push(g);
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1.5" data-behind-scenes={group.events.length} data-actions={n}>
      <CollapsibleTrigger className={SUMMARY_ROW}>
        <ChevronDownIcon className={`shrink-0 transition-transform ${open ? '' : '-rotate-90 rtl:rotate-90'}`} />
        <span>{label}</span>
        <span className="flex items-center gap-1 text-[var(--term-faint)]" aria-hidden="true">
          {kinds.map((K, i) => <K key={i} />)}
        </span>
        {streaming && <span className="host-spinner size-3" />}
      </CollapsibleTrigger>
      <EditSummary sessionId={sessionId} group={group} results={results} />
      <CollapsibleContent>
        <div className="mt-1 mb-1.5 border-s border-[var(--term-border)] ps-2.5">
          {group.rows.map((r) => (
            <div key={r.key} data-event-id={r.event.id || r.key}>
              <Event sessionId={sessionId} event={r.event} recap={r.recap} result={results.get(r.event.toolUseId)} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
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
            className="h-3.5 animate-pulse rounded-md bg-[var(--term-hover)]"
            style={{ width: r.w, animationDelay: `${i * 0.12}s` }}
          />
        </div>
      ))}
      <div className="pt-1 text-center text-xs text-[var(--term-faint)]">
        <span className="host-spinner inline-block size-3" /> {label}
      </div>
    </div>
  );
}

/* ---------- the pane ------------------------------------------------------ */

// Memoized: the store keeps every settled event's object identity stable and
// only replaces the trailing (streaming) one, so a delta re-renders exactly one
// row instead of re-parsing markdown for the whole transcript.
const Event = memo(function Event({ sessionId, event, live, stale, recap, result }) {
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
        return <HostCard name="QuestionCard" props={{ sessionId, event, live, stale }} />;
      if (isEditEvent(event)) return <DiffCard event={event} result={result} sessionId={sessionId} />;
      if (todosOf(event)) return <PlanCard event={event} />;
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
      return <HostCard name="PermissionCard" props={{ sessionId, event, live, stale }} />;
    }
    case 'screen-request':
      return <HostCard name="ScreenRequestCard" props={{ sessionId, event }} />;
    case 'screenshot':
      // Consecutive screenshots are folded into the first one's row (see the
      // grouping in ChatPane below); `shots` carries the whole run.
      return <HostCard name="ScreenshotCard" props={{ shots: event.shots || [event] }} />;
    case 'artifact':
      return <HostCard name="ArtifactCard" props={{ sessionId, event }} />;
    case 'setup':
      // S2: host.request_setup — "the agent needs <capability>" with the
      // auto/manual decision (see setup/SetupCard.jsx).
      return <HostCard name="SetupCard" props={{ sessionId, event }} />;
    case 'merge':
      // F7: host-executed merge result (merged / conflict) — in the child and
      // mirrored into its master.
      return <HostCard name="MergeEvent" props={{ event }} />;
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
function BehindScenesSlot({ sessionId, group, events, results }) {
  const last = group.events[group.events.length - 1];
  const tail = events[events.length - 1];
  const streaming = !!last && last === tail && last.kind !== 'result';
  return <BehindScenes sessionId={sessionId} group={group} streaming={streaming} results={results} />;
}

export default function ChatPane({ sessionId, events, working, action, loading, awaiting, mode = 'full' }) {
  const t = useT();
  // SIMPLE1: 'simple' folds tool activity per turn (see lib/chatMode.js).
  const simple = mode === 'simple';
  // F7: the merge panel keys off metadata.review/merged (wire form is enough).
  const session = useStore().sessions.find((s) => s.id === sessionId) || null;
  // The merge offer applies while the review is approved, unmerged, and not dismissed (the dismissal is
  // remembered per approval: a later re-approval offers again).
  const mdReview = session?.metadata?.review;
  const mergeOfferLive = mdReview?.state === 'approved' && !!session?.metadata?.branch && !session?.metadata?.merged && session?.metadata?.mergeOfferDismissedAt !== mdReview?.at;
  const dismissMergeOffer = () => { api.patch(`/sessions/${sessionId}`, { metadata: { mergeOfferDismissedAt: mdReview?.at || 'x' } }).catch(() => {}); };
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
  // CSS zoom relative to the 16px default (clean, overrides fixed sizes).
  const scale = (termFontSize || 16) / 16;

  return (
    <TooltipProvider>
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
            <Button variant="ghost" size="sm" onClick={revealEarlier} disabled={loadingOlder}>
              {loadingOlder
                ? <><span className="host-spinner inline-block size-3" /> {t('chat.loadingTranscript')}</>
                : <><ChevronUpIcon /> {hiddenCount > 0 ? t('chat.showEarlier', { n: hiddenCount }) : t('chat.loadEarlier') || 'Load earlier messages'}</>
              }
            </Button>
          </div>
        )}
        {events.length === 0 &&
          (loading ? (
            <ChatSkeleton label={t('chat.loadingTranscript')} />
          ) : (
            <div className="py-6 text-center text-xs text-[var(--term-faint)]">
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
          // OPENUI phase 3: exactly ONE card may own the keyboard — the most recent
          // blocking card of either kind (the CLI blocks on one thing at a time).
          // A blocking card the transcript has moved past (a newer blocking card,
          // a later user message or a turn result after it) is STALE: it freezes
          // with no live buttons, whatever the session state says.
          let lastBlockIdx = -1;
          const stale = new Set();
          for (let k = events.length - 1, movedOn = false; k >= 0; k--) {
            const e = events[k];
            if (isAsk(e) || isPerm(e)) {
              if (lastBlockIdx < 0) lastBlockIdx = k;
              if (movedOn) stale.add(k);
              movedOn = true;
            } else if (e.kind === 'user' || e.kind === 'result') movedOn = true;
          }
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
          // Tool results paired to their tool_use (edit cards read "not applied" from it).
          const results = new Map();
          const editIds = new Set();
          events.forEach((e) => {
            if (e.kind === 'tool-result' && e.toolUseId) results.set(e.toolUseId, e);
            else if (isEditEvent(e) && e.toolUseId) editIds.add(e.toolUseId);
          });
          // The card IS the visible output of an edit (a failure shows as its "not applied" note) — its result row would only repeat it.
          const isEditOk = (e) => e.kind === 'tool-result' && editIds.has(e.toolUseId);
          const out = [];
          let actionRendered = false;
          let mergeOfferRendered = false;
          const visible = events.slice(hiddenCount);
          // SIMPLE1: in Simple mode each turn's folded events collect into one
          // group, rendered as a BehindScenes slot where the first of them was.
          // A `user` event starts a new turn (and a new group).
          let group = null;
          for (let j = 0; j < visible.length; j++) {
            const e = visible[j];
            const i = hiddenCount + j;
            if (isCapRow(e) || (!simple && isEditOk(e))) continue;
            if (simple) {
              if (e.kind === 'user') group = null;
              if (hiddenInSimple(e)) {
                if (!group) {
                  group = { events: [], rows: [] };
                  const g = group;
                  out.push(
                    <BehindScenesSlot key={`bs:${keys[i]}`} sessionId={sessionId} group={g} events={events} results={results} />
                  );
                }
                group.events.push(e);
                if (!isEditOk(e)) group.rows.push({ key: keys[i], event: e, recap: recap.has(i) });
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
            if (e.kind === 'action-request') {
              // The action card lives in the transcript, where it was raised — it scrolls
              // up with the conversation. Live only while it is still the current action.
              const liveAction = action && action.id === e.actionId ? action : null;
              if (liveAction) actionRendered = true;
              out.push(
                <div key={keys[i]} data-event-id={e.id || keys[i]}>
                  {liveAction ? (
                    <HostCard name="ActionCard" props={{ sessionId, action: liveAction }} />
                  ) : (
                    <div data-action-record dir="auto" className="my-1.5 flex items-start gap-1.5 text-xs text-[var(--term-dim)]">
                      <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--term-faint)]" /> <span className="min-w-0">{t('chat.actionRecord')}: {e.prompt}</span>
                    </div>
                  )}
                </div>
              );
              continue;
            }
            if (e.kind === 'merge-offer') {
              // After approval the merge is one click — recorded in the transcript where the human
              // approved, live while it still applies, and dismissable.
              const rv = session?.metadata?.review;
              const liveOffer = mergeOfferLive && rv?.at === e.approvedAt;
              if (liveOffer) mergeOfferRendered = true;
              out.push(
                <div key={keys[i]} data-event-id={e.id || keys[i]}>
                  {liveOffer ? (
                    <HostCard name="MergePanel" props={{ session, dark: true, onDismiss: dismissMergeOffer }} />
                  ) : (
                    <div data-merge-offer-record className="my-1.5 flex items-center gap-1.5 text-xs text-[var(--term-dim)]">
                      <CheckIcon className="size-3.5 shrink-0 text-[var(--term-faint)]" /> {t('chat.mergeOfferRecord')}
                    </div>
                  )}
                </div>
              );
              continue;
            }
            const live = !!awaiting && i === lastBlockIdx;
            out.push(<div key={keys[i]} data-event-id={e.id || keys[i]}><Event sessionId={sessionId} event={e} live={live} stale={stale.has(i)} recap={recap.has(i)} result={results.get(e.toolUseId)} /></div>);
          }
          // A current action with no record in the visible transcript (raised before cards were
          // recorded, or scrolled out of the window) still has to be answerable: show it last.
          if (action && !actionRendered) out.push(<HostCard key="action-fallback" name="ActionCard" props={{ sessionId, action }} />);
          // An approval with no record in the visible transcript (approved before offers were recorded,
          // or scrolled out of the window) still offers the merge — last, and dismissable.
          if (mergeOfferLive && !mergeOfferRendered) out.push(<HostCard key="merge-fallback" name="MergePanel" props={{ session, dark: true, onDismiss: dismissMergeOffer }} />);
          return out;
        })()}
        {working && (
          <div className="my-3 flex items-center gap-2 text-xs text-[var(--term-dim)]" data-working role="status">
            <span className="host-spinner size-3" />
            <span className="working-shimmer">{t('chat.working')}</span>
          </div>
        )}
      </div>
    </div>
    {away && (
      <Tip label={t('chat.jumpToLatest')}>
        <Button
          variant="default"
          size="icon-sm"
          onClick={jumpToBottom}
          aria-label={t('chat.jumpToLatest')}
          className="absolute bottom-3 start-1/2 z-10 -translate-x-1/2 rounded-full shadow-card rtl:translate-x-1/2"
        >
          <ArrowDownIcon />
        </Button>
      </Tip>
    )}
    </div>
    </TooltipProvider>
  );
}
