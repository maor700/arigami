// SIMPLE1: the chat has two presentations of the same transcript.
//   · 'full'   — the terminal view: every event (tool calls, results, diffs,
//                thinking, status lines) rendered inline.
//   · 'simple' — the conversation only: the human's messages and the
//                assistant's prose. Everything else is folded, per turn, into
//                one muted "behind the scenes · N actions" line that expands
//                inline to the full rendering. Cards that need the human
//                (questions, permissions, screen hand-overs, setup, merge,
//                agent drafts) and what the assistant produced (screenshots,
//                artifacts) always stay visible.
//
// The mode is PER SESSION and lives in session.metadata.chatMode so the host
// sees it too (server/claude.js injects a brevity rule while it is 'simple').
// New sessions are stamped 'simple' at creation (server/state.ts); sessions
// from before this shipped have no field and keep the terminal view on
// desktop — on a phone-width viewport the unset default is 'simple'.

export const CHAT_MODES = ['simple', 'full'];

export function chatModeOf(session, isDesktop = true) {
  const m = session?.metadata?.chatMode;
  if (m === 'simple' || m === 'full') return m;
  return isDesktop ? 'full' : 'simple';
}

const toolName = (e) => String(e.name ?? e.tool ?? e.toolName ?? '');
const isErr = (e) => !!(e.isError ?? e.is_error ?? e.subtype === 'error');

// Events that fold behind the counter in Simple mode. Anything not listed here
// (user, assistant prose, question/permission/screen/setup/merge/agent cards,
// screenshots, artifacts, errors) renders as in the terminal view.
export function hiddenInSimple(e) {
  if (!e || typeof e !== 'object') return false;
  switch (e.kind) {
    case 'thinking':
    case 'tool-result':
    case 'system':
    case 'action-auto':
    case 'delegated':
    case 'agent-adopt':
      return true;
    case 'tool-use':
      return toolName(e) !== 'AskUserQuestion';
    case 'result':
      return !isErr(e); // a failed turn is news for the human — keep it
    default:
      return false;
  }
}

// What "N actions" counts: the tool calls (not their results / thinking).
export function isAction(e) {
  return e?.kind === 'tool-use' && toolName(e) !== 'AskUserQuestion';
}

// Does a folded group carry anything worth a line? A group made only of
// end-of-turn "done" markers has nothing behind the scenes to show.
export function groupHasSubstance(events) {
  return events.some((e) => e.kind !== 'result');
}
