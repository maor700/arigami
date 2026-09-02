// LADDER1 — the model ladder's fit-or-compact decision and the shape of a
// compacted replay (server/lib/ladder-replay.ts, pure), plus the "running below
// its model" badge the API's session summary carries (state.toWireSession →
// supervisor.ladderBadge). The bug: a 1M-window conversation `--resume`d into a
// 200k model dies on its first turn; the fix compacts it first, and the climb
// back restores the original full history.
import { test, expect, describe } from 'bun:test';
import {
  planReplay,
  stripImages,
  stripImageBlocks,
  splitTranscript,
  renderEvents,
  shapeForCompaction,
  buildPreamble,
  fallbackDigest,
  restoreTarget,
  compactBudgets,
  DEFAULT_HEADROOM,
  type ChatEventLike,
} from '../server/lib/ladder-replay.ts';
import { ladderBadge } from '../server/supervisor.ts';
import { runInChild } from './_child.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FABLE = 1_000_000;
const HAIKU = 200_000;

// ---- a fake transcript: 10 user turns, tool results with an image, a screenshot Read
const PNG = 'iVBORw0KGgo' + 'A'.repeat(20_000); // a "base64 image" — heavy, never needed for continuity
function fakeTranscript(turns = 10): ChatEventLike[] {
  const evs: ChatEventLike[] = [];
  evs.push({ kind: 'system', text: '⟳ session started' });
  for (let i = 1; i <= turns; i++) {
    evs.push({ kind: 'user', text: `turn ${i}: please do step ${i} of the task in /repo/file${i}.ts` });
    evs.push({ kind: 'thinking', text: 'private scratch — never replayed' });
    evs.push({ kind: 'tool-use', toolUseId: `t${i}`, name: 'Read', input: { file_path: `/repo/shot${i}.png` } });
    evs.push({
      kind: 'tool-result',
      toolUseId: `t${i}`,
      content: [
        { type: 'text', text: `read /repo/shot${i}.png` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
      isError: false,
    });
    evs.push({ kind: 'assistant-text', text: `done with step ${i}; next is ${i + 1}` });
    evs.push({ kind: 'result', text: 'ok', isError: false });
  }
  // the turn that hit the quota wall
  evs.push({ kind: 'user', text: 'turn 11: and now the final step', attachments: [{ name: 'paste.png', isImage: true }] });
  evs.push({ kind: 'error', text: 'You have hit your usage limit. Your limit resets 6:50pm.', isError: true });
  return evs;
}

describe('planReplay — fit against the TARGET window with headroom', () => {
  test('a conversation that fits fable and haiku replays in full', () => {
    const p = planReplay({ estTokens: 90_000, targetWindow: HAIKU });
    expect(p.mode).toBe('full');
    expect(p.fitLimit).toBe(140_000); // 70% of 200k
    expect(p.headroom).toBe(DEFAULT_HEADROOM);
  });
  test('a 600k conversation fits fable (1M) but NOT haiku (200k) → compact', () => {
    expect(planReplay({ estTokens: 600_000, targetWindow: FABLE }).mode).toBe('full');
    expect(planReplay({ estTokens: 600_000, targetWindow: HAIKU }).mode).toBe('compact');
  });
  test('the headroom is real: 150k does not fit a 200k window at 70%, but does at 80%', () => {
    expect(planReplay({ estTokens: 150_000, targetWindow: HAIKU }).mode).toBe('compact');
    expect(planReplay({ estTokens: 150_000, targetWindow: HAIKU, headroom: 0.8 }).mode).toBe('full');
  });
  test('garbage headroom falls back to the default; zero/unknown sizes fit', () => {
    expect(planReplay({ estTokens: 10, targetWindow: HAIKU, headroom: 7 }).headroom).toBe(DEFAULT_HEADROOM);
    expect(planReplay({ estTokens: 0, targetWindow: HAIKU }).mode).toBe('full');
  });
});

describe('images are stripped from the replayed context', () => {
  test('base64 image blocks in tool results become a one-line placeholder naming the file/type', () => {
    const r = stripImageBlocks([{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }], '/repo/shot1.png');
    expect(r.stripped).toBe(1);
    const blocks = r.content as any[];
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toContain('/repo/shot1.png');
    expect(blocks[1].text).toContain('image/png');
    expect(JSON.stringify(blocks)).not.toContain(PNG.slice(0, 200));
  });
  test('over a transcript: every tool-result image and pasted image attachment is counted and removed', () => {
    const r = stripImages(fakeTranscript(3));
    expect(r.stripped).toBe(4); // 3 screenshots + 1 pasted attachment
    expect(JSON.stringify(r.content)).not.toContain(PNG.slice(0, 200));
    const last = r.content[r.content.length - 2];
    expect(last.kind).toBe('user');
    expect(last.text).toContain('paste.png');
    expect(last.attachments).toEqual([]);
  });
  test('string contents and non-image blocks pass through untouched', () => {
    expect(stripImageBlocks('plain text')).toEqual({ content: 'plain text', stripped: 0 });
    const r = stripImageBlocks([{ type: 'text', text: 'x' }]);
    expect(r.stripped).toBe(0);
  });
});

describe('the digest + tail shape', () => {
  test('splitTranscript keeps the last N user turns (and everything after) as the tail', () => {
    const evs = fakeTranscript(10);
    const s = splitTranscript(evs, 3);
    expect(s.tailTurns).toBe(3);
    expect(s.tail[0].kind).toBe('user');
    expect(s.tail[0].text).toContain('turn 9:'); // turns 9, 10, 11
    expect(s.head.some((e) => e.text === 'turn 9: please do step 9 of the task in /repo/file9.ts')).toBe(false);
    expect(s.head.some((e) => (e.text || '').startsWith('turn 8:'))).toBe(true);
  });
  test('fewer turns than asked → everything is tail, nothing to digest', () => {
    const s = splitTranscript(fakeTranscript(2), 6);
    expect(s.head).toEqual([]);
    expect(s.tailTurns).toBe(3);
  });
  test('renderEvents drops thinking, truncates long tool results, and keeps head+tail when over budget', () => {
    const evs = stripImages(fakeTranscript(10)).content;
    const full = renderEvents(evs, Number.MAX_SAFE_INTEGER);
    expect(full.omitted).toBe(0);
    expect(full.text).not.toContain('private scratch');
    expect(full.text).toContain('USER: turn 1:');
    expect(full.text).toContain('TOOL Read(');
    const tight = renderEvents(evs, 1_200);
    expect(tight.omitted).toBeGreaterThan(0);
    expect(tight.text).toContain('earlier part of the conversation omitted');
    expect(tight.text.length).toBeLessThanOrEqual(1_200 + 80);
    expect(tight.text).toContain('turn 1:'); // the task framing survives
    expect(tight.text).toContain('turn 11:'); // so does the end
  });
  test('shapeForCompaction: images gone, tail verbatim within budget, digest source within budget', () => {
    const evs = fakeTranscript(10);
    const shape = shapeForCompaction(evs, HAIKU, { tailTurns: 4 });
    const b = compactBudgets(HAIKU);
    expect(shape.imagesStripped).toBe(11);
    expect(shape.tailTurns).toBe(4);
    expect(shape.tailText).toContain('USER: turn 8:');
    expect(shape.tailText).toContain('USER: turn 11:');
    expect(shape.tailText).not.toContain('turn 7:');
    expect(shape.tailText).not.toContain(PNG.slice(0, 100));
    expect(shape.tailText).toContain('[image omitted from the replayed context');
    expect(shape.tailText.length).toBeLessThanOrEqual(b.tailChars);
    expect(shape.digestSource).toContain('USER: turn 1:');
    expect(shape.digestSource).toContain('turn 7:');
    expect(shape.digestSource).not.toContain('turn 8:');
    expect(shape.digestSource.length).toBeLessThanOrEqual(b.digestInputChars);
    expect(shape.omittedFromDigest).toBe(0);
  });
  test('the preamble carries digest then tail, and the fallback digest lists the human\'s messages', () => {
    const shape = shapeForCompaction(fakeTranscript(10), HAIKU, { tailTurns: 2 });
    const digest = fallbackDigest(shape.head);
    expect(digest).toContain('- turn 1:');
    expect(digest).toContain('- turn 9:');
    expect(digest).not.toContain('turn 10:');
    const pre = buildPreamble({
      from: 'fable',
      to: 'haiku',
      digest,
      tailText: shape.tailText,
      tailTurns: shape.tailTurns,
      estTokens: 640_000,
      targetWindow: HAIKU,
      imagesStripped: shape.imagesStripped,
      omittedFromDigest: 0,
      resetAtLocal: '18:50',
    });
    const iDigest = pre.indexOf('=== DIGEST OF THE OLDER CONVERSATION ===');
    const iTail = pre.indexOf('=== LAST 2 TURNS (verbatim) ===');
    expect(iDigest).toBeGreaterThan(0);
    expect(iTail).toBeGreaterThan(iDigest);
    expect(pre).toContain('~640k tokens');
    expect(pre).toContain('200k-token window');
    expect(pre).toContain('resets 18:50');
    expect(pre).toContain('11 images replaced by placeholders');
    expect(pre.endsWith('=== END OF REPLAYED CONTEXT ===\n\n')).toBe(true);
  });
});

describe('the climb back', () => {
  const note = { mode: 'compact' as const, at: '2026-09-02T17:13:20Z', from: 'fable', to: 'haiku', estTokens: 640_000, targetWindow: HAIKU, originalSessionId: 'orig-uuid', compactSessionId: 'fresh-uuid' };
  test('resumes the ORIGINAL full history when it fits the top rung again', () => {
    expect(restoreTarget(note, FABLE).resume).toBe('original');
  });
  test('stays on the compacted conversation when the top rung is itself small now', () => {
    expect(restoreTarget(note, HAIKU).resume).toBe('current');
  });
  test('a full (non-compacted) replay has nothing to undo', () => {
    expect(restoreTarget({ ...note, mode: 'full', originalSessionId: null }, FABLE).resume).toBe('current');
    expect(restoreTarget(null, FABLE).resume).toBe('current');
  });
});

describe('the badge in the session summary', () => {
  test('ladderBadge: null on the top rung, the running/configured/resetAt triple below it', () => {
    expect(ladderBadge({ modelRung: 0, modelChoice: 'fable' })).toBeNull();
    expect(ladderBadge(null)).toBeNull();
    const b = ladderBadge({ modelRung: 2, modelChoice: 'haiku', modelDowngradedFrom: 'fable', modelRestoreAt: '2026-09-02T15:50:00.000Z', ladderReplay: { mode: 'compact' } });
    expect(b).toEqual({ running: 'haiku', configured: 'fable', resetAt: '2026-09-02T15:50:00.000Z', compacted: true });
    expect(ladderBadge({ modelRung: 1, modelChoice: 'sonnet', modelDowngradedFrom: 'fable', modelRestoreAt: null })).toEqual({ running: 'sonnet', configured: 'fable', resetAt: null, compacted: false });
  });
  test('toWireSession (what GET /__api/sessions and the WS broadcasts carry) exposes claude.ladder, and drops it on the climb back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ladder1-'));
    const r = runInChild(
      `const st = await import('./server/state.js');
       const s = st.createSession({ title: 'ladder', cwd: '/tmp' });
       st.setClaude(s.id, { modelChoice: 'haiku', modelRung: 2, modelDowngradedFrom: 'fable', modelRestoreAt: '2026-09-02T15:50:00.000Z', ladderReplay: { mode: 'compact', at: 'x', from: 'fable', to: 'haiku', estTokens: 640000, targetWindow: 200000, originalSessionId: 'orig' } });
       emit(st.toWireSession(st.getSession(s.id)).claude.ladder);
       emit(st.listSessionsForWire().find((x) => x.id === s.id).claude.ladder);
       st.setClaude(s.id, { modelChoice: 'fable', modelRung: 0, modelDowngradedFrom: null, modelRestoreAt: null });
       emit(st.toWireSession(st.getSession(s.id)).claude.ladder ?? null);`,
      { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_AUTH: 'off' }
    );
    expect(r.ok).toBe(true);
    expect(r.out[0]).toEqual({ running: 'haiku', configured: 'fable', resetAt: '2026-09-02T15:50:00.000Z', compacted: true });
    expect(r.out[1]).toEqual(r.out[0]);
    expect(r.out[2]).toBeNull();
  });
});
