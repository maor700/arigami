// M3 — skill proposals: agent-authored suggestions for skills/*/SKILL.md,
// staged where an agent can NEVER touch the live pack directly. Modeled on the
// same "start closed, always show a diff" principle as memory.ts, but the gate
// is stricter here (full human apply/reject/quarantine, no direct-write path
// at all) because skills are git-tracked and shared by EVERY session — a bad
// skill hurts everyone, not just the agent that wrote it (spec M3, RESEARCH
// §1.3: Hermes's #70128 — a skill changed with no diff shown; OpenClaw's
// Skill Workshop staging pattern is what this follows instead).
//
// Storage: $ARIGAMI_DIR/skill-proposals/<id>/ — never skills/ itself.
//   meta.json     — status/flags/rationale/etc (source of truth for the API)
//   PROPOSAL.md   — the same thing, human-readable (rationale + evidence)
//   base.md       — snapshot of the target skill's content when proposed ('' if new)
//   content.md    — the full proposed SKILL.md text (what apply() writes verbatim)
//   diff          — unified diff, base.md → content.md, as computed at propose time
//
// getProposal() recomputes the diff against the skill's CURRENT content (not
// the stale base.md snapshot) so a human reviewing later always sees an
// accurate before/after — the exact thing Hermes's #70128 critique says was
// missing. `stale:true` flags when the live skill moved since the proposal
// was filed.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import { NAME_RE, isSkillDir, readSkillContent, writeSkill, type SkillSummary } from './skills.js';

export const PROPOSALS_DIR = path.join(ARIGAMI_DIR, 'skill-proposals');
export const AUDIT_LOG = path.join(PROPOSALS_DIR, '.audit.jsonl');

function ensureDir(): void {
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ---- heuristic scan (flags, never blocks — spec M3.2) -----------------------
// Deliberately basic (not a sandbox/static-analyzer) — the point is to draw
// the human reviewer's eye, not to gate. Patterns echo the ones RESEARCH.md
// cites as the actual exploited techniques (curl|sh install one-liners,
// credential-shaped strings, markdown-image exfiltration, and HTML comments
// hidden from GitHub's renderer — the ToxicSkills/OpenClaw backdoor pattern).
const CURL_PIPE_RE = /(curl|wget)\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i;
const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,}/i,
];
const EXFIL_RES: RegExp[] = [
  /!\[[^\]]*\]\(https?:\/\/[^)]+\)/, // markdown image → external fetch
  /\b(curl|wget|fetch)\b[^\n]*\b(https?:\/\/[^\s)]+)[^\n]*\|/i, // pipe a remote fetch into something
];
const HIDDEN_COMMENT_RE = /<!--[\s\S]*?-->/;

export type ProposalFlag = 'curl-pipe-shell' | 'possible-secret' | 'possible-exfiltration' | 'hidden-html-comment';

export function scanSkillContent(content: string): ProposalFlag[] {
  const flags: ProposalFlag[] = [];
  if (CURL_PIPE_RE.test(content)) flags.push('curl-pipe-shell');
  if (SECRET_RES.some((re) => re.test(content))) flags.push('possible-secret');
  if (EXFIL_RES.some((re) => re.test(content))) flags.push('possible-exfiltration');
  if (HIDDEN_COMMENT_RE.test(content)) flags.push('hidden-html-comment');
  return flags;
}

// ---- line diff (no external dep — dynamic-programming LCS, unified-diff out) -
// Skill files are small (a few hundred lines at most, MAX_FILE guards huge
// ones elsewhere) so an O(n*m) LCS table is cheap; the size guard below is a
// defensive fallback, not the expected path.
type DiffOp = { type: 'ctx' | 'del' | 'add'; line: string };

function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    // Pathological size — fall back to a whole-file replace instead of
    // spending seconds/hundreds of MB on an LCS table nobody asked for.
    return [
      ...oldLines.map((line) => ({ type: 'del' as const, line })),
      ...newLines.map((line) => ({ type: 'add' as const, line })),
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'ctx', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: oldLines[i++] });
  while (j < m) ops.push({ type: 'add', line: newLines[j++] });
  return ops;
}

const DIFF_CONTEXT = 3;

// Minimal unified diff: only the changed regions, each wrapped in
// DIFF_CONTEXT lines of context, split into separate hunks when the gap
// between changes exceeds 2*DIFF_CONTEXT (same grouping rule as `diff -u`).
// DiffView.jsx's parser (`@@ -a,b +c,d @@` then ' '/'-'/'+' lines) handles
// any number of hunks, so the Proposals UI shows just what changed.
export function buildUnifiedDiff(oldContent: string, newContent: string, label: string): string {
  if (oldContent === newContent) return '';
  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');
  const ops = diffOps(oldLines, newLines);
  const header = `--- a/${label}\n+++ b/${label}\n`;

  // Index of every non-context op; group into hunks by gap.
  const changeIdx: number[] = [];
  ops.forEach((o, k) => {
    if (o.type !== 'ctx') changeIdx.push(k);
  });
  if (!changeIdx.length) return '';
  const groups: Array<[number, number]> = []; // [firstChange, lastChange] op indices
  let gs = changeIdx[0];
  let ge = changeIdx[0];
  for (let k = 1; k < changeIdx.length; k++) {
    if (changeIdx[k] - ge > 2 * DIFF_CONTEXT) {
      groups.push([gs, ge]);
      gs = changeIdx[k];
    }
    ge = changeIdx[k];
  }
  groups.push([gs, ge]);

  // Old/new line numbers at the start of each op, so hunk headers can be computed.
  const oldAt: number[] = new Array(ops.length + 1);
  const newAt: number[] = new Array(ops.length + 1);
  let oi = 0;
  let ni = 0;
  ops.forEach((o, k) => {
    oldAt[k] = oi;
    newAt[k] = ni;
    if (o.type !== 'add') oi++;
    if (o.type !== 'del') ni++;
  });
  oldAt[ops.length] = oi;
  newAt[ops.length] = ni;

  let out = header;
  for (const [a, b] of groups) {
    const from = Math.max(0, a - DIFF_CONTEXT);
    const to = Math.min(ops.length, b + 1 + DIFF_CONTEXT); // exclusive
    const oldCount = oldAt[to] - oldAt[from];
    const newCount = newAt[to] - newAt[from];
    // Unified-diff convention: a zero-length side reports its start as the
    // line BEFORE the hunk (0 for an empty file).
    const oldStart = oldCount ? oldAt[from] + 1 : oldAt[from];
    const newStart = newCount ? newAt[from] + 1 : newAt[from];
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (let k = from; k < to; k++) {
      const o = ops[k];
      out += (o.type === 'ctx' ? ' ' : o.type === 'del' ? '-' : '+') + o.line + '\n';
    }
  }
  return out;
}

// ---- unified-diff applier for skill_propose's `patch` form -------------------
// Validates that context/deleted lines actually match the base content it's
// applied to (refuses instead of silently corrupting on a mismatch) — a bad
// apply here would land in a human's review queue looking like a clean
// proposal. Tolerant of the ways an agent-written patch drifts from the
// canonical form without changing its meaning:
//   - CRLF line endings (patch or skill), a missing/extra trailing newline
//   - blank context lines sent as "" instead of " " (tool layers strip trailing
//     whitespace; this is what broke the wave-1 `patch` attempt)
//   - trailing whitespace differences on context lines
//   - hunk headers whose line numbers are off (miscounted): the hunk is located
//     by its context, nearest to the stated position, never before the previous
//     hunk
// A genuine mismatch reports the first non-matching line with what the patch
// expected and what the skill has there.
const normLine = (l: string): string => l.replace(/\s+$/, '');

interface Hunk {
  oldStart: number; // 0-based, from the header
  oldCount: number | null; // declared old-side length, when the header has one
  lines: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}

// Blank lines past the declared old-side length (a patch pasted with extra
// trailing newlines) are padding, not context.
function trimPadding(h: Hunk): void {
  if (h.oldCount === null) return;
  let oldLen = h.lines.filter((l) => l.kind !== '+').length;
  while (oldLen > h.oldCount && h.lines.length) {
    const last = h.lines[h.lines.length - 1];
    if (last.kind !== ' ' || last.text !== '') break;
    h.lines.pop();
    oldLen--;
  }
}

function parseHunks(patchText: string): Hunk[] | { error: string } {
  const patchLines = patchText.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline in the patch text produces one empty final line — drop it.
  if (patchLines.length && patchLines[patchLines.length - 1] === '') patchLines.pop();
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const raw of patchLines) {
    const hm = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hm) {
      cur = { oldStart: Math.max(0, parseInt(hm[1], 10) - 1), oldCount: hm[2] === undefined ? null : parseInt(hm[2], 10), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // ---/+++ headers and any preamble before the first hunk
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('---') || raw.startsWith('+++')) {
      // A second file header mid-patch — not something we support (single file).
      cur = null;
      continue;
    }
    const kind = raw[0];
    if (kind === ' ' || kind === '-' || kind === '+') cur.lines.push({ kind, text: raw.slice(1) });
    else if (raw === '') cur.lines.push({ kind: ' ', text: '' }); // blank context line with its leading space stripped
    else return { error: `malformed patch line (expected ' ', '-' or '+' prefix): ${JSON.stringify(raw.slice(0, 80))}` };
  }
  if (!hunks.length) return { error: 'no valid @@ hunk header found in patch' };
  hunks.forEach(trimPadding);
  return hunks;
}

// Does hunk h's old side (context + deletions) match orig at position pos?
// Returns null on match, else the index (into h.lines) of the first mismatch.
function hunkMismatchAt(orig: string[], h: Hunk, pos: number): number | null {
  let oi = pos;
  for (let k = 0; k < h.lines.length; k++) {
    const l = h.lines[k];
    if (l.kind === '+') continue;
    if (oi >= orig.length || normLine(orig[oi]) !== normLine(l.text)) return k;
    oi++;
  }
  return null;
}

export function applyUnifiedDiff(original: string, patchText: string): { ok: true; content: string } | { ok: false; error: string } {
  const crlf = /\r\n/.test(original);
  const normalized = original.replace(/\r\n?/g, '\n');
  const origLines = normalized === '' ? [] : normalized.split('\n');
  const parsed = parseHunks(patchText);
  if (!Array.isArray(parsed)) return { ok: false, error: parsed.error };

  const outLines: string[] = [];
  let oi = 0; // next original line to copy
  for (let hi = 0; hi < parsed.length; hi++) {
    const h = parsed[hi];
    const oldLen = h.lines.filter((l) => l.kind !== '+').length;
    // Locate the hunk: exact position first, then the nearest offset in either
    // direction (never before `oi` — hunks apply in order).
    let at = -1;
    const maxPos = Math.max(oi, origLines.length - oldLen);
    for (let d = 0; at < 0 && d <= origLines.length; d++) {
      const fwd = h.oldStart + d;
      const back = h.oldStart - d;
      if (fwd >= oi && fwd <= maxPos && hunkMismatchAt(origLines, h, fwd) === null) at = fwd;
      else if (d > 0 && back >= oi && back <= maxPos && hunkMismatchAt(origLines, h, back) === null) at = back;
    }
    if (at < 0) {
      const pos = Math.min(Math.max(h.oldStart, oi), origLines.length);
      const k = hunkMismatchAt(origLines, h, pos) ?? 0;
      const oldBefore = h.lines.slice(0, k).filter((l) => l.kind !== '+').length;
      const lineNo = pos + oldBefore + 1;
      const expected = h.lines[k]?.text ?? '';
      const actual = lineNo - 1 < origLines.length ? origLines[lineNo - 1] : '<end of file>';
      return {
        ok: false,
        error:
          `patch context mismatch in hunk ${hi + 1} at line ${lineNo}: patch expects ${JSON.stringify(expected)} ` +
          `but the skill has ${JSON.stringify(actual)} — the skill has changed since this patch was written`,
      };
    }
    while (oi < at) outLines.push(origLines[oi++]);
    for (const l of h.lines) {
      if (l.kind === ' ') outLines.push(origLines[oi++]);
      else if (l.kind === '-') oi++;
      else outLines.push(l.text);
    }
  }
  while (oi < origLines.length) outLines.push(origLines[oi++]);
  let content = outLines.join('\n');
  // Preserve the base file's trailing-newline convention: a patch can't
  // express "the file now ends without a newline" in this tolerant form.
  if (normalized.endsWith('\n') && !content.endsWith('\n')) content += '\n';
  if (crlf) content = content.replace(/\n/g, '\r\n');
  return { ok: true, content };
}

// ---- audit log (apply/reject/quarantine/propose — append-only) --------------

export interface AuditEntry {
  ts: string;
  id: string;
  name: string;
  action: 'propose' | 'apply' | 'reject' | 'quarantine';
  sessionId?: string;
  reason?: string;
}

function appendAudit(entry: Omit<AuditEntry, 'ts'>): void {
  ensureDir();
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

export function getAuditLog(limit = 200): AuditEntry[] {
  return readFileSafe(AUDIT_LOG)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as AuditEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEntry => !!e)
    .slice(-Math.max(1, limit))
    .reverse();
}

// ---- proposal metadata --------------------------------------------------------

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'quarantined';

export interface ProposalMeta {
  id: string;
  name: string;
  isNew: boolean;
  rationale: string;
  evidence: string;
  flags: ProposalFlag[];
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  sessionId?: string;
  reason?: string; // reject/quarantine reason
}

function proposalDir(id: string): string {
  return path.join(PROPOSALS_DIR, id);
}

function readMeta(id: string): ProposalMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(proposalDir(id), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function saveMeta(meta: ProposalMeta): void {
  fs.writeFileSync(path.join(proposalDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

function renderProposalMd(meta: ProposalMeta): string {
  const fm =
    `---\n` +
    `id: ${meta.id}\n` +
    `name: ${meta.name}\n` +
    `isNew: ${meta.isNew}\n` +
    `status: ${meta.status}\n` +
    `createdAt: ${meta.createdAt}\n` +
    (meta.sessionId ? `sessionId: ${meta.sessionId}\n` : '') +
    (meta.flags.length ? `flags: ${meta.flags.join(',')}\n` : '') +
    `---\n\n`;
  return (
    fm +
    `## Rationale\n\n${meta.rationale}\n\n` +
    `## Evidence\n\n${meta.evidence || '(none provided)'}\n`
  );
}

function proposalId(): string {
  return `skp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Effective content (user override wins over shipped). apply() always writes
// to the USER dir — a proposal against a shipped skill lands as an override copy.
function currentSkillContent(name: string): string {
  return readSkillContent(name);
}

// ---- propose (skill_propose MCP tool → POST /__api/skill-proposals) ---------

export interface ProposeArgs {
  name: string;
  content?: string;
  patch?: string;
  rationale: string;
  evidence?: string;
  sessionId?: string;
}

export interface ProposalSummary {
  id: string;
  name: string;
  isNew: boolean;
  rationale: string;
  evidence: string;
  flags: ProposalFlag[];
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  sessionId?: string;
  reason?: string;
}

function toSummary(meta: ProposalMeta): ProposalSummary {
  return { ...meta };
}

export function proposeSkill(args: ProposeArgs): { ok: true; proposal: ProposalSummary } | { error: string } {
  const name = String(args.name || '').trim();
  if (!NAME_RE.test(name)) return { error: `invalid skill name: ${name} (lowercase, digits, hyphens, must start with a letter/digit)` };
  const rationale = String(args.rationale || '').trim();
  if (!rationale) return { error: 'rationale is required' };

  const exists = isSkillDir(name);
  const baseContent = currentSkillContent(name);

  let finalContent: string;
  if (typeof args.content === 'string' && args.content.trim()) {
    finalContent = args.content;
  } else if (typeof args.patch === 'string' && args.patch.trim()) {
    const applied = applyUnifiedDiff(baseContent, args.patch);
    if (!applied.ok) return { error: `patch did not apply: ${applied.error} — pass full content instead` };
    finalContent = applied.content;
  } else {
    return { error: 'content or patch is required' };
  }

  if (!finalContent.trim()) return { error: 'resulting content is empty' };
  if (finalContent === baseContent) return { error: 'proposal is identical to the current skill — nothing to propose' };
  const fm = finalContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { error: 'proposed content is missing YAML frontmatter (--- … ---) at the top of the file' };

  ensureDir();
  const id = proposalId();
  const dir = proposalDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const flags = scanSkillContent(finalContent);
  const meta: ProposalMeta = {
    id,
    name,
    isNew: !exists,
    rationale,
    evidence: String(args.evidence || '').trim(),
    flags,
    status: 'pending',
    createdAt: new Date().toISOString(),
    sessionId: args.sessionId,
  };

  const diff = buildUnifiedDiff(baseContent, finalContent, `skills/${name}/SKILL.md`);
  fs.writeFileSync(path.join(dir, 'base.md'), baseContent);
  fs.writeFileSync(path.join(dir, 'content.md'), finalContent);
  fs.writeFileSync(path.join(dir, 'diff'), diff);
  fs.writeFileSync(path.join(dir, 'PROPOSAL.md'), renderProposalMd(meta));
  saveMeta(meta);
  appendAudit({ id, name, action: 'propose', sessionId: args.sessionId });

  return { ok: true, proposal: toSummary(meta) };
}

// ---- list / get ---------------------------------------------------------------

export function listProposals(): ProposalSummary[] {
  ensureDir();
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(PROPOSALS_DIR).filter((f) => f.startsWith('skp_'));
  } catch {
    /* not created yet */
  }
  return ids
    .map(readMeta)
    .filter((m): m is ProposalMeta => !!m)
    .map(toSummary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ProposalDetail extends ProposalSummary {
  content: string;
  diff: string; // recomputed against the CURRENT live skill content
  stale: boolean; // true if the skill changed since this proposal was filed
}

export function getProposal(id: string): ProposalDetail | { error: string } {
  const meta = readMeta(id);
  if (!meta) return { error: 'no such proposal' };
  const dir = proposalDir(id);
  const content = readFileSafe(path.join(dir, 'content.md'));
  const base = readFileSafe(path.join(dir, 'base.md'));
  const live = currentSkillContent(meta.name);
  const diff = buildUnifiedDiff(live, content, `skills/${meta.name}/SKILL.md`);
  return { ...toSummary(meta), content, diff, stale: live !== base };
}

// ---- decisions: apply / reject / quarantine ------------------------------------

export function applyProposal(id: string): { ok: true; skill: SkillSummary } | { error: string } {
  const meta = readMeta(id);
  if (!meta) return { error: 'no such proposal' };
  if (meta.status !== 'pending') return { error: `proposal already ${meta.status}` };
  const content = readFileSafe(path.join(proposalDir(id), 'content.md'));
  const r = writeSkill(meta.name, content, { allowCreate: true });
  if ('error' in r) return { error: r.error };
  import('./funnel.js').then((f) => f.firstTime('skill.first_applied')).catch(() => {});
  meta.status = 'applied';
  meta.decidedAt = new Date().toISOString();
  saveMeta(meta);
  appendAudit({ id, name: meta.name, action: 'apply' });
  return { ok: true, skill: r.skill };
}

export function rejectProposal(id: string, reason?: string): { ok: true } | { error: string } {
  const meta = readMeta(id);
  if (!meta) return { error: 'no such proposal' };
  if (meta.status !== 'pending') return { error: `proposal already ${meta.status}` };
  meta.status = 'rejected';
  meta.decidedAt = new Date().toISOString();
  if (reason) meta.reason = reason;
  saveMeta(meta);
  appendAudit({ id, name: meta.name, action: 'reject', reason });
  return { ok: true };
}

// Quarantine: like reject, but a distinct status — for a proposal flagged as
// actively suspicious (not just "not what we want right now"), so it's kept
// visible/labeled separately instead of blending into ordinary rejections.
export function quarantineProposal(id: string, reason?: string): { ok: true } | { error: string } {
  const meta = readMeta(id);
  if (!meta) return { error: 'no such proposal' };
  if (meta.status !== 'pending') return { error: `proposal already ${meta.status}` };
  meta.status = 'quarantined';
  meta.decidedAt = new Date().toISOString();
  if (reason) meta.reason = reason;
  saveMeta(meta);
  appendAudit({ id, name: meta.name, action: 'quarantine', reason });
  return { ok: true };
}
