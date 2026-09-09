// SIMPLE1 host: how the host learns the chat mode and what it does with it.
//   · createSession stamps metadata.chatMode = 'simple' on NEW sessions, and
//     an explicit metadata.chatMode (or a restored old session) is respected
//   · chatModePrefix(metadata) is the per-turn brevity reminder — present only
//     while the session is in Simple mode, so flipping the toggle changes the
//     NEXT turn without a restart (writeUserMessage re-reads metadata each turn)
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-simple1-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const env = () => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_FUNNEL_QUIET: '1' });

test('new sessions are born in Simple mode; an explicit mode is kept', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const a=st.createSession({title:'a'});" +
      "const b=st.createSession({title:'b',metadata:{chatMode:'full',ticket:'X-1'}});" +
      "const c=st.createSession({title:'c',metadata:{ticket:'X-2'}});" +
      'emit({a:a.metadata,b:b.metadata,c:c.metadata});',
    env()
  );
  expect(r.ok).toBe(true);
  const { a, b, c } = r.out[0];
  expect(a.chatMode).toBe('simple');
  expect(b.chatMode).toBe('full');
  expect(b.ticket).toBe('X-1');
  expect(c.chatMode).toBe('simple');
  expect(c.ticket).toBe('X-2');
});

test('the mode is patchable through the normal metadata path and the per-turn prefix follows it', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');const c=await import('./server/claude.js');" +
      "const s=st.createSession({title:'m'});" +
      'const before=c.chatModePrefix(st.getSession(s.id).metadata);' +
      "st.patchSession(s.id,{metadata:{chatMode:'full'}});" +
      'const after=c.chatModePrefix(st.getSession(s.id).metadata);' +
      "st.patchSession(s.id,{metadata:{chatMode:'simple'}});" +
      'const again=c.chatModePrefix(st.getSession(s.id).metadata);' +
      'emit({before,after,again,unset:c.chatModePrefix({}),none:c.chatModePrefix(undefined),text:c.SIMPLE_MODE_REMINDER});',
    env()
  );
  expect(r.ok).toBe(true);
  const { before, after, again, unset, none, text } = r.out[0];
  expect(before).toBe(text);
  expect(after).toBe('');
  expect(again).toBe(text);
  expect(unset).toBe('');
  expect(none).toBe('');
  expect(text).toMatch(/^<system-reminder>/);
  expect(text).toMatch(/at most two sentences/);
  expect(text).toMatch(/Bad news is said first/);
  expect(text).toMatch(/No headers, tables/);
  expect(text).toMatch(/not your tool use/);
});

test('composeTurnText prepends the reminder per turn (source-level: after the first-turn bootstrap, before the text)', () => {
  // Prefix assembly moved out of writeUserMessage into engine-agnostic composeTurnText() — same order/output.
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../server/claude.js'), 'utf8');
  const fn = src.slice(src.indexOf('function composeTurnText('), src.indexOf('function writeUserMessage('));
  const boot = fn.indexOf('memoryBootstrapPrefix(p)');
  const mode = fn.indexOf('chatModePrefix(getSession(p.id)?.metadata)');
  expect(boot).toBeGreaterThan(-1);
  expect(mode).toBeGreaterThan(boot);
  // the proc record carries the session id so the metadata is re-read live
  expect(src).toMatch(/const p = \{\n\s+id: s\.id,/);
});
