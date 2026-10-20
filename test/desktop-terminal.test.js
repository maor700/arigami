// The desktop terminal (desktop-terminal.ts): the launcher script picks a terminal that exists, tint2/openbox get a
// "Terminal" entry through generated configs, and a user's own ~/.config is never overridden.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDesktopConfig, tint2Config, openboxRc, openboxMenu, terminalScript } from '../server/lib/desktop-terminal.ts';

const STOCK_TINT2 = 'panel_items = LTSC\npanel_size = 100% 30\npanel_shrink = 0\nlauncher_icon_size = 24\nlauncher_icon_theme_override = 0\nlauncher_item_app = tint2conf.desktop\nlauncher_item_app = google-chrome.desktop\n';
const STOCK_OPENBOX = '<openbox_config>\n<menu>\n  <file>/var/lib/openbox/debian-menu.xml</file>\n  <file>menu.xml</file>\n</menu>\n</openbox_config>\n';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-desktop-terminal-'));
}

function fixture() {
  const root = tmp();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'tint2rc'), STOCK_TINT2);
  fs.writeFileSync(path.join(root, 'rc.xml'), STOCK_OPENBOX);
  const run = () =>
    ensureDesktopConfig({
      dir: path.join(root, 'desktop'),
      env: { HOME: home },
      stockTint2rc: path.join(root, 'tint2rc'),
      stockOpenboxRc: path.join(root, 'rc.xml'),
    });
  return { root, home, run };
}

test('tint2Config: terminal first, no tint2 settings icon, a centred dock with 48px icons', () => {
  const rc = tint2Config(STOCK_TINT2, '/d/terminal.desktop');
  const items = rc.split('\n').filter((l) => l.startsWith('launcher_item_app'));
  expect(items).toEqual(['launcher_item_app = /d/terminal.desktop', 'launcher_item_app = google-chrome.desktop']);
  for (const l of ['panel_items = LTS', 'panel_size = 100% 56', 'panel_shrink = 1', 'launcher_icon_size = 48', 'panel_position = bottom center horizontal', 'taskbar_name = 0'])
    expect(rc.split('\n').filter((x) => x.startsWith(l.split(' =')[0] + ' '))).toEqual([l]);
  expect(tint2Config(null, '/x')).toBeNull();
  expect(tint2Config('panel_items = TSC\n', '/x')).toBeNull();
});

test('openboxRc swaps only the stock menu.xml for ours; openboxMenu opens with Terminal', () => {
  const rc = openboxRc(STOCK_OPENBOX, '/d/openbox-menu.xml');
  expect(rc).toContain('<file>/d/openbox-menu.xml</file>');
  expect(rc).toContain('<file>/var/lib/openbox/debian-menu.xml</file>');
  expect(rc).not.toContain('<file>menu.xml</file>');
  expect(openboxRc('<openbox_config/>', '/x')).toBeNull();
  const menu = openboxMenu("/a b/it's/arigami-terminal");
  expect(menu.indexOf('label="Terminal"')).toBeLessThan(menu.indexOf('<separator'));
  expect(menu).toContain('<command>\'/a b/it\'\\\'\'s/arigami-terminal\'</command>');
});

test('ensureDesktopConfig writes the launcher, icon, configs and lxterminal defaults; returns the args to use them', () => {
  const { root, home, run } = fixture();
  const conf = run();
  const dir = path.join(root, 'desktop');
  expect(conf.terminal).toBe(path.join(dir, 'arigami-terminal'));
  expect(fs.statSync(conf.terminal).mode & 0o111).toBeTruthy();
  expect(conf.tint2Args).toEqual(['-c', path.join(dir, 'tint2rc')]);
  expect(conf.openboxArgs).toEqual(['--config-file', path.join(dir, 'openbox-rc.xml')]);
  expect(fs.readFileSync(path.join(dir, 'tint2rc'), 'utf8')).toContain(`launcher_item_app = ${path.join(dir, 'terminal.desktop')}`);
  const entry = fs.readFileSync(path.join(dir, 'terminal.desktop'), 'utf8');
  expect(entry).toContain(`Exec="${conf.terminal}"`);
  expect(entry).toContain(`Icon=${path.join(dir, 'terminal.svg')}`);
  expect(fs.readFileSync(path.join(dir, 'openbox-rc.xml'), 'utf8')).toContain(path.join(dir, 'openbox-menu.xml'));
  expect(fs.readFileSync(path.join(home, '.config/lxterminal/lxterminal.conf'), 'utf8')).toMatch(/scrollback=10000/);
  // idempotent
  expect(run()).toEqual(conf);
});

test("a user's own tint2/openbox/lxterminal config is left alone", () => {
  const { home, run } = fixture();
  for (const f of ['tint2/tint2rc', 'openbox/menu.xml', 'lxterminal/lxterminal.conf']) {
    fs.mkdirSync(path.join(home, '.config', path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', f), 'mine');
  }
  const conf = run();
  expect(conf.tint2Args).toEqual([]);
  expect(conf.openboxArgs).toEqual([]);
  expect(fs.readFileSync(path.join(home, '.config/lxterminal/lxterminal.conf'), 'utf8')).toBe('mine');
});

test('no stock configs (non-Debian layout): no args, the launcher script is still there', () => {
  const root = tmp();
  const conf = ensureDesktopConfig({ dir: path.join(root, 'd'), env: { HOME: root }, stockTint2rc: '/nonexistent', stockOpenboxRc: '/nonexistent' });
  expect(conf.tint2Args).toEqual([]);
  expect(conf.openboxArgs).toEqual([]);
  expect(fs.existsSync(conf.terminal)).toBe(true);
});

// Run the real script against a PATH of fake terminals that print their name, cwd and LANG.
function runScript(fakes, env = {}) {
  const root = tmp();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const t of fakes) fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho "${t}|$(pwd)|$LANG|$*"\n`, { mode: 0o755 });
  fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  const script = path.join(root, 'arigami-terminal');
  fs.writeFileSync(script, terminalScript(), { mode: 0o755 });
  const r = spawnSync('/bin/sh', [script], { env: { PATH: bin, HOME: root, ...env }, encoding: 'utf8' });
  return { root, out: r.stdout.trim(), err: r.stderr.trim(), status: r.status };
}

const posix = process.platform === 'win32' ? test.skip : test;

posix('launcher script: system x-terminal-emulator wins, in the session cwd, with a UTF-8 locale', () => {
  const cwd = tmp();
  const { out } = runScript(['x-terminal-emulator', 'lxterminal'], { ARIGAMI_TERMINAL_CWD: cwd, LANG: 'C' });
  expect(out).toBe(`x-terminal-emulator|${fs.realpathSync(cwd)}|C.UTF-8|`);
});

posix('launcher script: falls back down the list, keeps an existing UTF-8 LANG, defaults to HOME', () => {
  const r = runScript(['xfce4-terminal', 'xterm'], { LANG: 'he_IL.UTF-8' });
  expect(r.out).toBe(`xfce4-terminal|${fs.realpathSync(r.root)}|he_IL.UTF-8|`);
  const x = runScript(['xterm']);
  expect(x.out.startsWith('xterm|')).toBe(true);
  expect(x.out).toContain('-u8');
});

posix('launcher script: ARIGAMI_TERMINAL overrides; nothing installed exits non-zero with a message', () => {
  expect(runScript(['lxterminal', 'mine'], { ARIGAMI_TERMINAL: 'mine --flag' }).out).toMatch(/^mine\|.*\|--flag$/);
  const none = runScript([]);
  expect(none.status).toBe(1);
  expect(none.err).toMatch(/No terminal emulator/);
});
