// Copy/paste across machines (server/lib/desktop-clipboard.ts), against a real
// headless Chrome: paste lands at the cursor of the focused field, copy reads
// the selection (in a field or in the page), and a password field is never read.
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { findChromeBin } from '../server/lib/platform.ts';

const chrome = findChromeBin();
let out: any = null;

beforeAll(() => {
  if (!chrome) return;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
  const prof = path.join(sandbox, 'profile');
  const r = runInChild(
    `const dc = await import('./server/lib/desktop-clipboard.ts');
     const { cdpCall, listTabs } = await import('./server/lib/chrome-cdp.ts');
     const { spawn } = await import('node:child_process');
     const fs = await import('node:fs'); const path = await import('node:path');
     const html = '<textarea id=t>hello world</textarea><p id=p>copy me please</p><input id=pw type=password value=secret>';
     const proc = spawn(${JSON.stringify(chrome)}, ['--headless=new', '--user-data-dir=${prof}', '--remote-debugging-port=0', '--no-first-run', 'data:text/html,' + encodeURIComponent(html)], { stdio: 'ignore' });
     let port = null;
     for (let i = 0; i < 100 && !port; i++) { try { port = Number(fs.readFileSync(path.join(${JSON.stringify(prof)}, 'DevToolsActivePort'), 'utf8').split('\\n')[0]); } catch {} await new Promise(r => setTimeout(r, 100)); }
     let ws = null;
     for (let i = 0; i < 50 && !ws; i++) { const tabs = await listTabs('', port); ws = tabs.find(t => t.type === 'page' && t.url.startsWith('data:'))?.webSocketDebuggerUrl; if (!ws) await new Promise(r => setTimeout(r, 100)); }
     const ev = (e) => cdpCall(ws, 'Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result.value);
     // the target is listed before the document is parsed on a slow runner — wait for the field to exist
     for (let i = 0; i < 100; i++) { if (await ev("document.readyState === 'complete' && !!document.getElementById('t')").catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
     // paste: cursor after "hello"
     await ev("const t = document.getElementById('t'); t.focus(); t.setSelectionRange(5, 5); true");
     await dc.insertAt(port, ' big');
     const afterPaste = await ev("document.getElementById('t').value");
     // copy from a field selection
     await ev("const t2 = document.getElementById('t'); t2.focus(); t2.setSelectionRange(0, 9); true");
     const fieldSel = await dc.selectionAt(port);
     // copy from a page selection
     await ev("document.activeElement.blur(); const r = document.createRange(); r.selectNodeContents(document.getElementById('p')); getSelection().removeAllRanges(); getSelection().addRange(r); true");
     const pageSel = await dc.selectionAt(port);
     // a password field is never read, even fully selected
     await ev("getSelection().removeAllRanges(); const p = document.getElementById('pw'); p.focus(); p.select(); true");
     const pwSel = await dc.selectionAt(port);
     let noBrowser = null; try { await dc.selectionAt(null); } catch (e) { noBrowser = e.message; }
     await cdpCall((await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()).webSocketDebuggerUrl, 'Browser.close', {}).catch(() => {});
     emit({ afterPaste, fieldSel, pageSel, pwSel, noBrowser });`,
    { ARIGAMI_DIR: path.join(sandbox, 'host'), ARIGAMI_STATE_FILE: path.join(sandbox, 'host', 'state.json') }
  );
  if (!r.ok) throw new Error(r.error);
  out = r.out[0];
}, 60_000);

test.skipIf(!chrome)('paste inserts at the cursor of the focused field', () => {
  expect(out.afterPaste).toBe('hello big world');
});

test.skipIf(!chrome)('copy reads a selection inside a text field', () => {
  expect(out.fieldSel).toBe('hello big');
});

test.skipIf(!chrome)('copy reads a selection in the page', () => {
  expect(out.pageSel).toBe('copy me please');
});

test.skipIf(!chrome)('a password field is never read', () => {
  expect(out.pwSel).toBe('');
});

test.skipIf(!chrome)('no browser on the screen is an error, not an empty copy', () => {
  expect(out.noBrowser).toMatch(/no browser/);
});

// ---- the viewer's key mapping (web/src/lib/useScreenConnection.js) -------------

test('the viewer maps clipboard keys per transport', async () => {
  // the module imports noVNC, which needs a window at import time
  const g: any = globalThis;
  const saved = { window: g.window, navigator: g.navigator, document: g.document, MutationObserver: g.MutationObserver };
  g.window = g;
  g.navigator = g.navigator || { language: 'en-US', userAgent: 'test' };
  g.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  g.document = g.document || { createElement: () => ({ style: {}, getContext: () => null }), documentElement: { style: {}, dataset: {} }, body: { appendChild() {}, removeChild() {}, style: {} }, addEventListener() {}, removeEventListener() {}, querySelector: () => null };
  try {
    const { clipboardKey } = await import('../web/src/lib/useScreenConnection.js');
    const k = (key: string, o: Record<string, boolean> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...o });
    expect(clipboardKey(k('c', { metaKey: true }), 'rfb')).toBe('copy');
    expect(clipboardKey(k('c', { ctrlKey: true }), 'screencast')).toBe('copy');
    expect(clipboardKey(k('x', { metaKey: true }), 'rfb')).toBe('cut');
    expect(clipboardKey(k('v', { metaKey: true }), 'rfb')).toBe('paste');
    expect(clipboardKey(k('v', { metaKey: true }), 'screencast')).toBe(null); // its own paste event handles it
    expect(clipboardKey(k('a', { metaKey: true }), 'rfb')).toBe('ctrl-a'); // Cmd+A on a Mac → Ctrl+A on Linux
    expect(clipboardKey(k('a', { ctrlKey: true }), 'rfb')).toBe(null); // already Ctrl — noVNC forwards it as is
    expect(clipboardKey(k('c'), 'rfb')).toBe(null); // plain typing is never intercepted
    expect(clipboardKey(k('c', { metaKey: true, altKey: true }), 'rfb')).toBe(null);
  } finally {
    Object.assign(g, saved);
  }
});

// ---- paste fallback: an app that DevTools cannot reach (the shared desktop's plain Chrome, a terminal) ----

test('paste: DevTools insert first; when the screen has no DevTools Chrome, X clipboard + Ctrl+V over VNC', async () => {
  const { pasteIntoRemote } = await import('../web/src/lib/useScreenConnection.js');
  const calls: string[] = [];
  const post = (ok: boolean) => async (path: string) => {
    calls.push(path);
    return path === 'type' ? { ok, error: 'no browser is open on this screen' } : { ok: true };
  };
  let ctrlV = 0;

  await pasteIntoRemote('hello', { post: post(true), ctrlV: () => ctrlV++ });
  expect(calls).toEqual(['type']);
  expect(ctrlV).toBe(0);

  calls.length = 0;
  await pasteIntoRemote('hello', { post: post(false), ctrlV: () => ctrlV++ });
  expect(calls).toEqual(['type', 'clipboard']);
  expect(ctrlV).toBe(1);

  // the screencast transport has no keyboard to send Ctrl+V with: the DevTools error is the honest answer
  await expect(pasteIntoRemote('hello', { post: post(false), ctrlV: null })).rejects.toThrow('no browser is open');
  // an empty clipboard pastes nothing
  calls.length = 0;
  await pasteIntoRemote('', { post: post(false), ctrlV: () => ctrlV++ });
  expect(calls).toEqual([]);
});

test('setXClipboard puts text on the X clipboard of the display (needs xclip + Xvfb)', async () => {
  const have = (c: string) => Bun.spawnSync(['which', c]).exitCode === 0;
  if (!have('xclip') || !have('Xvfb')) return;
  const { setXClipboard } = await import('../server/lib/desktop-clipboard.js');
  const disp = ':' + (200 + Math.floor(Math.random() * 90));
  const x = Bun.spawn(['Xvfb', disp, '-screen', '0', '320x200x24', '-nolisten', 'tcp'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    await Bun.sleep(800);
    await setXClipboard(disp, 'שלום world');
    const out = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-o'], { env: { ...process.env, DISPLAY: disp } });
    expect(out.stdout.toString()).toBe('שלום world');
  } finally {
    x.kill();
  }
});
