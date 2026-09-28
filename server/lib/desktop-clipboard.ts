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
  // Input.insertText goes to the focused editable of a page that HAS focus. A
  // Chrome under Xvfb (or headless) is never the OS-focused window, so without
  // this the text is dropped on the floor and the field stays as it was —
  // measured in test/desktop-clipboard.test.ts before this line existed.
  await cdpCall(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdpCall(ws, 'Input.insertText', { text });
}

/** The DevTools port of the screen the cockpit shows: a session's Chrome, or "my browser". */
export function portFor(sessionId: string | null): number | null {
  return sessionId ? cdpPort(sessionId) : cdpPort('vault', CHROME_BASE_DIR);
}
