// Desktop control: engine-neutral screenshot + pointer/keyboard tools on the session's own desktop.
// The display-free parts are tested here: argv mapping for xinput.py, validation, and the MCP image block.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { xinputArgs, XINPUT } = await import(path.join(ROOT, 'server/lib/desktop-control.ts'));
const { toMcpContent } = await import(path.join(ROOT, 'mcp/host-mcp.js'));

test('xinputArgs maps every action to the xinput.py verbs (screen pixels, rounded)', () => {
  expect(xinputArgs({ action: 'move', x: 10.4, y: 20.6 })).toEqual(['move', '10', '21']);
  expect(xinputArgs({ action: 'click', x: 1, y: 2 })).toEqual(['click', '1', '2', '1']);
  expect(xinputArgs({ action: 'middle_click', x: 1, y: 2 })).toEqual(['click', '1', '2', '2']);
  expect(xinputArgs({ action: 'right_click', x: 1, y: 2 })).toEqual(['click', '1', '2', '3']);
  expect(xinputArgs({ action: 'double_click', x: 3, y: 4 })).toEqual(['dblclick', '3', '4']);
  expect(xinputArgs({ action: 'drag', x: 1, y: 2, x2: 30, y2: 40 })).toEqual(['drag', '1', '2', '30', '40']);
  expect(xinputArgs({ action: 'scroll', x: 5, y: 6, dy: -3 })).toEqual(['scroll', '5', '6', '-3']);
  expect(xinputArgs({ action: 'type', text: 'https://x.test/a?b=1' })).toEqual(['type', 'https://x.test/a?b=1']);
  expect(xinputArgs({ action: 'key', key: 'ctrl+l' })).toEqual(['key', 'ctrl+l']);
});

test('xinputArgs rejects bad input before anything runs', () => {
  expect(() => xinputArgs({ action: 'click', x: 'a', y: 2 })).toThrow('x must be a number');
  expect(() => xinputArgs({ action: 'drag', x: 1, y: 2 })).toThrow('x2 must be a number');
  expect(() => xinputArgs({ action: 'type', text: '' })).toThrow('empty');
  expect(() => xinputArgs({ action: 'type', text: 'a'.repeat(2001) })).toThrow('too long');
  expect(() => xinputArgs({ action: 'key', key: ' ' })).toThrow('empty');
  expect(() => xinputArgs({ action: 'fly' })).toThrow('unknown action');
});

test('the xinput helper the tools call is the one shipped with the host (not a path a session has to guess)', async () => {
  const fs = await import('node:fs');
  expect(fs.existsSync(XINPUT)).toBe(true);
  const src = fs.readFileSync(XINPUT, 'utf8');
  for (const verb of ['drag', 'scroll', 'dblclick', 'key', 'type']) expect(src).toContain(`cmd == '${verb}'`);
});

test('toMcpContent: an __image result becomes a real image block + JSON text; a plain result stays text', () => {
  const img = toMcpContent({ __image: { data: 'QUJD', mimeType: 'image/png' }, ok: true, width: 10 });
  expect(img[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
  expect(JSON.parse(img[1].text)).toEqual({ ok: true, width: 10 }); // the image bytes are not repeated in the text
  expect(toMcpContent({ ok: true })).toEqual([{ type: 'text', text: '{"ok":true}' }]);
  expect(toMcpContent(undefined)).toEqual([{ type: 'text', text: '{"ok":true}' }]);
});
