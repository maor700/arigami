// MEM1 — the in-memory chat tail is a bounded cache of the jsonl, not a copy
// of it. Per session it holds at most TAIL_MAX events and TAIL_MAX_BYTES of
// rows; globally at most TAILS_MAX_BYTES, evicting the coldest sessions whole;
// a deleted session's tail is forgotten. Reads fall back to disk whenever the
// tail does not reach, so none of this is visible to a caller.
// claude.js fixes CHAT_DIR at import time → each case runs out-of-process with
// its own ARIGAMI_DIR (test/_child.js), like chatws-host.test.ts.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function tmpInstance(extra: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chattail-'));
  fs.mkdirSync(path.join(dir, 'chat'), { recursive: true });
  return { dir, env: { ARIGAMI_DIR: dir, ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), HOME: dir, ...extra } };
}

const load = "const c=await import('./server/claude.js');";
// 40 tool results of 100KB each = ~4MB of rows into a 1MB per-session budget.
const fill = (id: string, n = 40, size = 100_000) =>
  `for(let i=1;i<=${n};i++) c.appendChat('${id}',{kind:'tool-result',toolUseId:'t'+i,content:'R'.repeat(${size})});`;

test('per-session byte cap: the tail keeps only the newest rows, reads still see them all from disk', () => {
  const { dir, env } = tmpInstance({ ARIGAMI_TAIL_MAX_BYTES: String(1024 * 1024) });
  const out = runInChild(
    load +
      fill('s1') +
      "const st=c.tailStats();" +
      "const all=c.getChat('s1',0);" +
      "const first=c.getChatEvent('s1',1);" +
      "const page=c.getChatPage('s1',{limit:5});" +
      "emit({sessions:st.sessions, events:st.events, bytes:st.bytes, max:st.perSessionMaxBytes, all:all.length, firstSeq:first?.seq, firstLen:first?.content?.length, pageLen:page.events.length, pageLast:page.events.at(-1)?.seq, hasMore:page.hasMore})",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.sessions).toBe(1);
  expect(r.bytes).toBeLessThanOrEqual(r.max);
  expect(r.events).toBeLessThan(40); // ~10 rows of 100KB fit in 1MB
  expect(r.events).toBeGreaterThan(0);
  expect(r.all).toBe(40); // the disk fallback returns the whole transcript
  expect(r.firstSeq).toBe(1); // an evicted row is still fetchable (from disk)
  expect(r.firstLen).toBe(100_000);
  expect(r.pageLen).toBe(5);
  expect(r.pageLast).toBe(40);
  expect(r.hasMore).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'chat', 's1.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBe(40);
});

test('global budget: the coldest session is evicted whole and rebuilds from disk with the right seq', () => {
  const { env } = tmpInstance({ ARIGAMI_TAIL_MAX_BYTES: String(8 * 1024 * 1024), ARIGAMI_TAILS_MAX_BYTES: String(3 * 1024 * 1024) });
  const out = runInChild(
    load +
      fill('cold', 20) + // ~2MB
      fill('hot', 20) + // ~2MB more → over the 3MB budget → `cold` goes
      "const st=c.tailStats();" +
      "const coldEvents=c.getChat('cold',0).length;" + // disk fallback
      "const ev=c.appendChat('cold',{kind:'user',text:'again'});" + // tail rebuilt: seq continues at 21
      "const st2=c.tailStats();" +
      "emit({sessions:st.sessions, largest:st.largest.id, under:st.bytes<=st.totalMaxBytes, coldEvents, seq:ev.seq, sessions2:st2.sessions})",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.sessions).toBe(1);
  expect(r.largest).toBe('hot');
  expect(r.under).toBe(true);
  expect(r.coldEvents).toBe(20);
  expect(r.seq).toBe(21);
  expect(r.sessions2).toBe(2);
});

test('a session that just appended is never evicted by the global budget, and the row count cap still holds', () => {
  const { env } = tmpInstance({ ARIGAMI_TAIL_MAX_BYTES: String(64 * 1024 * 1024), ARIGAMI_TAILS_MAX_BYTES: String(1024) });
  const out = runInChild(
    load +
      "for(let i=1;i<=600;i++) c.appendChat('only',{kind:'user',text:'m'+i});" +
      "const st=c.tailStats();" +
      "emit({sessions:st.sessions, events:st.events, newest:c.getChatPage('only',{limit:1}).events[0].seq})",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.sessions).toBe(1);
  expect(r.events).toBe(500); // TAIL_MAX
  expect(r.newest).toBe(600);
});

test('session-deleted on the bus forgets the tail; forgetTail is idempotent', () => {
  const { env } = tmpInstance();
  const out = runInChild(
    load +
      "const bus=await import('./server/bus.js');" +
      fill('gone', 3, 10) +
      fill('stays', 3, 10) +
      "const before=c.tailStats().sessions;" +
      "bus.broadcast({type:'session-deleted', id:'gone'});" +
      "const after=c.tailStats();" +
      "emit({before, after:after.sessions, largest:after.largest.id, again:c.forgetTail('gone'), bytesPositive:after.bytes>0})",
    env,
  );
  if (!out.ok) throw new Error(out.error);
  const r = out.out[0];
  expect(r.before).toBe(2);
  expect(r.after).toBe(1);
  expect(r.largest).toBe('stays');
  expect(r.again).toBe(false);
  expect(r.bytesPositive).toBe(true);
});

test('countLines-based seq: a cold session resumes numbering from the file, counting bytes not chars', () => {
  const { dir, env } = tmpInstance();
  // Non-ASCII rows: the old char-walk and a byte count agree on '\n' only if
  // the count is done on the right unit — make sure multi-byte text does not
  // shift the seq.
  const lines = Array.from({ length: 7 }, (_, i) => JSON.stringify({ id: `e${i + 1}`, seq: i + 1, ts: 1, kind: 'user', text: 'שלום עולם 🙂'.repeat(50) }));
  fs.writeFileSync(path.join(dir, 'chat', 'heb.jsonl'), lines.join('\n') + '\n');
  const out = runInChild(load + "const ev=c.appendChat('heb',{kind:'user',text:'next'}); emit({seq:ev.seq, all:c.getChat('heb',0).length})", env);
  if (!out.ok) throw new Error(out.error);
  expect(out.out[0].seq).toBe(8);
  expect(out.out[0].all).toBe(8);
});
