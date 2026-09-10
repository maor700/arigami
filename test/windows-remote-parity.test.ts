// windows-remote-parity: remote control of a Windows/macOS machine used to be
// browser-shaped AND watch-only, while Linux got a full interactive desktop
// over RFB. Two things closed most of that gap:
//   1. server/screencast.ts relays the viewer's mouse/keyboard back into the
//      page over CDP, instead of dropping every client message on the floor.
//   2. the transport is now something the HOST declares (driver.viewer()) and
//      the cockpit obeys, instead of the client assuming RFB everywhere and
//      opening a socket to a VNC server that does not exist on those hosts.
// This covers the parts that are pure logic — the CDP translation table and
// the descriptors. The end-to-end behaviour (real Chrome, real clicks) is a
// live check; see docs/WINDOWS-REMOTE.md.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';
import { inputToCdp } from '../server/screencast.js';

function inChild(body: string, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wrp-'));
  const r = runInChild(body, {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_WA_AUTOSTART: '0',
    ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
    ...env,
  });
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

// ---- inputToCdp: the viewer -> page translation ----------------------------

test('inputToCdp: a click becomes Input.dispatchMouseEvent with rounded page coordinates', () => {
  const down = inputToCdp({ type: 'mouse', action: 'down', x: 12.7, y: 40.2, button: 'left', buttons: 1 });
  expect(down!.method).toBe('Input.dispatchMouseEvent');
  expect(down!.params).toMatchObject({ type: 'mousePressed', x: 13, y: 40, button: 'left', clickCount: 1, buttons: 1 });
  const up = inputToCdp({ type: 'mouse', action: 'up', x: 12, y: 40 });
  expect(up!.params).toMatchObject({ type: 'mouseReleased', button: 'left' });
  const move = inputToCdp({ type: 'mouse', action: 'move', x: 1, y: 2, button: 'left', buttons: 1 });
  // A move mid-drag must carry `buttons`, or Chrome reads it as a hover and
  // the drag never happens — the failure looks like "drag does nothing".
  expect(move!.params).toMatchObject({ type: 'mouseMoved', buttons: 1, button: 'left' });
});

test('inputToCdp: a plain hover is button "none", not "left"', () => {
  // The DOM reports e.button === 0 ("left") on every pointermove, held or not.
  // Forwarding that verbatim would tell Chrome the left button is involved in
  // every movement of the mouse; `buttons` is the field that knows better.
  const hover = inputToCdp({ type: 'mouse', action: 'move', x: 1, y: 2, button: 'left', buttons: 0 });
  expect(hover!.params).toMatchObject({ type: 'mouseMoved', button: 'none', buttons: 0 });
});

test('inputToCdp: NaN/absent coordinates are dropped, never handed to Chrome', () => {
  expect(inputToCdp({ type: 'mouse', action: 'down', x: 'abc', y: 3 })).toBeNull();
  expect(inputToCdp({ type: 'mouse', action: 'down', y: 3 })).toBeNull();
  expect(inputToCdp({ type: 'mouse', action: 'down', x: Infinity, y: 3 })).toBeNull();
});

test('inputToCdp: a wheel carries deltas and no button; a zero-delta wheel is dropped', () => {
  const w = inputToCdp({ type: 'mouse', action: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: -120 });
  expect(w!.params).toMatchObject({ type: 'mouseWheel', deltaX: 0, deltaY: -120, button: 'none' });
  expect(w!.params.clickCount).toBeUndefined();
  expect(inputToCdp({ type: 'mouse', action: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: 0 })).toBeNull();
});

test('inputToCdp: a printable keyDown carries `text` so it actually types; a named key does not', () => {
  const a = inputToCdp({ type: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65 });
  expect(a!.method).toBe('Input.dispatchKeyEvent');
  expect(a!.params).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
  const left = inputToCdp({ type: 'key', action: 'down', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 });
  expect(left!.params.text).toBeUndefined();
  // keyUp never inserts text, even for a printable key.
  const up = inputToCdp({ type: 'key', action: 'up', key: 'a', code: 'KeyA', keyCode: 65 });
  expect(up!.params).toMatchObject({ type: 'keyUp' });
  expect(up!.params.text).toBeUndefined();
});

test('inputToCdp: Enter/Tab keep the text form Chrome expects', () => {
  expect(inputToCdp({ type: 'key', action: 'down', key: 'Enter', keyCode: 13 })!.params.text).toBe('\r');
  expect(inputToCdp({ type: 'key', action: 'down', key: 'Tab', keyCode: 9 })!.params.text).toBe('\t');
});

test('inputToCdp: Ctrl/Meta held means a SHORTCUT, so no text is inserted', () => {
  // The bug this guards: Ctrl+C arriving as the literal letter "c" typed into
  // whatever has focus, instead of a copy.
  const ctrlC = inputToCdp({ type: 'key', action: 'down', key: 'c', code: 'KeyC', keyCode: 67, modifiers: { ctrl: true } });
  expect(ctrlC!.params.text).toBeUndefined();
  expect(ctrlC!.params.modifiers).toBe(2);
  const metaV = inputToCdp({ type: 'key', action: 'down', key: 'v', keyCode: 86, modifiers: { meta: true } });
  expect(metaV!.params.text).toBeUndefined();
  // Shift alone is not a shortcut — a capital letter must still type.
  const shiftA = inputToCdp({ type: 'key', action: 'down', key: 'A', keyCode: 65, modifiers: { shift: true } });
  expect(shiftA!.params.text).toBe('A');
  expect(shiftA!.params.modifiers).toBe(8);
});

test('inputToCdp: a multi-codepoint key (emoji, an IME string) is not mistaken for a named key', () => {
  // [...'😀'].length === 1 but '😀'.length === 2 — using .length here would
  // silently refuse to type any astral character.
  expect(inputToCdp({ type: 'key', action: 'down', key: '😀', keyCode: 0 })!.params.text).toBe('😀');
});

test('inputToCdp: a paste becomes Input.insertText, and an empty one is dropped', () => {
  expect(inputToCdp({ type: 'text', text: 'שלום' })).toEqual({ method: 'Input.insertText', params: { text: 'שלום' } });
  expect(inputToCdp({ type: 'text', text: '' })).toBeNull();
});

test('inputToCdp: junk from a newer/hostile client is dropped, never forwarded as a CDP call', () => {
  // The important half: a client cannot name an arbitrary CDP method through
  // this channel (Runtime.evaluate, Browser.close…) — only the three shapes
  // above are translatable, and the method name is chosen HERE.
  for (const junk of [null, undefined, 42, 'hello', {}, { type: 'evil', method: 'Runtime.evaluate' }, { type: 'mouse', action: 'teleport', x: 1, y: 1 }, { type: 'key', action: 'press', key: 'a' }]) {
    expect(inputToCdp(junk as any)).toBeNull();
  }
});

// ---- the transport descriptors ---------------------------------------------

test('native-window viewer(): screencast, interactive WITH a session, honest about browser-only scope', () => {
  const out = inChild(
    "const {createNativeDriver}=await import('./server/lib/screen-driver-native.ts');" +
    "const d=createNativeDriver();" +
    "emit({withSession: await d.viewer('s1'), global: await d.viewer(null)});"
  );
  expect(out.withSession).toMatchObject({ transport: 'screencast', interactive: true, scope: 'browser' });
  expect(out.withSession.path).toContain('/__screencast?session=s1');
  // No session = no page for CDP to aim at, so input has nowhere to go and
  // the client must not offer control.
  expect(out.global.interactive).toBe(false);
});

test('x11 viewer(): still rfb, interactive, whole-desktop scope — the bar the others are measured against', () => {
  const out = inChild(
    "const {createX11Driver}=await import('./server/lib/screen-driver-x11.ts');" +
    "emit(await createX11Driver().viewer('s1'));"
  );
  expect(out).toMatchObject({ transport: 'rfb', interactive: true, scope: 'desktop' });
  expect(out.path).toContain('/__vnc?session=s1');
});
