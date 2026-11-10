// CONSOL1 — the PURE half of memory consolidation ("dreaming"). LEARN1 only ever
// ADDS to USER.md/MEMORY.md (ENTER, or a MERGE that must keep every clause of the
// line it grows), so once a file sits at its token cap every new fact is
// deferred forever: nothing is ever pruned, merged or refreshed. This module is
// the other direction — a batch over the EXISTING lines that proposes a diff
// (MERGE / REWRITE / DROP / MOVE_TO_SKILL, everything else KEEP) the human
// reviews. server/memory-learning.ts wraps it with the LLM one-shot, the
// consolidation run log, optimistic-concurrency apply and per-op undo.
//
// Only one class of change is ever applied without a human: a MERGE or DROP of
// lines this module itself verifies are restatements of each other (the same
// near-duplicate test the pre-pass uses). Everything else — a rewrite of a stale
// line, dropping a line that is merely "low value", moving a procedure to a
// skill — is a judgement call and waits for approval.
import {
  type Target,
  isNearDuplicate,
  isAlreadyKnown,
  tokenLoss,
  normalizeText,
  MERGE_MAX_LOSS,
} from './memory-triage.js';

export type OpKind = 'MERGE' | 'REWRITE' | 'DROP' | 'MOVE_TO_SKILL';

export interface ExistingLine {
  /** Stable within one proposal: U1.. for USER.md, M1.. for MEMORY.md (1-based bullet order). */
  id: string;
  target: Target;
  /** The bullet text without the leading "- " (and without stray repeated "- - " prefixes). */
  text: string;
  /** The raw line as it sits in the file — what writeMemory matches on. */
  raw: string;
}

export interface ConsolidationOp {
  key: string;
  kind: OpKind;
  target: Target;
  /** Existing line ids this op consumes (MERGE ≥ 2, others exactly 1). */
  lines: string[];
  /** The original texts of those lines (frozen at plan time — what undo restores). */
  originals: string[];
  /** MERGE/REWRITE: the replacement line. */
  content?: string;
  /** MOVE_TO_SKILL: the skill that should carry the procedure. */
  skill?: string;
  reason: string;
  /** Deterministically verified restatement (pure dedupe) — the only kind auto mode may apply. */
  verified: boolean;
}

export interface ConsolidationPlan {
  ops: ConsolidationOp[];
  /** Deferred cluster keys the model says should ENTER once the room exists. */
  admit: string[];
  notes: string[];
  tokens: { before: Record<Target, number>; after: Record<Target, number> };
  /** true only when every op is a verified MERGE/DROP of duplicates. */
  autoApplicable: boolean;
}

/** A deferred learning cluster, as the consolidation prompt sees it. */
export interface DeferredFact {
  key: string;
  target: Target;
  content: string;
  count: number;
}

const BULLET = /^\s*(?:[-*]\s+)+/;

/** "- - foo" → "foo" (the live USER.md has a few doubled bullets from hand edits). */
export function bulletText(raw: string): string {
  return raw.replace(BULLET, '').trim();
}

export function numberLines(userMd: string, memoryMd: string): ExistingLine[] {
  const out: ExistingLine[] = [];
  const add = (doc: string, target: Target, prefix: string) => {
    let n = 0;
    for (const raw of doc.split('\n')) {
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      out.push({ id: `${prefix}${++n}`, target, text: bulletText(raw), raw });
    }
  };
  add(userMd, 'user', 'U');
  add(memoryMd, 'memory', 'M');
  return out;
}

export function buildConsolidationPrompt(input: {
  lines: ExistingLine[];
  deferred: DeferredFact[];
  caps: Record<Target, number>;
  tokens: Record<Target, number>;
  skills: string[];
}): string {
  const show = (t: Target) =>
    input.lines
      .filter((l) => l.target === t)
      .map((l) => `${l.id}: ${l.text}`)
      .join('\n') || '(empty)';
  const deferred = input.deferred.length
    ? input.deferred.map((d) => `${d.key} [target=${d.target}, seen ×${d.count}]: ${d.content}`).join('\n')
    : '(none)';
  return (
    `You are consolidating Arigami's two always-loaded memory files — a nightly "dream" pass over what is ` +
    `ALREADY stored, not a triage of new facts. Both files are re-injected into every future session, so every ` +
    `line costs tokens forever. They are full: USER.md ${input.tokens.user}/${input.caps.user} tokens, MEMORY.md ` +
    `${input.tokens.memory}/${input.caps.memory} tokens, and the facts below are waiting for room.\n\n` +
    `USER.md (facts about the human):\n${show('user')}\n\nMEMORY.md (world/work facts, standing policies):\n${show('memory')}\n\n` +
    `Facts waiting for room (do NOT decide them here, only list the ones that deserve a line once room exists):\n${deferred}\n\n` +
    `Skills that exist (procedures belong there, not in memory): ${input.skills.join(', ') || '(none)'}\n\n` +
    `Propose operations over the EXISTING lines. Every line you do not mention is kept as is.\n` +
    `- "MERGE": two or more lines of the SAME file say overlapping things — "lines" = their ids, "content" = one ` +
    `line that keeps every durable piece of information of all of them, shorter than their sum.\n` +
    `- "REWRITE": the line is stale, wrong, or wordy — "content" = the corrected/tighter line (keep identifiers).\n` +
    `- "DROP": ephemeral (a one-off task's details), derivable from the repo/docs/host prompt, or superseded.\n` +
    `- "MOVE_TO_SKILL": a multi-step procedure or tool detail only one workflow needs — "skill" = the skill name.\n` +
    `Keep user preferences, standing rules, people and environment gotchas that are still true and not derivable. ` +
    `Never add secrets, credentials, ID numbers or addresses. "reason" = ONE short line.\n\n` +
    `Output ONLY a JSON object (no prose, no markdown fences):\n` +
    `{"ops":[{"kind":"MERGE|REWRITE|DROP|MOVE_TO_SKILL","lines":["M3","M7"],"content":"...","skill":"...","reason":"..."}],` +
    `"admit":["c1","c4"]}`
  );
}

function extractJson(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(a, b + 1));
}

const MAX_CONTENT = 600;

/**
 * Validate the model's diff against the numbered lines: unknown ids, a line used
 * by two ops, a MERGE across files or of a single line, a MERGE/REWRITE with no
 * content are all dropped with a note (never guessed). Each surviving op is then
 * classified `verified` (pure dedupe) or not.
 */
export function parseConsolidation(text: string, lines: ExistingLine[], deferredKeys: string[] = []): { ops: ConsolidationOp[]; admit: string[]; notes: string[] } {
  const parsed = extractJson(text);
  const raw: any[] = Array.isArray(parsed?.ops) ? parsed.ops : [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const used = new Set<string>();
  const notes: string[] = [];
  const ops: ConsolidationOp[] = [];
  for (const r of raw) {
    const kind = String(r?.kind || '').toUpperCase().replace(/[\s-]/g, '_') as OpKind;
    if (!['MERGE', 'REWRITE', 'DROP', 'MOVE_TO_SKILL'].includes(kind)) continue;
    const ids: string[] = (Array.isArray(r.lines) ? r.lines : [r.lines]).map((x: unknown) => String(x || '').trim()).filter(Boolean);
    const found = ids.map((id) => byId.get(id));
    if (!ids.length || found.some((l) => !l)) { notes.push(`${kind} ${ids.join('+')}: unknown line id — skipped`); continue; }
    if (ids.some((id) => used.has(id))) { notes.push(`${kind} ${ids.join('+')}: a line is already in another op — skipped`); continue; }
    const ls = found as ExistingLine[];
    const target = ls[0].target;
    if (ls.some((l) => l.target !== target)) { notes.push(`${kind} ${ids.join('+')}: spans USER.md and MEMORY.md — skipped`); continue; }
    if (kind === 'MERGE' && ls.length < 2) { notes.push(`MERGE ${ids[0]}: a merge needs two lines — skipped`); continue; }
    if (kind !== 'MERGE' && ls.length !== 1) { notes.push(`${kind} ${ids.join('+')}: exactly one line expected — skipped`); continue; }
    const content = String(r.content || '').trim().replace(BULLET, '').slice(0, MAX_CONTENT);
    if ((kind === 'MERGE' || kind === 'REWRITE') && !content) { notes.push(`${kind} ${ids.join('+')}: no content — skipped`); continue; }
    const skill = kind === 'MOVE_TO_SKILL' ? String(r.skill || '').trim().slice(0, 80) || undefined : undefined;
    ids.forEach((id) => used.add(id));
    ops.push({
      key: `k${ops.length + 1}`,
      kind,
      target,
      lines: ids,
      originals: ls.map((l) => l.text),
      content: content || undefined,
      skill,
      reason: String(r.reason || '').trim().slice(0, 200),
      verified: false,
    });
  }
  // `verified` needs the full op set (a DROP is safe only if its twin survives).
  for (const op of ops) op.verified = isVerifiedDuplicate(op, ops, lines);
  const known = new Set(deferredKeys);
  const admit = (Array.isArray(parsed?.admit) ? parsed.admit : []).map(String).filter((k: string) => !deferredKeys.length || known.has(k));
  return { ops, admit, notes };
}

/**
 * Pure dedupe, checked without the model:
 *  - MERGE: every pair of merged lines is a near-duplicate, and the merged line
 *    loses ≤ MERGE_MAX_LOSS of any original's tokens.
 *  - DROP: the dropped line is already said by a line that SURVIVES the plan (a
 *    kept line, or the content of a MERGE/REWRITE) — never two twins dropping
 *    each other.
 * REWRITE and MOVE_TO_SKILL are never pure: they change or remove meaning.
 */
export function isVerifiedDuplicate(op: ConsolidationOp, ops: ConsolidationOp[], lines: ExistingLine[]): boolean {
  if (op.kind === 'MERGE') {
    for (let i = 0; i < op.originals.length; i++)
      for (let j = i + 1; j < op.originals.length; j++) if (!isNearDuplicate(op.originals[i], op.originals[j])) return false;
    return op.originals.every((o) => tokenLoss(o, op.content || '') <= MERGE_MAX_LOSS);
  }
  if (op.kind === 'DROP') {
    const consumed = new Set(ops.flatMap((o) => o.lines));
    const survivors = [
      ...lines.filter((l) => l.target === op.target && !consumed.has(l.id)).map((l) => l.text),
      ...ops.filter((o) => o.target === op.target && (o.kind === 'MERGE' || o.kind === 'REWRITE') && o.content).map((o) => o.content!),
    ];
    return !!isAlreadyKnown(op.originals[0], survivors);
  }
  return false;
}

/** Apply ops to the documents in memory (no IO) — what the files would look like. */
export function simulateConsolidation(ops: ConsolidationOp[], lines: ExistingLine[], docs: { userMd: string; memoryMd: string }): { userMd: string; memoryMd: string } {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: Record<Target, string[]> = { user: docs.userMd.split('\n'), memory: docs.memoryMd.split('\n') };
  for (const op of ops) {
    const file = out[op.target];
    const idx = (id: string) => file.findIndex((raw) => normalizeText(bulletText(raw)) === normalizeText(byId.get(id)!.text));
    if (op.kind === 'MERGE' || op.kind === 'REWRITE') {
      const first = idx(op.lines[0]);
      if (first >= 0) file[first] = `- ${op.content}`;
      for (const id of op.lines.slice(1)) { const i = idx(id); if (i >= 0) file.splice(i, 1); }
    } else {
      const i = idx(op.lines[0]);
      if (i >= 0) file.splice(i, 1);
    }
  }
  return { userMd: out.user.join('\n'), memoryMd: out.memory.join('\n') };
}

export function planConsolidation(input: {
  text: string;
  userMd: string;
  memoryMd: string;
  deferredKeys?: string[];
  estimateTokens: (s: string) => number;
}): ConsolidationPlan {
  const lines = numberLines(input.userMd, input.memoryMd);
  const { ops, admit, notes } = parseConsolidation(input.text, lines, input.deferredKeys);
  const after = simulateConsolidation(ops, lines, input);
  return {
    ops,
    admit,
    notes,
    tokens: {
      before: { user: input.estimateTokens(input.userMd), memory: input.estimateTokens(input.memoryMd) },
      after: { user: input.estimateTokens(after.userMd), memory: input.estimateTokens(after.memoryMd) },
    },
    autoApplicable: ops.length > 0 && ops.every((o) => o.verified && (o.kind === 'MERGE' || o.kind === 'DROP')),
  };
}

// ---- learning-loop hygiene ------------------------------------------------------

/**
 * A stable signature of "what the learner would see": the pending ids plus the
 * two files' hashes. When a run moved nothing (every cluster deferred for the
 * cap) the next run with the SAME signature can only repeat that answer — the
 * scheduler skips it instead of re-asking the model every 15 minutes.
 */
export function learnSignature(pendingIds: string[], hashes: Record<Target, string>): string {
  return `${[...pendingIds].sort().join(',')}|${hashes.user}|${hashes.memory}`;
}

// ---- housekeeping plans (dry-run only: nothing here deletes) --------------------

export interface EpisodeFile {
  name: string;
  /** ISO date of the episode (from the file name or front matter). */
  date: string;
  bytes: number;
}

/** ISO week label (2026-W45) of a date. */
export function isoWeek(dateIso: string): string {
  const d = new Date(Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The date an episode file name carries (`<session>-2026-11-10T09-00-14-591Z.md`). */
export function episodeDate(name: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}/.exec(name);
  return m ? m[1] : null;
}

/**
 * Episode digest plan: episodes older than `olderThanDays` grouped per ISO week.
 * A digest job would summarize each week into episodes/digest/<week>.md and MOVE
 * (not delete) the originals to episodes/archive/ — only after approval.
 */
export function planEpisodeDigest(files: EpisodeFile[], opts: { now: number; olderThanDays: number }): { weeks: { week: string; files: number; bytes: number }[]; keep: number } {
  const cutoff = new Date(opts.now - opts.olderThanDays * 86400000).toISOString().slice(0, 10);
  const weeks = new Map<string, { week: string; files: number; bytes: number }>();
  let keep = 0;
  for (const f of files) {
    if (!f.date || f.date >= cutoff) { keep++; continue; }
    const w = isoWeek(f.date);
    const e = weeks.get(w) || { week: w, files: 0, bytes: 0 };
    e.files++;
    e.bytes += f.bytes;
    weeks.set(w, e);
  }
  return { weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)), keep };
}

/** pending.json compaction plan: decided (approved/rejected) entries older than N days → archive file. */
export function planPendingCompaction<T extends { status: string; decidedAt?: string; createdAt: string }>(list: T[], opts: { now: number; olderThanDays: number }): { archive: number; keep: number } {
  const cutoff = opts.now - opts.olderThanDays * 86400000;
  let archive = 0;
  for (const p of list) if (p.status !== 'pending' && Date.parse(p.decidedAt || p.createdAt) < cutoff) archive++;
  return { archive, keep: list.length - archive };
}
