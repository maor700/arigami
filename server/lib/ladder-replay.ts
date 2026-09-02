// LADDER1 — fit-or-compact before the model ladder replays a conversation.
//
// THE BUG THIS FIXES: a downgrade (fable → sonnet → haiku, RES1) is a plain
// `--resume` of the SAME claude conversation on the weaker model. Fable runs a
// 1M window; haiku has 200k. A conversation that grew to 600k tokens on fable is
// therefore over haiku's limit before its first turn even starts — the human
// saw it as "the context dies in a second" (incidents.jsonl 2026-09-02 17:12–18:56,
// three sessions walked to the bottom rung and escalated within seconds each).
//
// This module is PURE (no state, no IO, no imports) so the decision and the
// transcript shaping are unit-testable in-process. claude.js does the IO around
// it: measure the live conversation, resolve the target window
// (lib/ctx-window.ts), run the one-shot summarizer (lib/oneshot.ts) on the
// TARGET rung — never on the exhausted one — and respawn.
//
// Shape of a compacted replay, top to bottom, as the first user message of a
// FRESH claude conversation on the weaker model:
//   · the host's usual bootstrap prefix (memory snapshot etc. — writeUserMessage
//     adds it to the first message of every fresh spawn, unchanged)
//   · a [host] preamble: why the switch happened, then
//   · a DIGEST of everything before the tail (LLM-written; a mechanical fallback
//     when the summarizer itself fails), then
//   · the last N turns VERBATIM (images replaced by one-line placeholders), then
//   · the message that was in flight when the quota ran out.

export const DEFAULT_HEADROOM = 0.7; // the replay may use at most this share of the target window
export const DEFAULT_TAIL_TURNS = 6; // user turns kept verbatim
// The summarizer's own input has to fit ITS window (it runs on the target rung
// too), so the digest source is capped to a share of that same window.
export const DIGEST_INPUT_SHARE = 0.3;
export const TAIL_SHARE = 0.15; // the verbatim tail may use at most this share of the target window
export const TOOL_RESULT_MAX_CHARS = 1_600; // per tool result, in the rendered tail
export const CHARS_PER_TOKEN = 4; // the usual rough estimate (memory.ts uses the same)

export interface ChatEventLike {
  kind: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
  attachments?: Array<{ name?: string; isImage?: boolean }>;
  seq?: number;
  [k: string]: unknown;
}

export const estimateTokens = (text: string): number => Math.ceil((text || '').length / CHARS_PER_TOKEN);

// ---- the decision -------------------------------------------------------------

export type ReplayMode = 'full' | 'compact';

export interface ReplayPlan {
  mode: ReplayMode;
  estTokens: number;
  targetWindow: number;
  /** estTokens must be ≤ this to replay in full. */
  fitLimit: number;
  headroom: number;
}

/**
 * Does a conversation of `estTokens` fit `targetWindow` with headroom? The
 * headroom is not paranoia: the resumed conversation has to leave room for the
 * replayed turn itself, its tool results and the model's answer.
 */
export function planReplay(opts: { estTokens: number; targetWindow: number; headroom?: number }): ReplayPlan {
  const headroom = clamp01(opts.headroom ?? DEFAULT_HEADROOM);
  const targetWindow = Math.max(1, Math.floor(opts.targetWindow || 0));
  const estTokens = Math.max(0, Math.floor(opts.estTokens || 0));
  const fitLimit = Math.floor(targetWindow * headroom);
  return { mode: estTokens <= fitLimit ? 'full' : 'compact', estTokens, targetWindow, fitLimit, headroom };
}

const clamp01 = (n: number) => (Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_HEADROOM);

// ---- images -------------------------------------------------------------------
// Base64 image blocks (a Read of a .png, capture_screen, an attached screenshot)
// are the heaviest single items in a transcript and never needed for
// continuity. They ride in tool_result content arrays as
// {type:'image', source:{type:'base64', data}}; a pasted attachment shows up on
// the user event's `attachments` list. Both become one line naming the file.

export interface StripResult<T> {
  content: T;
  stripped: number;
}

const isImageBlock = (b: unknown): b is Record<string, any> =>
  !!b && typeof b === 'object' && (b as any).type === 'image';

function imagePlaceholder(b: Record<string, any>, hint?: string): string {
  const mt = b?.source?.media_type || b?.media_type || 'image';
  const name = hint || b?.source?.path || b?.path || b?.name || null;
  return `[image omitted from the replayed context${name ? `: ${name}` : ''} (${mt})]`;
}

/** Strip image blocks from one tool-result `content` (string or block array). */
export function stripImageBlocks(content: unknown, hint?: string): StripResult<unknown> {
  if (!Array.isArray(content)) return { content, stripped: 0 };
  let stripped = 0;
  const out = content.map((b) => {
    if (isImageBlock(b)) {
      stripped++;
      return { type: 'text', text: imagePlaceholder(b, hint) };
    }
    return b;
  });
  return { content: out, stripped };
}

/** Same, over a list of chat events — tool results and user attachments. */
export function stripImages(events: ChatEventLike[]): StripResult<ChatEventLike[]> {
  let stripped = 0;
  const out = events.map((e) => {
    if (e.kind === 'tool-result' && Array.isArray(e.content)) {
      const hint = typeof e.file === 'string' ? e.file : undefined;
      const r = stripImageBlocks(e.content, hint);
      stripped += r.stripped;
      return r.stripped ? { ...e, content: r.content } : e;
    }
    if (e.kind === 'user' && Array.isArray(e.attachments) && e.attachments.some((a) => a?.isImage)) {
      const names = e.attachments.filter((a) => a?.isImage).map((a) => a.name || 'image');
      stripped += names.length;
      const note = names.map((n) => `[image attachment omitted from the replayed context: ${n}]`).join('\n');
      return { ...e, text: `${e.text || ''}\n${note}`.trim(), attachments: e.attachments.filter((a) => !a?.isImage) };
    }
    return e;
  });
  return { content: out, stripped };
}

// ---- splitting + rendering ----------------------------------------------------

export interface TranscriptSplit {
  head: ChatEventLike[];
  tail: ChatEventLike[];
  tailTurns: number;
}

/**
 * The last `tailTurns` user turns (each = the user message and everything the
 * model did until the next user message) are the tail; everything before is the
 * head the digest is written from. Host receipts/system lines never count as a
 * turn boundary.
 */
export function splitTranscript(events: ChatEventLike[], tailTurns = DEFAULT_TAIL_TURNS): TranscriptSplit {
  const n = Math.max(0, Math.floor(tailTurns));
  let seen = 0;
  let cut = 0;
  for (let i = events.length - 1; i >= 0 && n > 0; i--) {
    if (events[i].kind === 'user') {
      seen++;
      if (seen === n) {
        cut = i;
        break;
      }
    }
  }
  if (seen < n) cut = 0; // fewer turns than asked → everything is tail
  return { head: events.slice(0, cut), tail: events.slice(cut), tailTurns: Math.min(n, seen) };
}

const oneLine = (s: unknown, max: number): string => {
  const t = typeof s === 'string' ? s : s == null ? '' : safeJson(s);
  return t.length > max ? t.slice(0, max) + ` …(+${t.length - max} chars)` : t;
};

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : isImageBlock(b) ? imagePlaceholder(b) : safeJson(b)))
      .join('\n');
  return content == null ? '' : safeJson(content);
}

/** One chat event as a plain-text transcript line (images already stripped). */
export function renderEvent(e: ChatEventLike, { toolResultMax = TOOL_RESULT_MAX_CHARS } = {}): string {
  switch (e.kind) {
    case 'user':
      return `USER: ${e.text || ''}`;
    case 'assistant-text':
      return `ASSISTANT: ${e.text || ''}`;
    case 'tool-use':
      return `TOOL ${e.name || '?'}(${oneLine(e.input, 600)})`;
    case 'tool-result':
      return `RESULT${e.isError ? ' (error)' : ''}: ${oneLine(contentText(e.content), toolResultMax)}`;
    case 'result':
      return e.isError ? `TURN ENDED WITH ERROR: ${oneLine(e.text, 300)}` : '';
    case 'error':
      return `ERROR: ${oneLine(e.text, 300)}`;
    case 'system':
      return `[host] ${oneLine(e.text, 300)}`;
    case 'thinking':
      return ''; // never replayed — it is the model's own scratch space
    default:
      return e.text ? `${e.kind.toUpperCase()}: ${oneLine(e.text, 300)}` : '';
  }
}

export interface RenderResult {
  text: string;
  omitted: number; // events dropped from the middle to meet maxChars
}

/**
 * Render events to text within `maxChars`. When they don't fit, the FIRST turn
 * (the task framing) and the most recent part are kept and the middle is dropped
 * with a marker — a summary of the beginning and the end beats a summary of the
 * beginning alone.
 */
export function renderEvents(events: ChatEventLike[], maxChars: number, opts: { toolResultMax?: number } = {}): RenderResult {
  const lines = events.map((e) => renderEvent(e, opts)).filter(Boolean);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return { text: lines.join('\n'), omitted: 0 };
  // Keep the first ~20% and the last ~80% of the budget.
  const headBudget = Math.floor(maxChars * 0.2);
  const head: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > headBudget) break;
    head.push(l);
    used += l.length + 1;
  }
  const tail: string[] = [];
  let tused = 0;
  const marker = '\n[… earlier part of the conversation omitted …]\n';
  const tailBudget = maxChars - used - marker.length;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i];
    if (tused + l.length + 1 > tailBudget) break;
    tail.unshift(l);
    tused += l.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  if (omitted <= 0) return { text: lines.join('\n'), omitted: 0 };
  return { text: head.join('\n') + marker + tail.join('\n'), omitted };
}

// ---- the digest + preamble ----------------------------------------------------

export function digestPrompt(headText: string, opts: { from: string; to: string }): string {
  return (
    `You are compacting the context of a live Arigami agent session so it can continue on a smaller model ` +
    `(${opts.from} ran out of quota; the session moves to ${opts.to}, whose context window is smaller). ` +
    `Below is the OLDER part of the conversation; the most recent turns are kept verbatim elsewhere and are not your job.\n\n` +
    `Write a dense, factual digest (plain text, no markdown headers, at most ~1200 words) that lets the agent keep ` +
    `working without re-reading anything: the task and its constraints, decisions taken and why, files/paths/branches/ids ` +
    `touched, what is done, what is in progress, what is still open, and anything the human asked for or corrected. ` +
    `Keep exact identifiers (paths, commands, URLs, ticket ids, numbers). Never include secrets or tokens. Output only the digest.\n\n` +
    `--- older conversation ---\n${headText}\n--- end ---`
  );
}

/**
 * The mechanical digest used when the summarizer itself fails (no quota on the
 * target rung either, timeout, …): every user message, in order, truncated.
 * Not smart, but it keeps the task framing alive.
 */
export function fallbackDigest(head: ChatEventLike[], maxChars = 6_000): string {
  const users = head.filter((e) => e.kind === 'user' && e.text).map((e) => `- ${oneLine(e.text, 400)}`);
  let out = users.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n- …';
  return out ? `The human's messages so far, in order (an automatic summary was not available):\n${out}` : '(no earlier conversation)';
}

export interface PreambleOpts {
  from: string;
  to: string;
  digest: string;
  tailText: string;
  tailTurns: number;
  estTokens: number;
  targetWindow: number;
  imagesStripped: number;
  omittedFromDigest: number;
  resetAtLocal?: string | null;
}

/** The `[host]` block that precedes the replayed message on the fresh conversation. */
export function buildPreamble(o: PreambleOpts): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return (
    `[host — context compacted] This session was running on ${o.from}, which ran out of quota` +
    (o.resetAtLocal ? ` (resets ${o.resetAtLocal})` : '') +
    `. It now continues on ${o.to}. The full conversation (~${k(o.estTokens)} tokens) does not fit ${o.to}'s ` +
    `${k(o.targetWindow)}-token window, so it was compacted: a digest of the older part, then the last ${o.tailTurns} ` +
    `turn${o.tailTurns === 1 ? '' : 's'} verbatim` +
    (o.imagesStripped ? ` (${o.imagesStripped} image${o.imagesStripped === 1 ? '' : 's'} replaced by placeholders)` : '') +
    (o.omittedFromDigest ? `; ${o.omittedFromDigest} older events could not be summarized and were dropped` : '') +
    `. Continue the work; do not re-do what the digest says is done. When ${o.from}'s quota resets the host climbs back ` +
    `to it automatically and restores the full history.\n\n` +
    `=== DIGEST OF THE OLDER CONVERSATION ===\n${o.digest.trim()}\n\n` +
    `=== LAST ${o.tailTurns} TURN${o.tailTurns === 1 ? '' : 'S'} (verbatim) ===\n${o.tailText.trim()}\n=== END OF REPLAYED CONTEXT ===\n\n`
  );
}

/**
 * Budgets for one compaction, all derived from the TARGET window. The digest
 * source is what the summarizer reads (its own window is the same target's);
 * the tail is what gets replayed verbatim.
 */
export function compactBudgets(targetWindow: number) {
  const w = Math.max(1, Math.floor(targetWindow));
  return {
    digestInputChars: Math.floor(w * DIGEST_INPUT_SHARE) * CHARS_PER_TOKEN,
    tailChars: Math.floor(w * TAIL_SHARE) * CHARS_PER_TOKEN,
  };
}

export interface CompactShape {
  head: ChatEventLike[];
  tail: ChatEventLike[];
  tailTurns: number;
  tailText: string;
  digestSource: string;
  omittedFromDigest: number;
  imagesStripped: number;
}

/**
 * Everything the IO layer needs before it calls the summarizer: the split,
 * images stripped, tail rendered within budget, digest source rendered within
 * budget. Pure — the summarizer call itself lives in claude.js.
 */
export function shapeForCompaction(
  events: ChatEventLike[],
  targetWindow: number,
  { tailTurns = DEFAULT_TAIL_TURNS }: { tailTurns?: number } = {}
): CompactShape {
  const stripped = stripImages(events);
  const { head, tail, tailTurns: kept } = splitTranscript(stripped.content, tailTurns);
  const b = compactBudgets(targetWindow);
  const tailR = renderEvents(tail, b.tailChars);
  const headR = renderEvents(head, b.digestInputChars);
  return {
    head,
    tail,
    tailTurns: kept,
    tailText: tailR.text,
    digestSource: headR.text,
    omittedFromDigest: headR.omitted,
    imagesStripped: stripped.stripped,
  };
}

// ---- the per-session note -----------------------------------------------------
// Persisted on session.claude.ladderReplay so the climb back knows what it is
// looking at: a compacted conversation whose ORIGINAL (full) one is still on
// disk under `originalSessionId`, and how big that original was.

export interface LadderReplayNote {
  mode: ReplayMode | 'full-restore' | 'compact-restore';
  at: string; // ISO
  from: string;
  to: string;
  estTokens: number; // size of the conversation that was judged
  targetWindow: number;
  /** The claude conversation id the FULL history lives under (compact only). */
  originalSessionId?: string | null;
  /** The fresh conversation id the compacted replay started (compact only). */
  compactSessionId?: string | null;
  tailTurns?: number;
  imagesStripped?: number;
  digest?: 'llm' | 'fallback';
}

/**
 * On the climb back: resume the ORIGINAL full conversation when it fits the
 * top rung's window (it always did — that is where it was born — but the top
 * rung may have changed by hand meanwhile), else stay on the compacted one.
 */
export function restoreTarget(
  note: LadderReplayNote | null | undefined,
  topWindow: number,
  headroom = DEFAULT_HEADROOM
): { resume: 'original' | 'current'; reason: string } {
  if (!note || note.mode !== 'compact' || !note.originalSessionId) return { resume: 'current', reason: 'no compacted replay to undo' };
  const plan = planReplay({ estTokens: note.estTokens, targetWindow: topWindow, headroom });
  return plan.mode === 'full'
    ? { resume: 'original', reason: `the full history (~${note.estTokens} tokens) fits the ${topWindow}-token window` }
    : { resume: 'current', reason: `the full history (~${note.estTokens} tokens) no longer fits the ${topWindow}-token window` };
}
