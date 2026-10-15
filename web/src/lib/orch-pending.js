// What is a child session waiting on? Pure functions over its raw chat events
// (GET /sessions/:id/chat — the same rows the child's own chat shows), so the
// Orchestration "Needs you" row can show the request and its one next action
// without any new server capability: Approve / Deny go through the existing
// POST /sessions/:id/permission/answer (answerPermission in lib/store.js).

const toolOf = (e) => e.toolName ?? e.tool_name ?? e.name ?? 'tool';

/**
 * The child's open request, or null.
 *   { type: 'permission', requestId, tool, summary }  → Approve / Deny
 *   { type: 'question',  text }                       → Answer (opens the child)
 * Anything the conversation moved past (a later user message or result), or that has an answer, is closed.
 */
export function pendingRequestOf(events) {
  const evs = Array.isArray(events) ? events : [];
  const answered = new Set();
  for (const e of evs) if (e.kind === 'permission-answer') answered.add(e.requestId ?? e.request_id);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === 'user' || e.kind === 'result') return null; // moved on
    if (e.kind === 'permission-request') {
      const id = e.requestId ?? e.request_id;
      if (answered.has(id) || e.answered) return null;
      if (toolOf(e) === 'AskUserQuestion') {
        const q = e.input?.questions?.[0]?.question;
        return { type: 'question', text: String(q || '') };
      }
      return { type: 'permission', requestId: id, tool: toolOf(e), summary: summarizeInput(e.input) };
    }
  }
  return null;
}

/** One short line of what the tool wants to do ("git push origin HEAD", a path, …). */
export function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? Object.values(input).find((x) => typeof x === 'string') ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 140);
}

/**
 * The one next action of a worker row: 'approve' (a permission is open), 'answer' (a question),
 * 'review' (changes approved-pending or finished with a review to read), else null.
 */
export function nextAction(pending, worker) {
  if (pending?.type === 'permission') return 'approve';
  if (pending?.type === 'question') return 'answer';
  if (worker && worker.claude_state === 'awaiting-input') return 'answer';
  if (worker && worker.branch && !worker.merged && worker.result?.state === 'done' && worker.review?.state !== 'approved') return 'review';
  return null;
}
