// Copy and paste between the owner's computer and a remote screen in the
// cockpit — a session's desktop, or "my browser" on the shared one.
//
// Neither transport carries a clipboard in a way that works: VNC's cut-text
// depends on the VNC server mirroring the X selection (and never reaches a
// Chrome that pastes from CLIPBOARD), and the screencast transport has none at
// all. What both screens actually show is a Chrome, and Chrome's DevTools can
// do both halves directly:
//
//   paste  the viewer reads the owner's clipboard and the text is inserted at
//          the cursor of the focused page (Input.insertText — one call, not a
//          keystroke per character, and no keyboard-layout mapping)
//   copy   the viewer asks for what is selected in the focused page and puts
//          it on the owner's clipboard
//
// Limit: a selection inside a cross-origin iframe is not read (the top page's
// selection is empty then). Password fields are never read.
import { spawn } from 'node:child_process';
import { listTabs, cdpCall, cdpPort } from './chrome-cdp.js';
import { CHROME_BASE_DIR } from './chrome.js';

/** What is selected in the page: inside a text field if one has focus, else the document selection. */
export const SELECTION_JS = `(() => {
  const a = document.activeElement;
  const field = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|email|number)$/i.test(a.type || 'text')));
  if (field && a.selectionStart != null && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd);
  if (a && a.tagName === 'INPUT' && /^password$/i.test(a.type)) return '';
  return String(window.getSelection ? window.getSelection() : '');
})()`;

async function frontWs(port: number | null): Promise<string> {
  if (!port) throw new Error('no browser is open on this screen');
  const tabs = await listTabs('', port);
  const page = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no open page on this screen');
  return page.webSocketDebuggerUrl!;
}

export async function selectionAt(port: number | null): Promise<string> {
  const ws = await frontWs(port);
  const r = await cdpCall(ws, 'Runtime.evaluate', { expression: SELECTION_JS, returnByValue: true });
  return String(r?.result?.value ?? '');
}

export async function insertAt(port: number | null, text: string): Promise<void> {
  const ws = await frontWs(port);
  // Insert at the DOM level first: execCommand('insertText') edits the focused
  // field or contenteditable at its cursor, fires the input events, and does not
  // care whether the window has OS focus — a Chrome under Xvfb (or headless)
  // never does, and Input.insertText silently drops the text there (measured in
  // test/desktop-clipboard.test.ts). Input.insertText stays as the fallback for
  // pages where nothing editable has focus.
  const r = await cdpCall(ws, 'Runtime.evaluate', {
    expression: `(() => { const a = document.activeElement; const editable = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable); return editable ? document.execCommand('insertText', false, ${JSON.stringify(text)}) : false; })()`,
    returnByValue: true,
  }).catch(() => null);
  if (r?.result?.value === true) return;
  await cdpCall(ws, 'Input.insertText', { text });
}

/** The DevTools port of the screen the cockpit shows: a session's Chrome, or "my browser". */
export function portFor(sessionId: string | null): number | null {
  return sessionId ? cdpPort(sessionId) : cdpPort('vault', CHROME_BASE_DIR);
}

/**
 * Put `text` on the X CLIPBOARD of `display`, for a paste into an app that is not a DevTools-controllable Chrome (the
 * Chrome on the shared desktop's icon runs without a debug port; anything else — a terminal, a native dialog — never
 * had one). The viewer then sends Ctrl+V over the same VNC connection, so the app pastes it itself. `xclip` stays
 * alive in the background to own the selection; we only wait for it to take the text.
 */
export function setXClipboard(display: string, text: string, timeoutMs = 3000): Promise<void> {
  if (!display) return Promise.reject(new Error('no display to put the clipboard on'));
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', ['-selection', 'clipboard', '-i'], { env: { ...process.env, DISPLAY: display }, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('xclip did not take the text in time'));
    }, timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'xclip is not installed on this host' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
