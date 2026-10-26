// KEEP-ALIVE — switching sessions must not reload a session's tabs.
// Repro (before): App rendered ONE SessionView for the selected session, so a
// switch unmounted every tab body of the previous one; on the way back each
// iframe (Linear card, PR card, extension page, proxied site) navigated again,
// the Changes tab re-fetched, and scroll / typed input / the picked tab were
// gone. Measured A→B→A: 21 requests, ~620 kB, PR tab usable after ~1.8 s.
// Fix: a bounded pool of recently visited sessions stays mounted but hidden;
// card data is stale-while-revalidate; the card bundle revalidates with an
// ETag; concurrent / repeated PR fetches share one `gh` round.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import { touchPool, poolCap, POOL_CAP_DESKTOP, POOL_CAP_PHONE } from '../web/src/lib/sessionPool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('pool: most-recent first, capped, least-recently-visited evicted', () => {
  let p = [];
  for (const id of ['a', 'b', 'c']) p = touchPool(p, id, 2);
  expect(p).toEqual(['c', 'b']); // a was the least recently visited
  p = touchPool(p, 'b', 2);
  expect(p).toEqual(['b', 'c']);
  p = touchPool(p, 'a', 2);
  expect(p).toEqual(['a', 'b']);
});

test('pool: deleted sessions leave it, no selection keeps it, an unchanged pool is the same array', () => {
  const p = touchPool([], 'a', 5);
  const q = touchPool(p, 'b', 5);
  expect(touchPool(q, 'b', 5)).toBe(q); // nothing changed → same reference
  expect(touchPool(q, null, 5)).toBe(q); // settings open: nothing selected, pool kept
  expect(touchPool(q, null, 5, new Set(['a']))).toEqual(['a']); // b was deleted
  expect(touchPool(q, 'zz', 5, new Set(['a', 'b']))).toEqual(['b', 'a']); // an unknown id is never added
});

test('pool cap: phones and low-memory devices keep the current + the previous session only', () => {
  expect(poolCap({ isDesktop: true })).toBe(POOL_CAP_DESKTOP);
  expect(poolCap({ isDesktop: false })).toBe(POOL_CAP_PHONE);
  expect(poolCap({ isDesktop: true, deviceMemory: 2 })).toBe(POOL_CAP_PHONE);
  expect(poolCap({ isDesktop: true, deviceMemory: 8 })).toBe(POOL_CAP_DESKTOP);
  expect(POOL_CAP_PHONE).toBe(2); // A→B→A must survive on a phone
});

test('App renders the pool keyed per session, in a stable order, hidden ones inert', () => {
  const app = src('web/src/App.jsx');
  // moving an iframe in the DOM reloads it, so the render order must not follow recency
  expect(app).toContain('[...poolRef.current].sort().map((id) =>');
  expect(app).toMatch(/key=\{id\}\s*data-pool-session=\{id\}/);
  expect(app).toContain("className={visible ? 'flex min-h-0 flex-1' : 'kept-hidden absolute inset-0 flex'}");
  expect(app).toContain("{...(visible ? {} : { inert: '', 'aria-hidden': 'true' })}");
  expect(app).toContain('visible={visible}');
  // the old single SessionView (one instance re-pointed at every session) is gone
  expect(app.match(/<SessionView\b/g)).toHaveLength(1);
});

test('a hidden SessionView renders no tab bar and no chat, stands its tabs down, and freezes their bodies', () => {
  const sv = src('web/src/components/SessionView.jsx');
  expect(sv).toContain('onRestore, visible = true }) {');
  expect(sv).toMatch(/\{visible && \(\s*<TabBar/);
  expect(sv).toContain("tab.type === 'session' && !visible ? null :");
  expect(sv).toContain('const live = active && visible;');
  for (const tag of ['<ChangesTab key={session.id} session={session} active={live} />', '<OrchestrationTab session={session} active={live} />', '<UrlTab tab={tab} active={live} session={session} />'])
    expect(sv).toContain(tag);
  expect(sv).toContain('if (!visible && frozenRef.current) bodies = frozenRef.current;');
  // unaddressed window commands go to the visible session only
  expect(sv.match(/\? (e|ev)\.detail\.sessionId !== session\.id : !visible\) return;/g)).toHaveLength(2);
  // tabs hide with content-visibility (layout + scroll kept), not display:none
  expect(sv).toContain("${active ? '' : 'kept-hidden'}");
  const css = src('web/src/index.css');
  expect(css).toMatch(/\.kept-hidden \{\s*visibility: hidden;\s*content-visibility: hidden;\s*pointer-events: none;/);
});

test('card data is stale-while-revalidate, bounded, and a failed refresh keeps the cached page', () => {
  const card = src('server/assets/card.jsx');
  expect(card).toContain("const [d, setD] = useState(() => swrRead(key));");
  expect(card).toContain('if (!bad) swrWrite(key, j);');
  expect(card).toContain('setD((cur) => (bad && cur && !cur.error ? cur : j));');
  expect(card).toMatch(/const SWR_MAX = \d+;/);
  expect(card).toContain('sessionStorage.removeItem(old.shift())');
});

test('the card bundle carries an ETag and answers a matching revalidation with 304', () => {
  const r = runInChild(
    "const p=await import('./server/pages.js');" +
      'const hit=(h)=>new Promise((ok)=>{const res={writeHead(c,hd){this.c=c;this.h=hd;return this},end(b){ok({code:this.c,etag:this.h&&this.h.etag,len:b?String(b).length:0})}};p.handlePage({url:"/__card.js",headers:{host:"x",...h}},res);});' +
      'const a=await hit({});const b=await hit({"if-none-match":a.etag});const c=await hit({"if-none-match":\'"stale"\'});emit({a,b,c});',
    { ARIGAMI_DIR: tmpDir('arigami-card-etag-'), ARIGAMI_PORT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const { a, b, c } = r.out[0];
  expect(a.code).toBe(200);
  expect(a.etag).toMatch(/^"[0-9a-f]{16}"$/);
  expect(a.len).toBeGreaterThan(1000);
  expect(b).toEqual({ code: 304, etag: a.etag, len: 0 });
  expect(c.code).toBe(200);
});

test('PR fetches: concurrent asks share one gh round, a reload within the TTL reuses it, fresh always refetches', () => {
  const dir = tmpDir('arigami-prcache-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, 'calls');
  // a fake `gh`: counts its calls, answers `pr view` with a PR and every `api` call with an empty list
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\necho "$1" >> ${calls}\nif [ "$1" = pr ]; then echo '{"number":7,"title":"T","state":"OPEN"}'; else echo '[]'; fi\n`,
    { mode: 0o755 }
  );
  const r = runInChild(
    "const p=await import('./server/pages.js');const fs=await import('node:fs');" +
      `const n=()=>fs.existsSync(${JSON.stringify(calls)})?fs.readFileSync(${JSON.stringify(calls)},'utf8').trim().split('\\n').length:0;` +
      "const [x,y]=await Promise.all([p.fetchPR('o','r','7'),p.fetchPR('o','r','7')]);const one=n();" +
      "await p.fetchPR('o','r','7');const cached=n();" +
      "await p.fetchPR('o','r','7',{fresh:true});const fresh=n();" +
      "await p.fetchPR('o','r','8');const other=n();" +
      'emit({same:x===y,num:x&&x.number,one,cached,fresh,other});',
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', PATH: `${bin}:${process.env.PATH}` }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.num).toBe(7);
  expect(o.same).toBe(true);
  expect(o.one).toBe(7); // `gh pr view` + five `gh api` calls + the merge box's one (mergeInfo) — once for both asks
  expect(o.cached).toBe(7);
  expect(o.fresh).toBe(14);
  expect(o.other).toBe(21);
});
