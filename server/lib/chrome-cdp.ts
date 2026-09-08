// F8: talk to a session's Chrome through the DevTools protocol.
//
// openChrome() starts every session browser with `--remote-debugging-port=0`
// (loopback only — Chrome's default bind address); Chrome then writes the
// port it picked to `<user-data-dir>/DevToolsActivePort`. That gives the host
// two things it could not do before:
//   • list the REAL browser tabs (their URLs) — used to read a PKCE callback
//     (`…/oauth/code/callback?code=…`) straight out of the take-over browser
//     when the human cannot paste through VNC;
//   • insert text into the focused element (Input.insertText, any unicode) —
//     the "type into the desktop" field of the take-over modal.
// Falls back to Chrome's History sqlite (what skills/_lib/connect.sh reads)
// and to XTEST typing (skills/_lib/xinput.py) when the port is not there
// (Chrome started by an older host, or already gone).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeSessionDir } from './chrome.js';
import { pickDriver } from './screen-driver.js';

export type ChromeTab = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string };

/** The DevTools port Chrome wrote for this session's profile, or null. */
export function cdpPort(sessionId: string, profileDir = chromeSessionDir(sessionId)): number | null {
  try {
    const first = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const n = Number(first);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Real Chrome tabs (type 'page'), most recently focused first — [] when CDP is unavailable. */
export async function listTabs(sessionId: string, port = cdpPort(sessionId)): Promise<ChromeTab[]> {
  if (!port) return [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    const arr = (await res.json()) as any[];
    return arr
      .filter((t) => t && typeof t.url === 'string')
      .map((t) => ({ id: String(t.id), type: String(t.type || ''), url: t.url, title: String(t.title || ''), webSocketDebuggerUrl: t.webSocketDebuggerUrl }));
  } catch {
    return [];
  }
}

/** Newest URLs in the profile's History db (Chrome flushes it a few seconds after navigation). */
export function historyUrls(sessionId: string, limit = 20, profileDir = chromeSessionDir(sessionId)): string[] {
  const src = path.join(profileDir, 'Default', 'History');
  if (!fs.existsSync(src)) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-hist-'));
  try {
    // The live db is locked by Chrome; a copy is readable.
    const copy = path.join(tmp, 'History');
    fs.copyFileSync(src, copy);
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(copy, { readonly: true });
    try {
      return (db.query('select url from urls order by last_visit_time desc limit ?').all(limit) as { url: string }[]).map((r) => r.url);
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** First tab URL (CDP) — else newest History URL — matching `re`. null when nothing matches. */
export async function findUrl(sessionId: string, re: RegExp): Promise<{ url: string; source: 'cdp' | 'history' } | null> {
  const tabs = await listTabs(sessionId);
  const hit = tabs.find((t) => t.type === 'page' && re.test(t.url));
  if (hit) return { url: hit.url, source: 'cdp' };
  const h = historyUrls(sessionId).find((u) => re.test(u));
  return h ? { url: h, source: 'history' } : null;
}

/** One CDP command on a page target over its debugger socket. */
export async function cdpCall(wsUrl: string, method: string, params: Record<string, unknown>, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp timeout')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => { clearTimeout(t); reject(new Error('cdp socket error')); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        clearTimeout(t);
        ws.close();
        if (msg.error) reject(new Error(msg.error.message || 'cdp error'));
        else resolve(msg.result);
      } catch (e) { clearTimeout(t); reject(e as Error); }
    };
  });
}

/** The front (most recently focused) real page tab, or throws — every browser_* action needs one. */
export async function frontPage(sessionId: string): Promise<ChromeTab> {
  const tabs = await listTabs(sessionId);
  const page = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no open page for this session — call browser_open first');
  return page;
}

/** Poll document.readyState until 'complete' or timeoutMs elapses (best-effort — a slow page doesn't fail the call). */
async function waitForLoad(wsUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await cdpCall(wsUrl, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r?.result?.value === 'complete') return;
    } catch { /* page navigating — keep polling */ }
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Navigate the front tab and wait for it to finish loading. Returns the settled url/title. */
export async function pageNavigate(sessionId: string, url: string, timeoutMs = 15000): Promise<{ url: string; title: string }> {
  const page = await frontPage(sessionId);
  await cdpCall(page.webSocketDebuggerUrl!, 'Page.navigate', { url });
  await waitForLoad(page.webSocketDebuggerUrl!, timeoutMs);
  const after = (await listTabs(sessionId)).find((t) => t.id === page.id) || page;
  return { url: after.url, title: after.title };
}

/** Run JS in the front tab and return its value (returnByValue) — throws on a page exception. */
export async function pageEvaluate(sessionId: string, expression: string): Promise<any> {
  const page = await frontPage(sessionId);
  const r = await cdpCall(page.webSocketDebuggerUrl!, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'page evaluate failed');
  return r?.result?.value;
}

/** Synthetic left click at viewport coordinates (x,y) — CDP Input, not xdotool, so it targets the PAGE, not the screen. */
export async function pageClick(sessionId: string, x: number, y: number): Promise<void> {
  const page = await frontPage(sessionId);
  const ws = page.webSocketDebuggerUrl!;
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Synthetic mouse-wheel scroll at viewport coordinates (x,y). */
export async function pageScroll(sessionId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  const page = await frontPage(sessionId);
  await cdpCall(page.webSocketDebuggerUrl!, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

/**
 * PNG bytes of the front tab via CDP `Page.captureScreenshot` — the tab's own
 * viewport, not the desktop/root window. This is what lets `connect.sh shot`
 * (and any other evidence screenshot) stop depending on scrot/VNC: on a real
 * machine (not this session's throwaway Xvfb) a root-window grab would show
 * whatever else the human has open, so the connect-* playbooks need a capture
 * that is scoped to the page they're driving, on every platform.
 */
export async function pageScreenshot(sessionId: string): Promise<Buffer> {
  const page = await frontPage(sessionId);
  const r = await cdpCall(page.webSocketDebuggerUrl!, 'Page.captureScreenshot', { format: 'png' }, 8000);
  if (!r?.data) throw new Error('Page.captureScreenshot returned no data');
  return Buffer.from(r.data as string, 'base64');
}

/**
 * Type `text` into whatever has focus on the session's desktop: CDP
 * Input.insertText on the front tab (unicode ok), else the screen driver's
 * own typeText (XTEST on x11 — ASCII only). Never logs the text — it may be
 * a one-time code.
 */
export async function typeIntoDesktop(sessionId: string, text: string, press?: 'Enter'): Promise<{ ok: true; via: 'cdp' | 'xinput' }> {
  if (!text) throw new Error('empty text');
  const tabs = await listTabs(sessionId);
  const page = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (page) {
    await cdpCall(page.webSocketDebuggerUrl!, 'Input.insertText', { text });
    if (press === 'Enter') {
      await cdpCall(page.webSocketDebuggerUrl!, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdpCall(page.webSocketDebuggerUrl!, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    return { ok: true, via: 'cdp' };
  }
  const r = await pickDriver().typeText(sessionId, text, press);
  return { ok: true, via: r.via as 'xinput' };
}
