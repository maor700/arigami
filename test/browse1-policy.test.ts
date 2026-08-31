// BROWSE1: the `browser` tool family (server/agent-policy.ts) — an agent
// gets browser_open/navigate/snapshot/click/type/scroll/close through either
// `browser` alone or the pre-existing `desktop` family (compatibility: an
// agent that already ticked `desktop` keeps browsing for free); the domain
// allowlist (A3) covers browser_open/browser_navigate the same way it
// already covers open_tab/WebFetch.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-browse1-'));
const env = (dir: string) => ({ ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_STATE_FILE: path.join(dir, 'state.json'), ARIGAMI_CHAT_DIR: path.join(dir, 'chat') });
const run = (dir: string, body: string) => {
  const r = runInChild(body, env(dir));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
};

const BROWSER_TOOLS = ['browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_close'];

test('policy: `browser` family grants exactly the browser_* tools; `desktop` grants them too (compatibility); neither leaks into an agent with only `git`', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'B1',slug:'b1',tools:['browser']});" +
      "a.createAgent({name:'B2',slug:'b2',tools:['desktop']});" +
      "a.createAgent({name:'B3',slug:'b3',tools:['git']});" +
      `const names=${JSON.stringify(BROWSER_TOOLS)};` +
      "const viaBrowser=names.map(n=>p.toolAllowed(p.policyFor('b1'),n));" +
      "const viaDesktop=names.map(n=>p.toolAllowed(p.policyFor('b2'),n));" +
      "const viaGit=names.map(n=>p.toolAllowed(p.policyFor('b3'),n));" +
      // `browser` alone must NOT also grant the rest of `desktop` (open_tab etc).
      "const openTabViaBrowser=p.toolAllowed(p.policyFor('b1'),'open_tab');" +
      "emit({viaBrowser,viaDesktop,viaGit,openTabViaBrowser});"
  );
  expect(o.viaBrowser.every(Boolean)).toBe(true);
  expect(o.viaDesktop.every(Boolean)).toBe(true);
  expect(o.viaGit.every(Boolean)).toBe(false);
  expect(o.openTabViaBrowser).toBe(false);
});

test('policy: browser_open/browser_navigate are gated by `domains`, same as open_tab/WebFetch; browser_snapshot/click/type/scroll are not URL-carrying so domains never blocks them', () => {
  const o = run(
    tmp(),
    "const a=await import('./server/agents.ts');const p=await import('./server/agent-policy.ts');" +
      "a.createAgent({name:'Bot',slug:'bot',tools:['browser'],domains:['example.com']});" +
      "const pol=p.policyFor('bot');" +
      "const okOpen=p.checkToolCall(pol,'browser_open',{url:'https://example.com/x'},'s1');" +
      "const badOpen=p.checkToolCall(pol,'browser_open',{url:'https://evil.com'},'s1');" +
      "const okNav=p.checkToolCall(pol,'browser_navigate',{url:'https://sub.example.com'},'s1');" +
      "const badNav=p.checkToolCall(pol,'browser_navigate',{url:'https://evil.com'},'s1');" +
      "const snap=p.checkToolCall(pol,'browser_snapshot',{},'s1');" +
      "emit({okOpen,badOpen,okNav,badNav,snap});"
  );
  expect(o.okOpen.allow).toBe(true);
  expect(o.badOpen.allow).toBe(false);
  expect(o.badOpen.reason).toMatch(/domain/);
  expect(o.okNav.allow).toBe(true);
  expect(o.badNav.allow).toBe(false);
  expect(o.snap.allow).toBe(true);
});

test('web TOOL_FAMILIES (AgentCard.jsx) includes "browser" — kept in sync with the host FAMILIES by test/agents-a3-web.test.js', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'web/src/components/AgentCard.jsx'), 'utf8');
  expect(src).toMatch(/TOOL_FAMILIES\s*=\s*\[[^\]]*'browser'/);
});
