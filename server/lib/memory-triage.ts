// LEARN1 — the PURE half of autonomous memory learning: everything that can be
// decided without touching disk or a model. server/memory-learning.ts wraps
// this with the pending queue, the LLM one-shot, the run log and the scheduler.
//
// The deterministic pre-pass does exactly what the human did by hand on the
// first 187 proposals: (1) refuse anything sensitive (ID numbers, payment cards,
// home addresses — on top of memory.ts's credential/injection sanitizer),
// (2) drop what USER.md/MEMORY.md already say, (3) drop repo documentation
// (source paths, branch names, task ids, dev conventions — that belongs in the
// repo, not in the human's memory), (4) cluster the near-duplicate restatements
// so the model sees ONE row per fact, not forty. The model only ever chooses
// ENTER / MERGE / DROP per cluster with a one-line reason; planWithCap() then
// makes sure the result fits the token caps, preferring MERGE over ENTER.

export type Target = 'user' | 'memory';
export type Action = 'ENTER' | 'MERGE' | 'DROP' | 'DEFER';
export type ReasonKey =
  | 'sensitive'
  | 'unsafe'
  | 'already-known'
  | 'repo-doc'
  | 'cap'
  | 'no-decision'
  | 'merge-target-missing'
  | 'merge-lossy'
  | 'cluster-member'
  | 'empty';

export interface TriageItem {
  id: string;
  content: string;
  target: Target;
  source?: string;
  sessionId?: string;
  createdAt?: string;
}

export interface Cluster {
  key: string;
  ids: string[];
  items: TriageItem[];
  representative: string;
  count: number;
  sessions: number;
  target: Target;
  /** Nearest existing line (normalized similarity ≥ MERGE_HINT) — a MERGE candidate for the model. */
  related?: { target: Target; line: string; score: number };
}

export interface Dropped {
  key: string;
  ids: string[];
  content: string;
  count: number;
  reasonKey: ReasonKey;
  detail?: string;
  target: Target;
}

export interface PrepassResult {
  clusters: Cluster[];
  dropped: Dropped[];
}

// ---- sensitive data (never auto-stored) ----------------------------------------

/** Israeli ID (ת"ז) check digit — Luhn variant over exactly 9 digits. */
export function isValidIsraeliId(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(digits[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const ID_KEYWORD = /(?:ת\.?\s?ז\.?|תעודת\s+זהות|מספר\s+זהות|\bID\s*(?:number|no\.?|#)|national\s+id|\bpassport\b|דרכון|\bSSN\b|social\s+security)\s*[:#]?\s*\d[\d\s-]{6,}/i;
// A bare 9-digit run that is NOT part of a longer number / JID / email / URL.
const NINE_DIGITS = /(?<![\d@.\-+/\w])(\d{9})(?![\d@.\w])/g;
// 13–19 digits, optionally grouped by spaces/dashes, not a JID/phone (+…)/URL.
const CARD_RUN = /(?<![\d@+\w])(?:\d[ -]?){13,19}(?![\d@\w])/g;
// Home address shapes — Hebrew street words + house number, "lives at <street> <n>", English street suffixes.
const ADDRESS_PATTERNS: RegExp[] = [
  // NB: JS `\b` is ASCII-only — Hebrew words need (?:^|\s) instead.
  /(?:^|\s)(?:רחוב|רח['׳]|שד['׳]|שדרות|סמטת|כתובת(?:ו|ה|י|ם)?)\s*[:\-]?\s*[^\d\n,.;]{2,40}?\s\d{1,4}(?!\d)/,
  /(?:^|\s)גר(?:ה|ים|ות)?\s+ב[^\d\n,.;]{2,40}?\s\d{1,4}(?!\d)/,
  /\b(?:address\s*[:\-]?|lives?\s+(?:at|on)|living\s+(?:at|on)|resides?\s+(?:at|on))\s+[A-Z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*){0,3}\s+\d{1,5}\b/,
  /\b(?:address|lives?\s+(?:at|in|on)|home)\s*[:\-]?\s*\d{1,5}\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}\s+(?:St(?:reet)?|Ave(?:nue)?|R(?:oa)?d|Blvd|Boulevard|Lane|Ln|Drive|Dr|Way|Court|Ct)\b\.?/i,
  /\b\d{1,5}\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}\s+(?:Street|Avenue|Boulevard|Road|Lane|Drive)\b/,
];

export interface SensitiveHit {
  kind: 'id-number' | 'payment-card' | 'address';
  reason: string;
}

/**
 * Personal data that must never be stored by an autonomous path. Phone
 * numbers, emails and WhatsApp JIDs are deliberately NOT here — they are the
 * bread and butter of a useful memory ("the club's WhatsApp is 050-…").
 */
export function detectSensitive(content: string): SensitiveHit | null {
  const s = String(content || '');
  if (ID_KEYWORD.test(s)) return { kind: 'id-number', reason: 'identity document number' };
  for (const m of s.matchAll(NINE_DIGITS)) if (isValidIsraeliId(m[1])) return { kind: 'id-number', reason: 'looks like an Israeli ID number' };
  for (const m of s.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return { kind: 'payment-card', reason: 'looks like a payment card number' };
  }
  for (const re of ADDRESS_PATTERNS) if (re.test(s)) return { kind: 'address', reason: 'looks like a home address' };
  return null;
}

// ---- repo documentation (belongs in the repo, not in memory) ---------------------

const CODE_PATH = /(?:^|[\s"'`(])(?:\.{0,2}\/)?(?:server|web\/src|web|test|tests|docs|bin|scripts|lib|src)\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|sh|css|md)\b/;
const CODE_FILE = /\b[\w-]+\.(?:ts|tsx|jsx|mjs|cjs|py)\b/;
const REPO_ROOT = /\/opt\/arigami\b|arigami-wt-|\/repos\/arigami\b|\bworktrees?\b/i;
const BRANCH = /\b(?:feat|fix|child|chore|refactor|hotfix|release)\/[\w.-]+/;
const TASK_ID = /(?:^|[\s(\[])(?:[A-Z]{1,8}\d{1,3}(?:-[a-z]+)?|[A-Z]{2,8}-\d{1,3})(?=$|[\s)\]:,.·—-])/;
const DEV_KEYWORDS = /\b(?:branch|merge[ds]?|worktree|commit(?:s|ed)?|PR\b|pull request|ticket|milestone|tsc\b|bun (?:test|run)|npm (?:i|run|test)|npx\b|vite\b|eslint|typescript|refactor|endpoint|handler|middleware|module|import(?:s|ed)?\b|export(?:s|ed)?\b|function\b|regex|schema|migration|unit test|e2e|CI\b|pm2|systemd|Dockerfile|docker compose)/i;
const PROJECT_PREFIX = /^\s*(?:arigami|the (?:arigami )?(?:project|repo|codebase))\s*(?:project|repo|codebase|gotcha|convention|dev|internals?|architecture)?\s*[:—-]/i;
const API_ROUTE = /\/__api\/[\w/:-]+/;
const CONVENTION = /\b(?:never edit(?:ing)? |always run |before (?:committing|merging)|gate[sd]? (?:are|is|with)|pre-existing errors?|test report|feature work is done in)/i;

/** Heuristic: developer documentation about the codebase rather than a fact about the human/world. */
export function isRepoDoc(content: string): boolean {
  const s = String(content || '');
  if (CODE_PATH.test(s) || REPO_ROOT.test(s) || BRANCH.test(s) || PROJECT_PREFIX.test(s) || API_ROUTE.test(s)) return true;
  let score = 0;
  if (CODE_FILE.test(s)) score += 2;
  if (TASK_ID.test(s)) score += 1;
  if (DEV_KEYWORDS.test(s)) score += 1;
  if (CONVENTION.test(s)) score += 1;
  return score >= 2;
}

// ---- normalization + similarity --------------------------------------------------

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'with', 'via', 'as', 'it', 'its', 'this', 'that', 'from', 'has', 'have', 'user', "user's", 'users',
  'את', 'של', 'עם', 'על', 'או', 'זה', 'זו', 'לא', 'כל', 'גם', 'אם', 'כי', 'יש', 'אין', 'הוא', 'היא', 'הם', 'כדי', 'אל', 'מן', 'בין', 'אצל',
]);

export function normalizeText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/^[-*]\s+/, '')
    .replace(/[“”"'`’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeText(s).split(/[\s,;:()[\]{}<>!?…·—]+/)) {
    // Strip punctuation/markdown from the edges (**bold**, "quotes", trailing ':'), keep identifiers whole.
    const w = raw.replace(/^[^\p{L}\p{N}@+#]+|[^\p{L}\p{N}@#%]+$/gu, '');
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** Long identifier-ish tokens (JIDs, phones, emails, URLs, ids) — a shared one is a strong "same fact" signal. */
function anchors(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(s || '').toLowerCase().matchAll(/[\w.+-]+@[\w.-]+|https?:\/\/\S+|\+?\d[\d-]{7,}\d|[a-z0-9_-]*\d[a-z0-9_-]{7,}/g)) out.add(m[0].replace(/[.,;:]+$/, ''));
  return out;
}

export interface Similarity {
  jaccard: number;
  containment: number;
  anchor: boolean;
}

export function similarity(a: string, b: string): Similarity {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return { jaccard: 0, containment: 0, anchor: false };
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  const aa = anchors(a);
  let anchor = false;
  if (aa.size) for (const x of anchors(b)) if (aa.has(x)) { anchor = true; break; }
  return { jaccard, containment, anchor };
}

/** Same fact, restated (the "×41" rows of the manual triage). */
export function isNearDuplicate(a: string, b: string): boolean {
  if (normalizeText(a) === normalizeText(b)) return true;
  const s = similarity(a, b);
  if (s.jaccard >= 0.5) return true;
  if (s.containment >= 0.8 && Math.min(tokens(a).size, tokens(b).size) >= 4) return true;
  if (s.anchor && s.containment >= 0.3) return true;
  return false;
}

/** Already said by an existing memory line (stricter than clustering — a stray shared word must not swallow a new fact). */
export function isAlreadyKnown(content: string, lines: string[]): { line: string; score: number } | null {
  const norm = normalizeText(content);
  let best: { line: string; score: number } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#/.test(line)) continue;
    if (normalizeText(line) === norm) return { line, score: 1 };
    const s = similarity(content, line);
    const score = Math.max(s.jaccard, s.anchor ? s.containment : 0);
    if ((s.jaccard >= 0.6 || (s.containment >= 0.85 && tokens(content).size >= 4) || (s.anchor && s.containment >= 0.6)) && (!best || score > best.score)) best = { line, score };
  }
  return best;
}

/** A looser "talks about the same thing" — surfaced to the model as the MERGE candidate (a hint, never a decision). */
export function relatedLine(content: string, lines: string[], target: Target): Cluster['related'] {
  let best: Cluster['related'];
  const A = tokens(content);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#/.test(line)) continue;
    const s = similarity(content, line);
    // A shared long token (a proper noun like a club name, a product name) with a
    // little overall overlap is enough to point the model at the line.
    let longShared = 0;
    for (const w of tokens(line)) if (w.length >= 6 && A.has(w)) longShared++;
    const score = Math.max(s.jaccard, s.anchor ? 0.35 : 0, longShared >= 1 && s.jaccard >= 0.1 ? 0.25 : 0);
    if (score >= 0.2 && (!best || score > best.score)) best = { target, line: line.replace(/^[-*]\s+/, ''), score: Math.round(score * 100) / 100 };
  }
  return best;
}

// ---- clustering -----------------------------------------------------------------

export function clusterItems(items: TriageItem[]): Cluster[] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (find(i) !== find(j) && isNearDuplicate(items[i].content, items[j].content)) parent[find(j)] = find(i);
  const groups = new Map<number, TriageItem[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(items[i]);
  }
  const clusters: Cluster[] = [];
  let k = 0;
  for (const members of groups.values()) {
    // Deterministic representative: the most informative phrasing (longest),
    // ties → the newest. The model may still pick/compose a better one.
    const rep = [...members].sort((a, b) => b.content.length - a.content.length || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const targets = members.reduce((m, it) => m.set(it.target, (m.get(it.target) || 0) + 1), new Map<Target, number>());
    const target: Target = (targets.get('user') || 0) > (targets.get('memory') || 0) ? 'user' : 'memory';
    clusters.push({
      key: `c${++k}`,
      ids: [rep.id, ...members.filter((m) => m.id !== rep.id).map((m) => m.id)],
      items: members,
      representative: rep.content,
      count: members.length,
      sessions: new Set(members.map((m) => m.sessionId || m.id)).size,
      target,
    });
  }
  // Biggest clusters first — they are the most corroborated facts.
  return clusters.sort((a, b) => b.count - a.count || a.representative.localeCompare(b.representative)).map((c, i) => ({ ...c, key: `c${i + 1}` }));
}

// ---- the deterministic pre-pass ---------------------------------------------------

export interface PrepassInput {
  items: TriageItem[];
  userMd: string;
  memoryMd: string;
  /** memory.ts's sanitize (credentials / injection / exfil) — injected so this module stays pure. */
  sanitize: (s: string) => { ok: boolean; reason?: string };
}

export function prepass(input: PrepassInput): PrepassResult {
  const userLines = input.userMd.split('\n');
  const memoryLines = input.memoryMd.split('\n');
  const allLines = [...userLines, ...memoryLines];
  const keep: TriageItem[] = [];
  const dropped: Dropped[] = [];
  const drop = (it: TriageItem, reasonKey: ReasonKey, detail?: string) =>
    dropped.push({ key: '', ids: [it.id], content: it.content, count: 1, reasonKey, detail, target: it.target });
  for (const it of input.items) {
    const content = String(it.content || '').trim();
    if (!content) { drop(it, 'empty'); continue; }
    const s = input.sanitize(content);
    if (!s.ok) { drop(it, 'unsafe', s.reason); continue; }
    const sens = detectSensitive(content);
    if (sens) { drop(it, 'sensitive', sens.reason); continue; }
    const known = isAlreadyKnown(content, allLines);
    if (known) { drop(it, 'already-known', known.line); continue; }
    if (isRepoDoc(content)) { drop(it, 'repo-doc'); continue; }
    keep.push({ ...it, content });
  }
  // Collapse the dropped rows the same way (so the log says "×41", not 41 rows).
  const folded: Dropped[] = [];
  for (const d of dropped) {
    const same = folded.find((f) => f.reasonKey === d.reasonKey && isNearDuplicate(f.content, d.content));
    if (same) { same.ids.push(...d.ids); same.count += d.count; if (d.content.length > same.content.length) same.content = d.content; }
    else folded.push({ ...d });
  }
  folded.sort((a, b) => b.count - a.count);
  folded.forEach((d, i) => { d.key = `d${i + 1}`; });
  const clusters = clusterItems(keep).map((c) => ({
    ...c,
    related: relatedLine(c.representative, c.target === 'user' ? userLines : memoryLines, c.target),
  }));
  return { clusters, dropped: folded };
}

// ---- the model contract ---------------------------------------------------------

export interface Decision {
  key: string;
  action: Action;
  target: Target;
  content: string;
  reason: string;
  reasonKey?: ReasonKey;
  mergeInto?: string;
}

export function hasHebrew(s: string): boolean {
  return /[֐-׿]/.test(s || '');
}

export function buildPrompt(clusters: Cluster[], userMd: string, memoryMd: string): string {
  const lang = hasHebrew(userMd + memoryMd) ? 'Hebrew' : 'English';
  const rows = clusters
    .map((c) => {
      const variants = c.items.map((i) => i.content).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6);
      return (
        `${c.key} [target=${c.target}, seen ×${c.count} in ${c.sessions} session(s)]` +
        (c.related ? `\n  related existing line (${c.related.target}): ${c.related.line}` : '') +
        `\n  variants:\n` +
        variants.map((v) => `   - ${v}`).join('\n')
      );
    })
    .join('\n\n');
  return (
    `You are the memory curator of Arigami, a personal AI cockpit. Sessions propose "facts" to remember about the human ` +
    `and their world; you decide what actually enters the two always-loaded memory files. Be STRICT: memory is tiny ` +
    `(a few hundred tokens each) and re-injected into every future session — only durable, non-obvious facts belong.\n\n` +
    `Current USER.md (facts about the human):\n${userMd.trim() || '(empty)'}\n\n` +
    `Current MEMORY.md (world/work facts, standing policies):\n${memoryMd.trim() || '(empty)'}\n\n` +
    `Candidate clusters (each cluster = one fact restated by several sessions):\n\n${rows}\n\n` +
    `For EVERY cluster key output exactly one decision:\n` +
    `- "SAME_AS": this cluster restates another cluster's fact — set "as" to that cluster's key and decide once, there. ` +
    `(The pre-pass clusters by wording; you cluster by meaning.)\n` +
    `- "ENTER": a new fact worth remembering. "content" = the single best phrasing (precise, ≤25 words, keep concrete ` +
    `identifiers such as phone numbers/JIDs/names, no session-specific detail). If a related existing line covers the same ` +
    `topic but you still think ENTER is right, also fill "merge_into" with that line verbatim as a fallback.\n` +
    `- "MERGE": the fact refines an existing line. "merge_into" = the existing line VERBATIM — the whole line, including any ` +
    `markdown such as **bold**, without the leading "- "; ` +
    `"content" = the merged line: it must keep EVERY piece of information of the existing line (a merge only adds or sharpens, ` +
    `it never shortens or drops a clause) plus the new detail.\n` +
    `- "DROP": ephemeral, session-specific, trivial, already implied, developer documentation about the Arigami codebase ` +
    `(paths, conventions, task ids, how the code works), or personal data such as ID numbers, addresses or credentials.\n` +
    `Never enter or merge secrets, credentials, ID/passport numbers or home addresses. "target" is "user" for facts about ` +
    `the human themself, "memory" for everything else. "reason" = ONE short line in ${lang} a human reads in the log.\n\n` +
    `Output ONLY a JSON object (no prose, no markdown fences):\n` +
    `{"decisions":[{"key":"c1","action":"ENTER|MERGE|DROP|SAME_AS","as":"c2 (SAME_AS only)","target":"user|memory","content":"...","merge_into":"...","reason":"..."}]}`
  );
}

export function extractJsonObject(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(a, b + 1));
}

export const MERGE_MAX_LOSS = 0.25;

/** Share of `oldLine`'s tokens that do not survive in `merged` (0 = nothing lost). */
export function tokenLoss(oldLine: string, merged: string): number {
  const A = tokens(oldLine);
  if (!A.size) return 0;
  const B = tokens(merged);
  let lost = 0;
  for (const w of A) if (!B.has(w)) lost++;
  return lost / A.size;
}

const MAX_CONTENT = 1200; // a MERGE carries the whole existing line — never truncate one (the token caps bound the file)
const MAX_REASON = 200;

/** Find the existing line the model meant: exact (normalized) first, then the closest line by token containment. */
export function findExistingLine(needle: string, doc: string): string | null {
  const lines = doc.split('\n').map((l) => l.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
  const n = normalizeText(needle);
  if (!n) return null;
  const exact = lines.find((l) => normalizeText(l) === n);
  if (exact) return exact;
  // The model often drops markdown or trims a long line — accept a line that
  // contains the quoted text (or vice versa) or shares ≥85% of its tokens.
  const stripped = (x: string) => normalizeText(x).replace(/\*\*|__|`/g, '');
  const ns = stripped(needle);
  let best: { line: string; score: number } | null = null;
  for (const l of lines) {
    const ls = stripped(l);
    if (ls === ns || (ns.length >= 20 && (ls.includes(ns) || ns.includes(ls)))) return l;
    const sim = similarity(needle, l);
    if (sim.containment >= 0.85 && sim.jaccard >= 0.5 && (!best || sim.jaccard > best.score)) best = { line: l, score: sim.jaccard };
  }
  return best ? best.line : null;
}

/**
 * Validate the model's output against the clusters it was asked about. Anything
 * malformed degrades safely: unknown keys are ignored, missing clusters stay
 * pending (DEFER), a MERGE whose target line cannot be found stays pending too
 * (never entered as a near-duplicate), an ENTER that restates an existing line
 * becomes a MERGE into it (longer wording) or a DROP (already known), and
 * "SAME_AS" folds a cluster into another cluster's decision.
 */
export function parseDecisions(text: string, clusters: Cluster[], docs: { userMd: string; memoryMd: string }): { decisions: Decision[]; notes: string[] } {
  const parsed = extractJsonObject(text);
  const raw: any[] = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
  const notes: string[] = [];
  const byKey = new Map(clusters.map((c) => [c.key, c]));
  const out = new Map<string, Decision>();
  const sameAs = new Map<string, string>();
  const docOf = (t: Target) => (t === 'user' ? docs.userMd : docs.memoryMd);
  for (const d of raw) {
    const c = byKey.get(String(d?.key || ''));
    if (!c || out.has(c.key) || sameAs.has(c.key)) continue;
    const action = String(d.action || '').toUpperCase().replace(/[\s-]/g, '_');
    const target: Target = d.target === 'user' || d.target === 'memory' ? d.target : c.target;
    const content = String(d.content || c.representative).trim().slice(0, MAX_CONTENT);
    const reason = String(d.reason || '').trim().slice(0, MAX_REASON);
    if (action === 'SAME_AS' || action === 'SAME') {
      const as = String(d.as || d.same_as || d.merge_into || '').trim();
      if (byKey.has(as) && as !== c.key) { sameAs.set(c.key, as); continue; }
      out.set(c.key, { key: c.key, action: 'DEFER', target, content: c.representative, reason, reasonKey: 'no-decision' });
      continue;
    }
    let mergeInto = d.merge_into ? findExistingLine(String(d.merge_into), docOf(target)) : null;
    if (d.merge_into && !mergeInto && action === 'MERGE') notes.push(`${c.key}: merge target not found in ${target}.md — left pending`);
    if (action === 'DROP') { out.set(c.key, { key: c.key, action: 'DROP', target, content: c.representative, reason }); continue; }
    if (action === 'MERGE') {
      if (!mergeInto) { out.set(c.key, { key: c.key, action: 'DEFER', target, content, reason, reasonKey: 'merge-target-missing' }); continue; }
      // A merge must not lose what the existing line said: if more than a quarter of
      // its tokens vanish from the merged wording, keep the fact pending instead.
      const lost = tokenLoss(mergeInto, content);
      if (lost > MERGE_MAX_LOSS) {
        notes.push(`${c.key}: merge would drop ~${Math.round(lost * 100)}% of the existing ${target}.md line — left pending`);
        out.set(c.key, { key: c.key, action: 'DEFER', target, content, reason, mergeInto, reasonKey: 'merge-lossy' });
        continue;
      }
      out.set(c.key, { key: c.key, action: 'MERGE', target, content, reason, mergeInto });
      continue;
    }
    if (action === 'ENTER') {
      // Guard: an ENTER that restates an existing line must not land as a near-duplicate.
      const known = isAlreadyKnown(content, docOf(target).split('\n'));
      if (known) {
        const line = known.line.replace(/^[-*]\s+/, '');
        if (content.length > line.length + 10) { out.set(c.key, { key: c.key, action: 'MERGE', target, content, reason, mergeInto: line, reasonKey: 'already-known' }); notes.push(`${c.key}: ENTER restated an existing ${target}.md line — merged into it`); }
        else out.set(c.key, { key: c.key, action: 'DROP', target, content: c.representative, reason, reasonKey: 'already-known' });
        continue;
      }
      out.set(c.key, { key: c.key, action: 'ENTER', target, content, reason, mergeInto: mergeInto || undefined });
    }
  }
  // Fold SAME_AS clusters: they are restatements of the cluster they point at
  // (follow chains, refuse cycles) — rejected as members when that decision applies.
  for (const [from, to0] of sameAs) {
    let to = to0;
    const seen = new Set([from]);
    while (sameAs.has(to) && !seen.has(to)) { seen.add(to); to = sameAs.get(to)!; }
    if (seen.has(to) || !byKey.has(to)) { out.set(from, { key: from, action: 'DEFER', target: byKey.get(from)!.target, content: byKey.get(from)!.representative, reason: '', reasonKey: 'no-decision' }); continue; }
    out.set(from, { key: from, action: 'DROP', target: byKey.get(from)!.target, content: byKey.get(from)!.representative, reason: to, reasonKey: 'cluster-member' });
  }
  for (const c of clusters)
    if (!out.has(c.key)) out.set(c.key, { key: c.key, action: 'DEFER', target: c.target, content: c.representative, reason: '', reasonKey: 'no-decision' });
  return { decisions: clusters.map((c) => out.get(c.key)!), notes };
}

// ---- cap-aware planning ------------------------------------------------------------

export interface PlanInput {
  decisions: Decision[];
  userMd: string;
  memoryMd: string;
  caps: Record<Target, number>;
  estimateTokens: (s: string) => number;
}

function simulateAdd(doc: string, content: string): string {
  const bullet = `- ${content}`;
  return doc ? `${doc.replace(/\n+$/, '')}\n${bullet}\n` : `${bullet}\n`;
}

function simulateReplace(doc: string, oldLine: string, content: string): string | null {
  const lines = doc.split('\n');
  const idx = lines.findIndex((l) => normalizeText(l) === normalizeText(oldLine) || normalizeText(l) === normalizeText(`- ${oldLine}`));
  if (idx === -1) return null;
  lines[idx] = `- ${content}`;
  return lines.join('\n');
}

/**
 * Walk the ENTER/MERGE decisions in order against a simulated copy of each
 * file. When an ENTER would push the file over its cap: fall back to MERGE
 * into the model's suggested related line if it gave one, otherwise leave the
 * fact pending (DEFER, reasonKey 'cap') — never drop knowledge for lack of room.
 */
export function planWithCap(input: PlanInput): { decisions: Decision[]; notes: string[] } {
  const docs: Record<Target, string> = { user: input.userMd, memory: input.memoryMd };
  const notes: string[] = [];
  let enterToMerge = 0;
  let deferred = 0;
  const out: Decision[] = [];
  for (const d0 of input.decisions) {
    const d = { ...d0 };
    if (d.action === 'ENTER') {
      const next = simulateAdd(docs[d.target], d.content);
      if (input.estimateTokens(next) <= input.caps[d.target]) { docs[d.target] = next; out.push(d); continue; }
      if (d.mergeInto) {
        const merged = simulateReplace(docs[d.target], d.mergeInto, d.content);
        if (merged && input.estimateTokens(merged) <= input.caps[d.target]) {
          docs[d.target] = merged;
          out.push({ ...d, action: 'MERGE', reasonKey: 'cap' });
          enterToMerge++;
          continue;
        }
      }
      out.push({ ...d, action: 'DEFER', reasonKey: 'cap' });
      deferred++;
      continue;
    }
    if (d.action === 'MERGE') {
      const merged = d.mergeInto ? simulateReplace(docs[d.target], d.mergeInto, d.content) : null;
      if (merged && input.estimateTokens(merged) <= input.caps[d.target]) { docs[d.target] = merged; out.push(d); continue; }
      if (!merged) { out.push({ ...d, action: 'ENTER', mergeInto: undefined, reasonKey: 'merge-target-missing' }); continue; }
      out.push({ ...d, action: 'DEFER', reasonKey: 'cap' });
      deferred++;
      continue;
    }
    out.push(d);
  }
  if (enterToMerge) notes.push(`cap: ${enterToMerge} ENTER → MERGE (MEMORY.md/USER.md near the token cap — merged into an existing line instead of adding one)`);
  if (deferred) notes.push(`cap: ${deferred} left pending — no room and no line to merge into`);
  return { decisions: out, notes };
}

// ---- scheduler decision -----------------------------------------------------------

export interface ScheduleState {
  mode: 'auto' | 'manual';
  pending: number;
  /** Last completed run (any trigger), ms epoch. */
  lastRunAt: number | null;
  /** When the scheduler first saw this queue non-empty, ms epoch — the age anchor before any run happened. */
  firstSeenAt: number | null;
  now: number;
  minBatch: number;
  maxAgeHours: number;
  memAvailableMb: number;
  minFreeMb: number;
  running: boolean;
}

export type ScheduleVerdict =
  | { run: true; reason: 'batch' | 'age' }
  | { run: false; deferred: 'manual' | 'empty' | 'running' | 'memory' | 'not-yet'; reason?: 'batch' | 'age' };

export function shouldRun(s: ScheduleState): ScheduleVerdict {
  if (s.running) return { run: false, deferred: 'running' };
  if (s.mode !== 'auto') return { run: false, deferred: 'manual' };
  if (s.pending <= 0) return { run: false, deferred: 'empty' };
  let reason: 'batch' | 'age' | null = null;
  if (s.pending >= s.minBatch) reason = 'batch';
  else {
    const anchor = s.lastRunAt ?? s.firstSeenAt;
    if (anchor != null && s.now - anchor >= s.maxAgeHours * 3600_000) reason = 'age';
  }
  if (!reason) return { run: false, deferred: 'not-yet' };
  if (s.memAvailableMb < s.minFreeMb) return { run: false, deferred: 'memory', reason };
  return { run: true, reason };
}

export interface NextRun {
  byCount: number; // proposals still missing before the batch trigger fires
  at: string | null; // ISO when the age trigger fires (null: nothing pending / no anchor)
}

export function nextRun(s: Pick<ScheduleState, 'pending' | 'lastRunAt' | 'firstSeenAt' | 'minBatch' | 'maxAgeHours'>): NextRun {
  const anchor = s.lastRunAt ?? s.firstSeenAt;
  return {
    byCount: Math.max(0, s.minBatch - s.pending),
    at: anchor != null ? new Date(anchor + s.maxAgeHours * 3600_000).toISOString() : null,
  };
}
