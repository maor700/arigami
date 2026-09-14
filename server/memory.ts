// Arigami's own memory — owned by the host, not Claude Code's per-project
// auto-memory (that stays untouched; this is a separate store). Lives under
// $ARIGAMI_DIR/memory/ (T5: per-instance, not per-cwd/worktree) so every
// session AND every worker in a dispatch tree shares one store regardless of
// which worktree it's running in.
//
// Two layers (spec M1, same shape as Hermes/OpenClaw):
//   1. A capped, always-loaded snapshot: USER.md + MEMORY.md (getMemoryBootstrap,
//      injected once into a session's first turn by claude.js — never mid-session,
//      to keep the prompt-cache prefix stable).
//   2. Unbounded on-demand search (FTS5 via bun:sqlite) over those files plus
//      journal/*.md and episodes/*.md — zero token cost until actually queried.
//
// Gate (spec "close-first"): every write to USER.md/MEMORY.md/journal is
// sanitized (credential/prompt-injection/exfiltration heuristics), deduped
// against existing lines, capped in size, and logged append-only with a full
// before/after snapshot (memory/.log.jsonl) so any change is undoable.
// Direct memory_write calls from a live agent land immediately (still logged);
// autonomous background extraction (runEpisodeHook) only ever proposes
// `pending` facts — nothing it produces reaches MEMORY.md/USER.md without a
// human approving it via /__api/memory/pending/:id/approve.
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { ARIGAMI_DIR } from './lib/instance.js';
import { runOneShot, hostEngine } from './lib/oneshot.js';
import { detectSensitive } from './lib/memory-triage.js';

export const MEMORY_DIR = path.join(ARIGAMI_DIR, 'memory');
export const USER_MD = path.join(MEMORY_DIR, 'USER.md');
export const MEMORY_MD = path.join(MEMORY_DIR, 'MEMORY.md');
export const JOURNAL_DIR = path.join(MEMORY_DIR, 'journal');
export const EPISODES_DIR = path.join(MEMORY_DIR, 'episodes');
export const LOG_FILE = path.join(MEMORY_DIR, '.log.jsonl');
export const PENDING_FILE = path.join(MEMORY_DIR, 'pending.json');
export const DB_FILE = path.join(MEMORY_DIR, 'memory.sqlite');

// ---- agent namespaces (A1, PRD-ARIGAMI-AGENTS §2) -----------------------------
// An agent's memory lives OUTSIDE MEMORY_DIR, at $ARIGAMI_DIR/agents/<slug>/memory/
// (MEMORY.md + journal/), so export/import of an agent carries it along. In the
// index and in every API it is addressed by the virtual relative path
// `agents/<slug>/MEMORY.md` / `agents/<slug>/journal/<day>.md` with FTS scope
// `agent:<slug>`. USER.md (facts about the human) and episodes stay shared;
// a session born from an agent sees USER.md + its own namespace and, unless it
// asks explicitly, nothing of the shared MEMORY.md/journal — and vice versa.
export const AGENTS_ROOT = path.join(ARIGAMI_DIR, 'agents');
export const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const agentScope = (slug: string): string => `agent:${slug}`;
const AGENT_REL_RE = /^agents\/([a-z0-9][a-z0-9-]{0,39})\/(.+)$/;

/** Virtual relative path → absolute file path (agent paths map into the agent dir). */
function resolveRel(rel: string): string {
  const m = AGENT_REL_RE.exec(rel);
  if (m) return path.join(AGENTS_ROOT, m[1], 'memory', m[2]);
  return path.join(MEMORY_DIR, rel);
}

function normalizeAgent(agent?: string | null): string | null {
  const a = String(agent || '').trim();
  if (!a) return null;
  if (!AGENT_SLUG_RE.test(a)) throw new Error(`invalid agent slug: ${a}`);
  return a;
}

// ~4 chars/token, same rough heuristic used elsewhere for budget guards.
export function estimateTokens(s: string): number {
  return Math.ceil((s || '').length / 4);
}

export type CappedTarget = 'user' | 'memory';
export const CAPS: Record<CappedTarget, number> = { user: 600, memory: 900 };

function ensureDirs(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.mkdirSync(EPISODES_DIR, { recursive: true });
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ---- bootstrap injection (claude.js: once, at a fresh session's first turn) ---

export function getMemoryBootstrap(agent?: string | null): { userMd: string; memoryMd: string; agentMd?: string; agent?: string } {
  const slug = normalizeAgent(agent);
  if (slug) {
    // A session born from an agent boots with USER.md + the AGENT's MEMORY.md —
    // not the shared MEMORY.md (namespace isolation; memory_search reaches it on demand).
    return { userMd: readFileSafe(USER_MD), memoryMd: '', agentMd: readFileSafe(resolveRel(`agents/${slug}/MEMORY.md`)), agent: slug };
  }
  return { userMd: readFileSafe(USER_MD), memoryMd: readFileSafe(MEMORY_MD) };
}

// ---- sanitization -----------------------------------------------------------

export interface SanitizeResult {
  ok: boolean;
  reason?: string;
}

// Credential-shaped strings — refuse rather than guess whether they're real.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /sk-[A-Za-z0-9_-]{20,}/, // OpenAI/Anthropic-shaped secret key
  /xox[baprs]-[0-9A-Za-z-]{10,}/, // Slack token
  /gh[pousr]_[A-Za-z0-9]{30,}/, // GitHub PAT-shaped
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,}/i,
];

// Content trying to redirect the model reading it later (memory is re-injected
// into future sessions, so this is a real prompt-injection surface).
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /\bnew\s+system\s+prompt\b/i,
  /\boverride\s+your\s+instructions\b/i,
];

// Patterns that try to smuggle data out via a later render/fetch.
const EXFIL_PATTERNS: RegExp[] = [
  /!\[[^\]]*\]\(https?:\/\/[^)]+\)/, // markdown image → external fetch
  /\bcurl\s+[^\n]*\|\s*(ba)?sh\b/i,
];

export function sanitize(content: string): SanitizeResult {
  if (!content || !content.trim()) return { ok: false, reason: 'empty content' };
  for (const re of SECRET_PATTERNS) if (re.test(content)) return { ok: false, reason: 'looks like it contains a credential/secret' };
  for (const re of INJECTION_PATTERNS) if (re.test(content)) return { ok: false, reason: 'looks like a prompt-injection attempt' };
  for (const re of EXFIL_PATTERNS) if (re.test(content)) return { ok: false, reason: 'looks like an exfiltration attempt' };
  // LEARN1: identity-document and payment-card numbers are refused on EVERY
  // path (a live agent included) — there is no legitimate reason to keep them
  // in a file that is re-injected into every future session.
  const sens = detectSensitive(content);
  if (sens && sens.kind !== 'address') return { ok: false, reason: `sensitive personal data (${sens.reason})` };
  return { ok: true };
}

// LEARN1: the stricter check for AUTONOMOUS paths (proposeFacts, the learning
// run): everything sanitize() refuses PLUS home addresses. A human may still
// store an address deliberately via memory_write / the Brain UI.
export function sanitizeForAutoStore(content: string): SanitizeResult {
  const base = sanitize(content);
  if (!base.ok) return base;
  const sens = detectSensitive(content);
  if (sens) return { ok: false, reason: `sensitive personal data (${sens.reason}) — never stored automatically` };
  return { ok: true };
}

// ---- dedup --------------------------------------------------------------------

// LEARN1: the bullet strip requires the space ("- foo"), otherwise a line that
// starts with **bold** lost its first `*` and could never be matched for
// replace/remove/undo.
function normalizeLine(s: string): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ');
}

export function isDuplicate(existingContent: string, newLine: string): boolean {
  const norm = normalizeLine(newLine);
  if (!norm) return false;
  return existingContent.split('\n').some((l) => normalizeLine(l) === norm);
}

// ---- append-only change log (undo source of truth) ---------------------------

export interface LogEntry {
  seq: number;
  ts: string;
  target: string; // 'user' | 'memory' | 'journal' | 'episode'
  action: string; // 'add' | 'replace' | 'remove' | 'undo'
  path: string; // relative to MEMORY_DIR
  before: string;
  after: string;
  source: string;
  sessionId?: string;
}

let logSeq = 0;
let logSeqLoaded = false;

function nextLogSeq(): number {
  if (!logSeqLoaded) {
    const lines = readFileSafe(LOG_FILE).split('\n').filter(Boolean);
    logSeq = lines.length;
    logSeqLoaded = true;
  }
  return ++logSeq;
}

function appendLog(entry: Omit<LogEntry, 'seq' | 'ts'>): LogEntry {
  ensureDirs();
  const full: LogEntry = { seq: nextLogSeq(), ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(LOG_FILE, JSON.stringify(full) + '\n');
  return full;
}

export function getLog(limit = 100): LogEntry[] {
  const lines = readFileSafe(LOG_FILE)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LogEntry => !!e);
  return lines.slice(-Math.max(1, limit)).reverse();
}

export function undoLog(seq: number): WriteResult {
  const entry = getLog(1e9).find((e) => e.seq === seq);
  if (!entry) return { ok: false, error: 'no such log entry' };
  ensureDirs();
  const full = resolveRel(entry.path);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, entry.before);
  reindexPath(scopeForRel(entry.path, entry.target), entry.path, entry.before);
  const logged = appendLog({
    target: entry.target,
    action: 'undo',
    path: entry.path,
    before: entry.after,
    after: entry.before,
    source: `undo:${seq}`,
  });
  return { ok: true, logSeq: logged.seq };
}

// ---- FTS5 index (bun:sqlite) ---------------------------------------------------

let _db: Database | null = null;

// M1b fix: unicode61 (the FTS5 default) tokenizes on word boundaries, so it
// only ever matches whole tokens. Hebrew attaches single-letter prefixes
// (he/vav/bet/lamed/mem/shin/kaf — "the/and/in/to/from/that/as") directly onto
// the next word with no boundary ("ha-sodi", the-secret, is ONE token) — a
// query for the bare word "sodi" can never match "ha-sodi" that way, and neither
// would naive prefix (`term*`) search, since the extra letter is prepended, not
// appended. `trigram` indexes every 3-character substring instead of whole
// tokens, so the bare word matches inside its prefixed forms (the-, and-, in-,
// …) the same way it would for any other substring —
// no hand-maintained list of Hebrew prefix letters needed, and it degrades
// gracefully for English/mixed content too. Trade-off: queries under 3 chars
// can't match anything (inherent to trigram, not worth working around here).
function db(): Database {
  if (_db) return _db;
  ensureDirs();
  const conn = new Database(DB_FILE, { create: true });
  const existing = conn
    .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'`)
    .get() as { sql: string } | undefined;
  // A DB created before this fix has memory_fts on the unicode61 default —
  // migrate it in place (once, on first use after upgrade) instead of leaving
  // old installs permanently stuck with the Hebrew-prefix bug.
  const stale = !!existing && !/tokenize\s*=\s*['"]trigram['"]/i.test(existing.sql);
  if (stale) conn.run(`DROP TABLE memory_fts`);
  conn.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(scope, path, updated_at UNINDEXED, content, tokenize='trigram')`
  );
  _db = conn; // set before rebuildIndexFromDisk() — it calls back into db()
  if (stale) rebuildIndexFromDisk();
  return _db;
}

// Full re-scan of every memory file on disk into a freshly (re)created index —
// used only when migrating an old unicode61 table to trigram (see db() above).
function rebuildIndexFromDisk(): void {
  const flat: Array<[string, string, 'user' | 'memory']> = [
    ['USER.md', USER_MD, 'user'],
    ['MEMORY.md', MEMORY_MD, 'memory'],
  ];
  for (const [rel, full, scope] of flat) {
    const content = readFileSafe(full);
    if (content.trim()) reindexPath(scope, rel, content);
  }
  for (const [dir, scope] of [
    [JOURNAL_DIR, 'journal'],
    [EPISODES_DIR, 'episode'],
  ] as const) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch { /* not created yet */ }
    for (const f of names) {
      const full = path.join(dir, f);
      const content = readFileSafe(full);
      if (content.trim()) reindexPath(scope, path.relative(MEMORY_DIR, full), content);
    }
  }
  // Agent namespaces (agents/<slug>/memory/{MEMORY.md,journal/*.md}).
  for (const slug of agentSlugsOnDisk()) {
    for (const rel of agentRelPaths(slug)) {
      const content = readFileSafe(resolveRel(rel));
      if (content.trim()) reindexPath(agentScope(slug), rel, content);
    }
  }
  // stderr, not stdout: some callers (tests, `claude -p` headless runs) treat
  // stdout as a single structured payload — this is a side-channel notice.
  console.error('[memory] FTS5 index rebuilt with the trigram tokenizer (Hebrew-prefix search fix)');
}

function agentSlugsOnDisk(): string[] {
  try {
    return fs.readdirSync(AGENTS_ROOT).filter((d) => AGENT_SLUG_RE.test(d));
  } catch {
    return [];
  }
}

/** Every memory file of one agent as virtual relative paths (MEMORY.md first, then journal days). */
function agentRelPaths(slug: string): string[] {
  const out = [`agents/${slug}/MEMORY.md`];
  try {
    for (const f of fs.readdirSync(path.join(AGENTS_ROOT, slug, 'memory', 'journal')).filter((f) => f.endsWith('.md')).sort())
      out.push(`agents/${slug}/journal/${f}`);
  } catch { /* no journal yet */ }
  return out;
}

/** The FTS scope a virtual path indexes under ('agent:<slug>' for agent paths). */
function scopeForRel(rel: string, fallback: string): string {
  const m = AGENT_REL_RE.exec(rel);
  return m ? agentScope(m[1]) : fallback === 'journal' ? 'journal' : fallback;
}

// One row per file (v1: the whole store is a handful of small KB — file-level
// granularity is plenty for FTS5 snippet quality at this scale).
function reindexPath(scope: string, relPath: string, content: string): void {
  try {
    const d = db();
    d.run(`DELETE FROM memory_fts WHERE path = ?`, [relPath]);
    if (content && content.trim()) {
      d.run(`INSERT INTO memory_fts (scope, path, updated_at, content) VALUES (?, ?, ?, ?)`, [
        scope,
        relPath,
        new Date().toISOString(),
        content,
      ]);
    }
  } catch (e) {
    console.error('[memory] reindex failed:', (e as Error).message);
  }
}

function ftsQuery(q: string): string {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  // Quote every token so user input can never inject FTS5 query syntax
  // (NEAR/AND/OR/column filters/etc.) — bareword-quoted tokens are ANDed
  // by default, which is the precision we want for a recall tool.
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
}

export interface SearchHit {
  path: string;
  scope: string;
  snippet: string;
  updatedAt: string;
}

export function searchMemory(opts: { query: string; scope?: string; limit?: number; agent?: string | null }): SearchHit[] {
  const query = (opts.query || '').trim();
  if (!query) return [];
  const match = ftsQuery(query);
  if (!match) return [];
  const limit = Math.max(1, Math.min(50, opts.limit || 8));
  const slug = normalizeAgent(opts.agent);
  // Overfetch on bm25 rank, then re-rank in JS so a hit containing the whole
  // query as one contiguous (case-insensitive) run — the closest thing to an
  // "exact match" once every term is a substring match — sorts before hits
  // that only satisfy each term separately, scattered across the content.
  const overfetch = Math.min(50, limit * 4);
  let sql = `SELECT scope, path, updated_at, content, snippet(memory_fts, 3, '[', ']', '…', 12) AS snip FROM memory_fts WHERE memory_fts MATCH ?`;
  const params: (string | number)[] = [match];
  if (opts.scope) {
    // An explicit scope wins ('agent:<slug>' reaches any namespace on purpose —
    // the human's Brain UI / an explicit cross-agent lookup).
    sql += ` AND scope = ?`;
    params.push(opts.scope);
  } else if (slug) {
    // An agent's default view: the human (USER.md) + its own namespace + episodes.
    sql += ` AND scope IN ('user', 'episode', ?)`;
    params.push(agentScope(slug));
  } else {
    // The shared default view never leaks agent namespaces.
    sql += ` AND scope NOT LIKE 'agent:%'`;
  }
  sql += ` ORDER BY rank LIMIT ?`;
  params.push(overfetch);
  try {
    const rows = db().query(sql).all(...params) as any[];
    const needle = query.toLowerCase();
    const ranked = rows
      .map((r, i) => ({ r, i, exact: String(r.content || '').toLowerCase().includes(needle) ? 0 : 1 }))
      .sort((a, b) => a.exact - b.exact || a.i - b.i); // exact contiguous match first; bm25 order preserved within each group
    return ranked.slice(0, limit).map(({ r }) => ({
      path: r.path,
      scope: r.scope,
      snippet: String(r.snip || '').slice(0, 700),
      updatedAt: r.updated_at,
    }));
  } catch (e) {
    console.error('[memory] search failed:', (e as Error).message);
    return [];
  }
}

// ---- memory_get ---------------------------------------------------------------

export function getMemoryFile(relPath: string): { path: string; content: string } | { error: string } {
  ensureDirs();
  const clean = String(relPath || '').replace(/^\/+/, '');
  const agentRel = AGENT_REL_RE.exec(clean);
  const root = agentRel ? path.join(AGENTS_ROOT, agentRel[1], 'memory') : MEMORY_DIR;
  const full = path.resolve(resolveRel(clean));
  if (full !== root && !full.startsWith(root + path.sep)) return { error: 'invalid path' };
  try {
    if (!fs.statSync(full).isFile()) return { error: 'no such file' };
  } catch {
    // The root docs are created lazily on first write; on a fresh instance /
    // agent the UI asks for them before they exist → an empty doc (200), not a 404.
    if (clean === 'USER.md' || clean === 'MEMORY.md' || (agentRel && agentRel[2] === 'MEMORY.md')) return { path: clean, content: '' };
    return { error: 'no such file' };
  }
  return { path: clean, content: fs.readFileSync(full, 'utf8') };
}

// ---- memory_write ---------------------------------------------------------------

export type WriteTarget = 'user' | 'memory' | 'journal';
export type WriteAction = 'add' | 'replace' | 'remove';

export interface WriteMemoryArgs {
  target: WriteTarget;
  action: WriteAction;
  content?: string;
  old_text?: string;
  source?: string;
  sessionId?: string;
  /** A1: write into this agent's namespace ('memory'/'journal' only; 'user' is always the shared USER.md). */
  agent?: string | null;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  deduped?: boolean;
  logSeq?: number;
}

function journalRelPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join('journal', `${day}.md`);
}

export function writeMemory(args: WriteMemoryArgs): WriteResult {
  ensureDirs();
  const target = args.target;
  const action = args.action;
  const source = args.source || 'agent';
  if (!['user', 'memory', 'journal'].includes(target)) return { ok: false, error: `unknown target: ${target}` };
  if (!['add', 'replace', 'remove'].includes(action)) return { ok: false, error: `unknown action: ${action}` };
  if (target === 'journal' && action !== 'add')
    return { ok: false, error: 'journal is append-only — only action:"add" is supported' };

  let slug: string | null = null;
  try {
    slug = normalizeAgent(args.agent);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  // USER.md is about the human — one file, shared by every agent.
  const ns = slug && target !== 'user' ? `agents/${slug}/` : '';
  const relPath = target === 'user' ? 'USER.md' : target === 'memory' ? `${ns}MEMORY.md` : ns + journalRelPath();
  const filePath = resolveRel(relPath);
  const before = readFileSafe(filePath);
  const content = (args.content || '').trim();

  if ((action === 'add' || action === 'replace') && !content) return { ok: false, error: 'content required' };
  if (content) {
    const check = sanitize(content);
    if (!check.ok) return { ok: false, error: `refused: ${check.reason}` };
  }

  let after: string;

  if (target === 'journal') {
    const stamp = new Date().toISOString().slice(11, 16);
    const line = `- [${stamp}] ${content}${args.sessionId ? ` (session ${args.sessionId})` : ''}`;
    const day = new Date().toISOString().slice(0, 10);
    after = before ? `${before.replace(/\n+$/, '')}\n${line}\n` : `# ${day}\n\n${line}\n`;
  } else if (action === 'add') {
    if (isDuplicate(before, content)) return { ok: true, deduped: true };
    const bullet = `- ${content}`;
    const candidate = before ? `${before.replace(/\n+$/, '')}\n${bullet}\n` : `${bullet}\n`;
    const cap = CAPS[target as CappedTarget];
    if (estimateTokens(candidate) > cap)
      return { ok: false, error: `would exceed ${target}.md cap (~${cap} tokens) — trim or replace an existing line first` };
    after = candidate;
  } else if (action === 'replace') {
    if (!args.old_text) return { ok: false, error: 'old_text required for replace' };
    const lines = before.split('\n');
    const idx = lines.findIndex((l) => normalizeLine(l) === normalizeLine(args.old_text!));
    if (idx === -1) return { ok: false, error: 'old_text not found' };
    lines[idx] = `- ${content}`;
    after = lines.join('\n');
    const cap = CAPS[target as CappedTarget];
    if (estimateTokens(after) > cap) return { ok: false, error: `would exceed ${target}.md cap (~${cap} tokens)` };
  } else {
    // remove
    const needle = args.old_text || content;
    if (!needle) return { ok: false, error: 'old_text (or content) required for remove' };
    const lines = before.split('\n');
    const idx = lines.findIndex((l) => normalizeLine(l) === normalizeLine(needle));
    if (idx === -1) return { ok: false, error: 'line not found' };
    lines.splice(idx, 1);
    after = lines.join('\n');
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, after);
  const entry = appendLog({ target, action, path: relPath, before, after, source, sessionId: args.sessionId });
  reindexPath(scopeForRel(relPath, target), relPath, after);
  return { ok: true, logSeq: entry.seq };
}

// ---- episodes -------------------------------------------------------------------

export function appendEpisode(sessionId: string, opts: { body: string; title?: string; trigger: string }): string {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const relPath = path.join('episodes', `${sessionId}-${stamp}.md`);
  const full = path.join(MEMORY_DIR, relPath);
  const header = `---\nsession: ${sessionId}\ntrigger: ${opts.trigger}\ndate: ${new Date().toISOString()}\n---\n\n`;
  const content = header + (opts.title ? `# ${opts.title}\n\n` : '') + opts.body.trim() + '\n';
  fs.writeFileSync(full, content);
  reindexPath('episode', relPath, content);
  appendLog({ target: 'episode', action: 'add', path: relPath, before: '', after: content, source: opts.trigger, sessionId });
  return relPath;
}

// ---- pending facts (autonomous proposals — never written directly) -------------

export interface PendingFact {
  id: string;
  content: string;
  target: CappedTarget;
  source: string;
  sessionId?: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  /** LEARN1: who decided (e.g. 'learning:<runId>', 'ui') and why — for the run log / audit. */
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

function readPending(): PendingFact[] {
  try {
    const parsed = JSON.parse(readFileSafe(PENDING_FILE) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingFact[]): void {
  ensureDirs();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
}

export function listPending(): PendingFact[] {
  return readPending().filter((p) => p.status === 'pending');
}

function pendingId(): string {
  return `pf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Autonomous extraction (episode hook, migration script) calls this — capped
// at 3 per call (spec M1.4), sanitized, deduped against the live file AND
// against already-pending facts. Nothing here ever touches USER.md/MEMORY.md;
// that only happens via approvePending.
export function proposeFacts(facts: string[], opts: { source: string; sessionId?: string; target?: CappedTarget }): PendingFact[] {
  ensureDirs();
  const target: CappedTarget = opts.target || 'memory';
  const list = readPending();
  const liveContent = readFileSafe(target === 'user' ? USER_MD : MEMORY_MD);
  const created: PendingFact[] = [];
  for (const raw of facts) {
    if (created.length >= 3) break; // cap on ACCEPTED proposals, not on candidates considered
    const content = String(raw || '').trim();
    if (!content) continue;
    if (!sanitizeForAutoStore(content).ok) continue; // drop suspicious/sensitive auto-proposed content silently
    if (isDuplicate(liveContent, content)) continue;
    if (list.some((p) => p.status === 'pending' && normalizeLine(p.content) === normalizeLine(content))) continue;
    const fact: PendingFact = {
      id: pendingId(),
      content,
      target,
      source: opts.source,
      sessionId: opts.sessionId,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    list.push(fact);
    created.push(fact);
  }
  if (created.length) writePending(list);
  return created;
}

export interface ApproveOptions {
  /** LEARN1: write THIS phrasing instead of the stored one (the triage picked the best variant). Still gated by writeMemory. */
  content?: string;
  /** LEARN1: the triage may re-target (a fact about the human → USER.md even if proposed for memory). */
  target?: CappedTarget;
  source?: string;
}

export function approvePending(id: string, opts: ApproveOptions = {}): WriteResult {
  const list = readPending();
  const idx = list.findIndex((p) => p.id === id && p.status === 'pending');
  if (idx === -1) return { ok: false, error: 'no such pending fact' };
  const fact = list[idx];
  const target: CappedTarget = opts.target === 'user' || opts.target === 'memory' ? opts.target : fact.target;
  const res = writeMemory({
    target,
    action: 'add',
    content: (opts.content || fact.content).trim(),
    source: opts.source || `pending-approve:${fact.source}`,
    sessionId: fact.sessionId,
  });
  if (res.ok) {
    list[idx] = { ...fact, target, status: 'approved', decidedBy: opts.source, decidedAt: new Date().toISOString() };
    writePending(list);
  }
  return res;
}

// LEARN1: approve a pending fact by MERGING it into an existing line of its
// target file (replace, keeping the more precise wording) — same writeMemory
// gate (sanitize + cap) as an add, just action:'replace'.
export function mergePending(id: string, opts: { oldText: string; content: string; target?: CappedTarget; source?: string }): WriteResult {
  const list = readPending();
  const idx = list.findIndex((p) => p.id === id && p.status === 'pending');
  if (idx === -1) return { ok: false, error: 'no such pending fact' };
  const fact = list[idx];
  const target: CappedTarget = opts.target === 'user' || opts.target === 'memory' ? opts.target : fact.target;
  const res = writeMemory({
    target,
    action: 'replace',
    old_text: opts.oldText,
    content: opts.content.trim(),
    source: opts.source || `pending-merge:${fact.source}`,
    sessionId: fact.sessionId,
  });
  if (res.ok) {
    list[idx] = { ...fact, target, status: 'approved', decidedBy: opts.source, decidedAt: new Date().toISOString(), reason: `merged into: ${opts.oldText}` };
    writePending(list);
  }
  return res;
}

export function rejectPending(id: string, opts: { source?: string; reason?: string } = {}): { ok: boolean } {
  const list = readPending();
  const idx = list.findIndex((p) => p.id === id && p.status === 'pending');
  if (idx === -1) return { ok: false };
  list[idx] = { ...list[idx], status: 'rejected', decidedBy: opts.source, decidedAt: new Date().toISOString(), reason: opts.reason };
  writePending(list);
  return { ok: true };
}

/** LEARN1: bulk status change (a whole cluster of restatements rejected as members of an entered fact). */
export function setPendingStatus(ids: string[], status: PendingFact['status'], opts: { source?: string; reason?: string } = {}): number {
  const list = readPending();
  const set = new Set(ids);
  let n = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < list.length; i++) {
    if (!set.has(list[i].id) || list[i].status === status) continue;
    list[i] = { ...list[i], status, decidedBy: opts.source, decidedAt: now, reason: opts.reason };
    n++;
  }
  if (n) writePending(list);
  return n;
}

// ---- autonomous episode + pending-fact extraction ------------------------------
// Uses the shared one-shot runner (lib/oneshot.ts — same one skills.ts's
// analyze() uses) for the actual `claude -p` call, incl. its auth. Runs off
// the report_to_master and session-archive hooks (server/api.ts) with a
// transcript excerpt the caller builds (kept out of this module to avoid a
// claude.js <-> memory.ts import cycle).

const EPISODE_TIMEOUT_MS = 3 * 60 * 1000;
const EPISODE_COOLDOWN_MS = 2 * 60 * 1000; // report_to_master immediately followed by archive shouldn't double-run

const lastEpisodeAt = new Map<string, number>();

function extractJson(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(a, b + 1));
}

export async function runEpisodeHook(sessionId: string, trigger: string, transcript: string): Promise<void> {
  if (!transcript || !transcript.trim()) return;
  const now = Date.now();
  const last = lastEpisodeAt.get(sessionId) || 0;
  if (now - last < EPISODE_COOLDOWN_MS) return;
  lastEpisodeAt.set(sessionId, now);

  const prompt =
    `You are summarizing one Arigami host session for the host's long-term memory store. Below is a ` +
    `transcript excerpt (may be truncated/incomplete). Output ONLY a JSON object (no prose, no markdown ` +
    `fences) of exactly this shape:\n` +
    `{"episode": "<3-6 sentence factual summary of what happened in this session, plain text>", ` +
    `"facts": ["<durable fact/decision/preference worth recalling in FUTURE unrelated sessions, <=25 words>", ...]}\n\n` +
    `"facts" is capped at 3 items and usually SHOULD be empty — only include user preferences, standing ` +
    `decisions, or important people/systems that matter beyond this one session. Never include secrets, ` +
    `credentials, or tokens. Omit anything session-specific/ephemeral.\n\n` +
    `--- transcript ---\n${transcript}\n--- end transcript ---`;

  const text = await runOneShot(prompt, { engine: hostEngine(), cwd: ARIGAMI_DIR, timeoutMs: EPISODE_TIMEOUT_MS, tag: 'memory-episode-hook' });
  const parsed = extractJson(text);
  if (parsed.episode && typeof parsed.episode === 'string') appendEpisode(sessionId, { body: parsed.episode, trigger });
  if (Array.isArray(parsed.facts) && parsed.facts.length)
    proposeFacts(parsed.facts.map(String), { source: `episode-hook:${trigger}`, sessionId });
}

// ---- listing (for the memory API / future UI) ----------------------------------

export interface MemoryFileSummary {
  path: string;
  scope: string;
  tokens: number;
  updatedAt: string | null;
}

export function listMemory(agent?: string | null): MemoryFileSummary[] {
  ensureDirs();
  const out: MemoryFileSummary[] = [];
  const stat = (p: string) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  };
  const slug = normalizeAgent(agent);
  if (slug) {
    // One agent's namespace only (the Agent page → Memory tab).
    for (const rel of agentRelPaths(slug)) {
      const full = resolveRel(rel);
      const content = readFileSafe(full);
      const st = stat(full);
      out.push({ path: rel, scope: agentScope(slug), tokens: estimateTokens(content), updatedAt: st ? st.mtime.toISOString() : null });
    }
    return out;
  }
  for (const [rel, full, scope] of [
    ['USER.md', USER_MD, 'user'],
    ['MEMORY.md', MEMORY_MD, 'memory'],
  ] as const) {
    const content = readFileSafe(full);
    const st = stat(full);
    out.push({ path: rel, scope, tokens: estimateTokens(content), updatedAt: st ? st.mtime.toISOString() : null });
  }
  for (const dir of [JOURNAL_DIR, EPISODES_DIR]) {
    const scope = dir === JOURNAL_DIR ? 'journal' : 'episode';
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch { /* not created yet */ }
    for (const f of files) {
      const full = path.join(dir, f);
      const content = readFileSafe(full);
      const st = stat(full);
      out.push({
        path: path.relative(MEMORY_DIR, full),
        scope,
        tokens: estimateTokens(content),
        updatedAt: st ? st.mtime.toISOString() : null,
      });
    }
  }
  return out;
}
