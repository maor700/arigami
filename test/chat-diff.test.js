// Inline chat diff: the pure line diff + the card model for every edit shape.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { lineDiff, numberRows, buildCards, isEditEvent, summarizeEdits, startLineFromResult, parseUnified } = await import(path.join(ROOT, 'web/src/lib/editDiff.js'));
const { hiddenInSimple } = await import(path.join(ROOT, 'web/src/lib/chatMode.js'));

const tx = (ops) => ops.map((o) => ({ ctx: ' ', add: '+', del: '-' })[o.t] + o.text).join('|');

test('lineDiff: unchanged lines inside old/new are context, not delete+add', () => {
  expect(tx(lineDiff('a\nb\nc\nd', 'a\nx\nc\nd\ne'))).toBe(' a|-b|+x| c| d|+e');
  expect(tx(lineDiff('', 'a\nb'))).toBe('+a|+b');
  expect(tx(lineDiff('a\nb', ''))).toBe('-a|-b');
  expect(lineDiff('same\n', 'same\n').every((o) => o.t === 'ctx')).toBe(true);
});

test('lineDiff: reconstructs both sides on random inputs', () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 400; i++) {
    const mk = () => Array.from({ length: rnd(10) }, () => 'abcd'[rnd(4)]);
    const a = mk(), b = mk();
    const d = lineDiff(a, b);
    expect(d.filter((o) => o.t !== 'add').map((o) => o.text)).toEqual(a);
    expect(d.filter((o) => o.t !== 'del').map((o) => o.text)).toEqual(b);
  }
});

test('numberRows: relative or absolute numbering, long unchanged runs fold', () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const nw = [...old]; nw[15] = 'CHANGED';
  const rows = numberRows(lineDiff(old, nw), 100, 100);
  expect(rows.some((r) => r.t === 'gap')).toBe(true);
  const add = rows.find((r) => r.t === 'add');
  expect(add.n).toBe(115);
  expect(rows.find((r) => r.t === 'del').o).toBe(115);
  expect(numberRows(lineDiff('a', 'b'))[0].o).toBe(1);
});

test('Edit event → one card with real stats (context is not counted)', () => {
  const ev = { kind: 'tool-use', name: 'Edit', toolUseId: 'u1', input: { file_path: '/repo/src/a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' } };
  expect(isEditEvent(ev)).toBe(true);
  const { cards } = buildCards(ev);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ path: '/repo/src/a.ts', base: 'a.ts', dir: '/repo/src/', add: 1, del: 1, kind: 'edit', notApplied: null });
  expect(cards[0].rows.map((r) => r.t)).toEqual(['ctx', 'del', 'add', 'ctx']);
});

test('Edit: absolute line from the result snippet; failed result → notApplied', () => {
  const ev = { kind: 'tool-use', name: 'Edit', toolUseId: 'u1', input: { file_path: 'f.js', old_string: 'a', new_string: 'b\nc' } };
  const ok = { kind: 'tool-result', toolUseId: 'u1', text: 'The file f.js has been updated. Here is the result of running `cat -n`:\n    41→x\n    42→b\n    43→c\n    44→y' };
  expect(startLineFromResult(ok, 'b\nc')).toBe(42);
  const c = buildCards(ev, ok).cards[0];
  expect(c.rows.find((r) => r.t === 'add').n).toBe(42);
  expect(c.absolute).toBe(true);
  const bad = { kind: 'tool-result', toolUseId: 'u1', isError: true, text: 'String to replace not found in file.' };
  expect(buildCards(ev, bad).cards[0].notApplied).toBe('String to replace not found in file.');
  expect(summarizeEdits([ev], new Map([['u1', bad]])).files).toBe(0);
});

test('MultiEdit → one card, edits separated by a gap, stats summed', () => {
  const ev = { kind: 'tool-use', name: 'MultiEdit', input: { file_path: 'm.py', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'c\nd\ne' }] } };
  const c = buildCards(ev).cards[0];
  expect(c).toMatchObject({ add: 2, del: 1 });
  expect(c.rows.some((r) => r.t === 'gap')).toBe(true);
});

test('Write → all-added body; NotebookEdit new_source', () => {
  const w = buildCards({ kind: 'tool-use', name: 'Write', input: { file_path: '/x/new.md', content: 'a\nb\nc\n' } }).cards[0];
  expect(w).toMatchObject({ kind: 'create', add: 3, del: 0 });
  expect(w.rows.map((r) => r.n)).toEqual([1, 2, 3]);
  const nb = buildCards({ kind: 'tool-use', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb', new_source: 'x=1', edit_mode: 'replace' } }).cards[0];
  expect(nb).toMatchObject({ add: 1, del: 0, path: 'n.ipynb' });
});

test('codex fileChange patch → absolute unified rows, split per file; raw content for an add', () => {
  const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n x\n+y';
  const { cards } = buildCards({ kind: 'tool-use', name: 'Edit', input: { file_path: 'src/a.ts, b.ts', patch }, additions: 2, deletions: 1 });
  expect(cards.map((c) => c.path)).toEqual(['src/a.ts', 'b.ts']);
  expect(cards[0]).toMatchObject({ add: 1, del: 1, absolute: true });
  expect(cards[0].rows[1]).toMatchObject({ t: 'del', o: 11, text: 'old' });
  expect(cards[0].rows[2]).toMatchObject({ t: 'add', n: 11, text: 'new' });
  const added = buildCards({ kind: 'tool-use', name: 'Edit', input: { file_path: 'z.txt', patch: 'l1\nl2' } }).cards[0];
  expect(added).toMatchObject({ kind: 'create', add: 2 });
  expect(parseUnified('@@ -1 +1 @@\n-a\n+b').map((r) => r.t)).toEqual(['del', 'add']);
});

test('clipped event is flagged loading; non-edit tools are not edit events', () => {
  const clipped = { kind: 'tool-use', name: 'Write', seq: 9, clipped: true, input: { file_path: 'big.ts', content: 'abc…' } };
  const m = buildCards(clipped);
  expect(m.loading).toBe(true);
  expect(m.cards[0].path).toBe('big.ts');
  expect(isEditEvent({ kind: 'tool-use', name: 'mcp__x__create_session', input: { content: 'x' } })).toBe(false);
  expect(isEditEvent({ kind: 'tool-use', name: 'Bash', input: { command: 'ls' } })).toBe(false);
  expect(isEditEvent({ kind: 'tool-result', name: 'Edit' })).toBe(false);
});

test('Simple mode still folds edit tool calls (the summary is added on top, not instead)', () => {
  expect(hiddenInSimple({ kind: 'tool-use', name: 'Edit', input: {} })).toBe(true);
});

test('tool-result bodies in the wire shape (content string or parts array) are understood', () => {
  const ev = { kind: 'tool-use', name: 'Edit', input: { file_path: 'f', old_string: 'a', new_string: 'b' } };
  expect(buildCards(ev, { kind: 'tool-result', isError: true, content: [{ type: 'text', text: 'nope' }] }).cards[0].notApplied).toBe('nope');
  expect(buildCards(ev, { kind: 'tool-result', isError: false, content: 'updated' }).cards[0].notApplied).toBeNull();
});
