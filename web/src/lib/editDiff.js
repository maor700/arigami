// Pure helpers behind the chat's inline diff card: a real line diff (Myers) and
// the "card model" builder that turns an edit-type tool_use event (Edit,
// MultiEdit, Write, NotebookEdit, codex fileChange patch) into rows the card
// renders. No React / DOM in here so it is unit-testable.

/* ---------- line diff ----------------------------------------------------- */

const splitLines = (s) => {
  const str = String(s ?? '');
  if (str === '') return [];
  const a = str.split('\n');
  if (a[a.length - 1] === '') a.pop(); // a trailing newline is not an extra empty line
  return a;
};
export { splitLines };

const MAX_EDIT_COST = 3000; // Myers cost cap — beyond this fall back to replace-all

// Diff two line arrays → [{t:'ctx'|'add'|'del', text}] in order. Common
// prefix/suffix are trimmed first, then Myers' O(ND) on the middle.
export function lineDiff(a, b) {
  const A = Array.isArray(a) ? a : splitLines(a);
  const B = Array.isArray(b) ? b : splitLines(b);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const out = [];
  for (let i = 0; i < s; i++) out.push({ t: 'ctx', text: A[i] });
  for (const op of myers(A.slice(s, ea), B.slice(s, eb))) out.push(op);
  for (let i = ea; i < A.length; i++) out.push({ t: 'ctx', text: A[i] });
  return out;
}

function myers(A, B) {
  const N = A.length, M = B.length;
  if (!N) return B.map((text) => ({ t: 'add', text }));
  if (!M) return A.map((text) => ({ t: 'del', text }));
  const max = Math.min(N + M, MAX_EDIT_COST);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return [...A.map((text) => ({ t: 'del', text })), ...B.map((text) => ({ t: 'add', text }))];
  // backtrack
  const ops = [];
  let x = N, y = M;
  for (let d = found; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = d === 0 ? 0 : vv[off + pk];
    const py = d === 0 ? 0 : px - pk;
    while (x > px && y > py) { x--; y--; ops.push({ t: 'ctx', text: A[x] }); }
    if (d > 0) {
      if (down) ops.push({ t: 'add', text: B[py] });
      else ops.push({ t: 'del', text: A[px] });
    }
    x = px; y = py;
  }
  return ops.reverse();
}

/* ---------- rows: numbering + context folding ----------------------------- */

const CONTEXT = 3;

// ops → numbered rows. `oldStart`/`newStart` are the 1-based line numbers the
// first line has in the file (1 when unknown → snippet-relative). Unchanged
// runs longer than 2*CONTEXT+1 between/around changes fold into a {t:'gap'}.
export function numberRows(ops, oldStart = 1, newStart = 1, { fold = true } = {}) {
  let o = oldStart, n = newStart;
  const rows = ops.map((op) => {
    if (op.t === 'ctx') return { t: 'ctx', text: op.text, n: n++, o: o++ };
    if (op.t === 'add') return { t: 'add', text: op.text, n: n++ };
    return { t: 'del', text: op.text, o: o++, n: undefined };
  });
  if (!fold) return rows;
  const changed = rows.map((r) => r.t !== 'ctx');
  const keep = rows.map(() => false);
  let last = -1e9;
  for (let i = 0; i < rows.length; i++) if (changed[i]) last = i, keep[i] = true; else if (i - last <= CONTEXT) keep[i] = true;
  last = 1e9;
  for (let i = rows.length - 1; i >= 0; i--) if (changed[i]) last = i; else if (last - i <= CONTEXT) keep[i] = true;
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (keep[i]) { out.push(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    if (j - i <= 2) for (; i < j; i++) out.push(rows[i]);
    else { out.push({ t: 'gap', count: j - i }); i = j; }
  }
  return out;
}

const stats = (rows) => rows.reduce((s, r) => (r.t === 'add' ? { ...s, add: s.add + 1 } : r.t === 'del' ? { ...s, del: s.del + 1 } : s), { add: 0, del: 0 });

/* ---------- unified-diff parsing (codex patches) -------------------------- */

// A codex fileChange `patch` is the changes' diffs joined by "\n": updates are
// unified diffs (possibly with ---/+++ headers), add/delete carry raw content.
export function parseUnified(patch) {
  const rows = [];
  let o = 0, n = 0, inHunk = false, firstO = null, firstN = null;
  for (const line of String(patch).split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      if (inHunk && rows.length) rows.push({ t: 'gap', count: 0 });
      o = +m[1]; n = +m[2]; inHunk = true;
      if (firstO == null) { firstO = o; firstN = n; }
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = line[0], text = line.slice(1);
    if (c === '+') rows.push({ t: 'add', text, n: n++ });
    else if (c === '-') rows.push({ t: 'del', text, o: o++ });
    else if (c === ' ') rows.push({ t: 'ctx', text, n: n++, o: o++ });
    else if (line === '') rows.push({ t: 'ctx', text: '', n: n++, o: o++ });
  }
  while (rows.length && rows[rows.length - 1].t === 'ctx' && rows[rows.length - 1].text === '' && rows.length > 1 && !inHunk) rows.pop();
  return rows;
}

// Split a joined multi-file patch on `--- a/x` / `+++ b/x` (or `diff --git`) headers.
function splitPatchFiles(patch) {
  const lines = String(patch).split('\n');
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isHdr = (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) || l.startsWith('diff --git ');
    if (isHdr) {
      if (cur) files.push(cur);
      cur = { path: null, lines: [] };
      if (l.startsWith('diff --git ')) { const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l); if (m) cur.path = m[2]; continue; }
    }
    if (!cur) { if (l.trim() === '') continue; cur = { path: null, lines: [] }; }
    if (l.startsWith('+++ ')) { const p = l.slice(4).replace(/^b\//, '').trim(); if (p && p !== '/dev/null') cur.path = p; continue; }
    if (l.startsWith('--- ')) { const p = l.slice(4).replace(/^a\//, '').trim(); if (!cur.path && p && p !== '/dev/null') cur.path = p; continue; }
    cur.lines.push(l);
  }
  if (cur) files.push(cur);
  return files;
}

/* ---------- card model ----------------------------------------------------- */

const toolName = (e) => String(e?.name ?? e?.tool ?? e?.toolName ?? '');
const EDIT_NAMES = /^(edit|multiedit|write|notebookedit|str_replace_editor|str_replace_based_edit_tool|apply_patch)$/i;

// Is this tool_use an edit-type event we can draw as a diff?
export function isEditEvent(e) {
  if (!e || e.kind !== 'tool-use') return false;
  const name = toolName(e);
  if (!EDIT_NAMES.test(name)) return false;
  const i = e.input;
  if (!i || typeof i !== 'object') return !!e.clipped;
  return i.old_string != null || i.new_string != null || Array.isArray(i.edits) || i.content != null
    || i.new_source != null || typeof i.patch === 'string' || i.file_text != null || i.new_str != null || !!e.clipped;
}

const baseOf = (p) => String(p || '').split('/').pop() || String(p || '');
const dirOf = (p) => { const s = String(p || ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i + 1) : ''; };
export const pathParts = (p) => ({ base: baseOf(p), dir: dirOf(p) });

// A tool-result's body: `content` is a string or an array of {text} parts.
const resText = (r) => {
  const t = r?.text ?? r?.content ?? r?.output ?? '';
  return Array.isArray(t) ? t.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n') : String(t);
};

// Failed / rejected: the paired tool-result says so.
export function notApplied(result) {
  if (!result) return null;
  const err = !!(result.isError ?? result.is_error);
  const text = resText(result);
  if (!err && !/^\s*declined\b|was rejected|user rejected|doesn't want to proceed/i.test(text)) return null;
  return text.split('\n').find((l) => l.trim()) || (err ? 'error' : 'declined');
}

// Claude's Edit result embeds a `cat -n` snippet of the edited file; when the
// new text is found in it we know the absolute line of its first line.
export function startLineFromResult(result, newText) {
  const text = resText(result);
  const want = splitLines(newText);
  if (!text || !want.length) return null;
  const snip = [];
  for (const l of text.split('\n')) {
    const m = /^\s*(\d+)[→\t](.*)$/.exec(l);
    if (m) snip.push({ n: +m[1], text: m[2] });
  }
  for (let i = 0; i + want.length <= snip.length; i++) {
    if (want.every((w, k) => snip[i + k].text === w)) return snip[i].n;
  }
  return null;
}

const card = (path, kind, rows, extra = {}) => ({ path, ...pathParts(path), kind, rows, ...stats(rows), ...extra });

function editRows(oldS, newS, result, fold = true) {
  const ops = lineDiff(oldS, newS);
  const start = result ? startLineFromResult(result, newS) : null;
  return numberRows(ops, start ?? 1, start ?? 1, { fold });
}

// event (+ optional paired tool-result) → { cards:[…], loading } | null.
// Each card: { path, base, dir, kind:'edit'|'create'|'delete', rows, add, del, absolute, notApplied }.
export function buildCards(event, result = null) {
  if (!isEditEvent(event)) return null;
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  const na = notApplied(result);
  const withNa = (cards) => ({ cards: cards.map((c) => ({ ...c, notApplied: na })), loading: !!event.clipped, clipped: !!event.clipped });
  const path = input.file_path ?? input.path ?? input.notebook_path ?? '';

  if (typeof input.patch === 'string') {
    const files = splitPatchFiles(input.patch);
    const paths = String(input.file_path || '').split(', ').filter(Boolean);
    const hasHunks = /^@@ /m.test(input.patch);
    if (!hasHunks) {
      // add/delete carry raw content, no headers → all-added body for the (single) path
      const rows = splitLines(input.patch).map((text, i) => ({ t: 'add', text, n: i + 1 }));
      return withNa([card(paths.join(', ') || path, 'create', rows, { absolute: true })]);
    }
    const parts = files.length ? files : [{ path: null, lines: input.patch.split('\n') }];
    return withNa(parts.map((f, i) => {
      const rows = parseUnified(f.lines.join('\n'));
      return card(f.path || paths[i] || paths[0] || path, 'edit', rows, { absolute: true });
    }));
  }
  if (Array.isArray(input.edits)) {
    let rows = [];
    input.edits.forEach((ed, i) => {
      const r = editRows(ed.old_string, ed.new_string, null);
      if (i > 0 && r.length) rows.push({ t: 'gap', count: 0 });
      rows = rows.concat(r);
    });
    return withNa([card(path, 'edit', rows)]);
  }
  if (input.old_string != null || input.new_string != null || input.new_str != null) {
    const nw = input.new_string ?? input.new_str ?? '';
    const rows = editRows(input.old_string ?? input.old_str ?? '', nw, result);
    const abs = !!(result && startLineFromResult(result, nw));
    return withNa([card(path, 'edit', rows, { absolute: abs })]);
  }
  if (input.content != null || input.file_text != null) {
    const rows = splitLines(input.content ?? input.file_text).map((text, i) => ({ t: 'add', text, n: i + 1 }));
    return withNa([card(path, 'create', rows, { absolute: true })]);
  }
  if (input.new_source != null) {
    const mode = String(input.edit_mode || 'replace');
    const rows = splitLines(input.new_source).map((text, i) => ({ t: mode === 'delete' ? 'del' : 'add', text, [mode === 'delete' ? 'o' : 'n']: i + 1 }));
    return withNa([card(path, mode === 'insert' ? 'create' : 'edit', rows, { cell: input.cell_id || null })]);
  }
  return withNa([card(path, 'edit', [])]);
}

// Totals across a list of events → { files, add, del } (distinct paths).
export function summarizeEdits(events, results = new Map()) {
  const paths = new Set();
  let add = 0, del = 0;
  for (const e of events) {
    if (!isEditEvent(e)) continue;
    const m = buildCards(e, results.get?.(e.toolUseId) ?? null);
    if (!m) continue;
    for (const c of m.cards) {
      if (c.notApplied) continue;
      paths.add(c.path);
      add += c.add; del += c.del;
    }
  }
  return { files: paths.size, add, del };
}
