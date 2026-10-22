// A terminal on the desktops Arigami spawns (the global :99 and the per-session ones). The Docker image ships
// lxterminal, but nothing on a bare openbox + tint2 desktop launches it: tint2's stock config has no terminal icon and
// openbox's stock menu points at `x-terminal-emulator`, which a slim image may not have. This writes, under
// `<ARIGAMI_DIR>/desktop/`:
//   - `arigami-terminal`      a launcher script that picks whatever terminal exists (system choice first) and opens it
//                             in the session's working directory with a UTF-8 locale
//   - `terminal.desktop/.svg` the tint2 launcher icon for that script
//   - `tint2rc`(+`-clock`)    the stock tint2 config as a centred dock, terminal icon first, + an edge clock panel
//   - `openbox-rc.xml`/`openbox-menu.xml`  the stock openbox config whose right-click menu opens with "Terminal"
//   - lxterminal's defaults   (font, scrollback) — only when the user has no lxterminal config of their own
//   - on a per-session desktop: `arigami-chrome` + `session-chrome.desktop`, and `tint2rc-session` — the dock with
//     its browser icon(s) swapped for one that opens the SESSION's own Chrome (its profile, on its desktop), through
//     the host like browser_open. The system icon would start the default-profile Chrome, which on a host whose
//     owner already runs it just opens a window on the shared :99 and nothing on this desktop.
// The generated tint2/openbox configs are passed with `-c`/`--config-file`, and only when the user has no config of
// their own in ~/.config — a hand-tuned desktop on a bare-VM install is left exactly as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = 'Written by Arigami (server/lib/desktop-terminal.ts)';

/** The launcher script. Terminal choice, in order: $ARIGAMI_TERMINAL, the system's x-terminal-emulator, then common ones. */
export function terminalScript(): string {
  return `#!/bin/sh
# ${MARK} — regenerated at every desktop start.
# Opens a terminal on this desktop. Override the choice with ARIGAMI_TERMINAL="<command>".
case "\${LC_ALL:-\${LANG:-}}" in
  *UTF-8*|*utf8*|*UTF8*|*utf-8*) ;;
  *) LANG=C.UTF-8; export LANG; unset LC_ALL ;;
esac
if [ -n "\${ARIGAMI_TERMINAL_CWD:-}" ] && [ -d "$ARIGAMI_TERMINAL_CWD" ]; then cd "$ARIGAMI_TERMINAL_CWD"; else cd "$HOME" 2>/dev/null || cd /; fi
unset ARIGAMI_TERMINAL_CWD
if [ -n "\${ARIGAMI_TERMINAL:-}" ]; then exec sh -c "$ARIGAMI_TERMINAL"; fi
have() { command -v "$1" >/dev/null 2>&1; }
if have x-terminal-emulator; then exec x-terminal-emulator; fi
for t in lxterminal xfce4-terminal gnome-terminal konsole mate-terminal tilix kitty alacritty; do
  if have "$t"; then exec "$t"; fi
done
if have xterm; then exec xterm -u8 -fa Monospace -fs 11 -sl 10000 -xrm 'XTerm*selectToClipboard: true'; fi
if have urxvt; then exec urxvt -sl 10000; fi
msg="No terminal emulator is installed on this machine. Install one (e.g. lxterminal or xterm), or set ARIGAMI_TERMINAL."
if have xmessage; then exec xmessage -center "$msg"; fi
echo "$msg" >&2
exit 1
`;
}

/** A plain terminal glyph, so the launcher has an icon even where no icon theme is installed (the Docker image). */
export const TERMINAL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<rect x="3" y="7" width="42" height="34" rx="4" fill="#2b2b2b" stroke="#9a9a9a" stroke-width="2"/>
<path d="M11 18l7 6-7 6" fill="none" stroke="#e8e8e8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M22 31h13" stroke="#e8e8e8" stroke-width="3" stroke-linecap="round"/>
</svg>
`;

export function terminalDesktopEntry(script: string, icon: string): string {
  return `[Desktop Entry]
# ${MARK}
Type=Application
Name=Terminal
Comment=Open a terminal on this desktop
Exec="${script}"
Icon=${icon}
Terminal=false
Categories=System;TerminalEmulator;
`;
}

/** The session-desktop browser launcher: asks the host to open this session's Chrome (chrome.sh does the same). */
export function chromeScript(): string {
  return `#!/bin/sh
# ${MARK} — regenerated at every desktop start.
# Opens THIS session's own Chrome on this desktop: the host starts it on the session's profile (the browser the
# agent drives), or opens a new window in it when it is already running. Off a session desktop it starts a regular
# Chrome.
have() { command -v "$1" >/dev/null 2>&1; }
if [ -n "\${ARIGAMI_SESSION_ID:-}" ] && [ -n "\${ARIGAMI_URL:-}" ] && have curl; then
  if curl -sf -m 60 -X POST -H "Authorization: Bearer \${ARIGAMI_TOKEN:-}" -H 'Content-Type: application/json' -d '{"window":true}' \\
    "$ARIGAMI_URL/__api/sessions/$ARIGAMI_SESSION_ID/browser" >/dev/null; then exit 0; fi
  msg="Could not open this session's browser: the Arigami host did not answer."
  if have xmessage; then exec xmessage -center "$msg"; fi
  echo "$msg" >&2
  exit 1
fi
for b in "\${CHROME_BIN:-}" google-chrome-stable google-chrome chromium chromium-browser; do
  if [ -n "$b" ] && have "$b"; then exec "$b" "$@"; fi
done
exit 1
`;
}

export function chromeDesktopEntry(script: string, icon: string): string {
  return `[Desktop Entry]
# ${MARK}
Type=Application
Name=Browser
Comment=Open this session's browser
Exec="${script}"
Icon=${icon}
Terminal=false
Categories=Network;WebBrowser;
`;
}

// The stock and the users' docks name their browser by launcher file, bare or by path.
const BROWSER_LAUNCHER = /^launcher_item_app\s*=\s*\S*\b(?:google-chrome[\w.-]*|com\.google\.Chrome|chromium[\w.-]*|firefox[\w.-]*|iceweasel)\.desktop\s*$/;

/**
 * A session desktop's dock: `rc` with its browser launcher(s) replaced by one entry for the session's Chrome, in the
 * place of the first. Null when `rc` has no browser launcher — that dock is left as it is. Pure.
 */
export function sessionTint2Config(rc: string | null, browserEntry: string): string | null {
  if (!rc) return null;
  let swapped = false;
  const lines = rc.split('\n').flatMap((line) => {
    if (!BROWSER_LAUNCHER.test(line)) return [line];
    if (swapped) return [];
    swapped = true;
    return [`launcher_item_app = ${browserEntry}`];
  });
  return swapped ? `# ${MARK} — the session's own browser in the dock.\n${lines.join('\n')}` : null;
}

/** The icon the system Chrome (or Chromium) launcher uses, so the session's browser looks like a browser. */
function systemBrowserIcon(): string {
  for (const f of ['/usr/share/applications/google-chrome.desktop', '/usr/share/applications/chromium.desktop', '/usr/share/applications/chromium-browser.desktop']) {
    const m = /^Icon=(.+)$/m.exec(readOr(f) || '');
    if (m) return m[1].trim();
  }
  return 'web-browser';
}

// Panel look on top of the stock tint2rc: a 56px panel that shrinks to its content and sits centred at the bottom
// (a dock: launcher + open windows), 48px launcher icons, no "desktop 1" label. The clock is a second tint2 panel on
// the bottom-right edge (tint2ClockConfig) — one panel can't hold a centred launcher and an edge clock.
const TINT2_OVERRIDES: Record<string, string> = {
  panel_items: 'LT',
  panel_size: '100% 56',
  panel_shrink: '1',
  panel_position: 'bottom center horizontal',
  launcher_icon_size: '48',
  taskbar_name: '0',
};

/**
 * tint2 config = the stock one with the terminal entry first in `launcher` (the stock browser entries stay; tint2
 * skips the ones that aren't installed), tint2's own settings icon dropped, and TINT2_OVERRIDES applied. Null when
 * there's no stock config with a launcher to extend. Pure.
 */
export function tint2Config(stock: string | null, desktopEntry: string): string | null {
  if (!stock || !/^launcher_item_app\s*=/m.test(stock)) return null;
  const line = `launcher_item_app = ${desktopEntry}`;
  let body = stock
    .replace(/^launcher_item_app\s*=\s*tint2conf\.desktop\s*\n/m, '')
    .replace(/^launcher_item_app\s*=/m, `${line}\nlauncher_item_app =`);
  return `# ${MARK} from the stock tint2rc — terminal launcher first, centred dock.\n${withSettings(body, TINT2_OVERRIDES)}`;
}

/** The clock panel: the stock tint2rc showing only the clock, shrunk to it, on the bottom-right edge. Pure. */
export function tint2ClockConfig(stock: string | null): string | null {
  if (!stock) return null;
  const body = withSettings(stock, { ...TINT2_OVERRIDES, panel_items: 'C', panel_position: 'bottom right horizontal' });
  return `# ${MARK} from the stock tint2rc — the clock, bottom right.\n${body}`;
}

function withSettings(rc: string, settings: Record<string, string>): string {
  let body = rc;
  for (const [k, v] of Object.entries(settings)) {
    const re = new RegExp(`^${k}\\s*=.*$`, 'm');
    body = re.test(body) ? body.replace(re, `${k} = ${v}`) : `${body.replace(/\n?$/, '\n')}${k} = ${v}\n`;
  }
  return body;
}

/** openbox rc.xml = the stock one with its own `menu.xml` swapped for ours. Null when the stock file can't be adapted. Pure. */
export function openboxRc(stock: string | null, menuFile: string): string | null {
  if (!stock || !/<file>\s*menu\.xml\s*<\/file>/.test(stock)) return null;
  return stock.replace(/<file>\s*menu\.xml\s*<\/file>/, `<file>${xmlEscape(menuFile)}</file>`);
}

/** The right-click root menu: Terminal first. Pure. */
export function openboxMenu(script: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MARK} — regenerated at every desktop start. -->
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Terminal">
      <action name="Execute"><command>${xmlEscape(shQuote(script))}</command></action>
    </item>
    <separator />
    <item label="Reconfigure">
      <action name="Reconfigure" />
    </item>
  </menu>
</openbox_menu>
`;
}

/** lxterminal's defaults: a monospace font with fallback (Hebrew/Arabic render via Noto), long scrollback. */
export const LXTERMINAL_CONF = `# ${MARK} — only when no lxterminal config existed; yours to edit.
[general]
fontname=Monospace 11
scrollback=10000
geometry_columns=100
geometry_rows=30
cursorblinks=false
audiblebell=false
disablef10=true
`;

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface DesktopConfigOpts {
  dir: string; // where the generated files go (<ARIGAMI_DIR>/desktop)
  home?: string;
  env?: NodeJS.ProcessEnv;
  stockTint2rc?: string; // default /etc/xdg/tint2/tint2rc
  stockOpenboxRc?: string; // default /etc/xdg/openbox/rc.xml
  session?: boolean; // a per-session desktop: its dock's browser icon opens the session's Chrome
}

export interface DesktopConfig {
  terminal: string; // the launcher script
  tint2Args: string[][]; // one tint2 per entry; [[]] = a single tint2 on the user's own / stock config
  openboxArgs: string[];
}

function readOr(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function writeIfChanged(p: string, text: string, mode?: number): void {
  if (readOr(p) !== text) fs.writeFileSync(p, text);
  if (mode !== undefined) fs.chmodSync(p, mode);
}

/**
 * Write the terminal launcher + the tint2/openbox configs that surface it, and return the args to start tint2 and
 * openbox with. Never throws: a read-only dir just leaves the desktop on its stock configs.
 */
export function ensureDesktopConfig(opts: DesktopConfigOpts): DesktopConfig {
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const terminal = path.join(opts.dir, 'arigami-terminal');
  const out: DesktopConfig = { terminal, tint2Args: [[]], openboxArgs: [] };
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    writeIfChanged(terminal, terminalScript(), 0o755);
    const icon = path.join(opts.dir, 'terminal.svg');
    writeIfChanged(icon, TERMINAL_ICON_SVG);
    const entry = path.join(opts.dir, 'terminal.desktop');
    writeIfChanged(entry, terminalDesktopEntry(terminal, icon));

    // tint2 copies the stock config into ~/.config/tint2/tint2rc the first time it runs without `-c` (an older image,
    // a hand-started tint2). That copy is nobody's choice: treat it as no config of the user's own, or the desktop would
    // be stuck on the stock panel (no terminal, a settings icon, no dock) for good.
    const stock = readOr(opts.stockTint2rc || '/etc/xdg/tint2/tint2rc');
    const userTint2 = readOr(path.join(xdgConfig, 'tint2', 'tint2rc'));
    if (userTint2 === null || (stock !== null && userTint2 === stock)) {
      const rc = tint2Config(stock, entry);
      const clock = tint2ClockConfig(stock);
      if (rc && clock) {
        const p = path.join(opts.dir, 'tint2rc');
        const c = path.join(opts.dir, 'tint2rc-clock');
        writeIfChanged(p, rc);
        writeIfChanged(c, clock);
        out.tint2Args = [['-c', p], ['-c', c]];
      }
    }

    if (opts.session) {
      const script = path.join(opts.dir, 'arigami-chrome');
      writeIfChanged(script, chromeScript(), 0o755);
      const browserEntry = path.join(opts.dir, 'session-chrome.desktop');
      writeIfChanged(browserEntry, chromeDesktopEntry(script, systemBrowserIcon()));
      // The dock this desktop would run (the user's own, or the generated one), with the session's browser in it.
      const [first, ...rest] = out.tint2Args;
      const base = first.length ? readOr(first[1]) : userTint2 ?? stock;
      const rc = sessionTint2Config(base, browserEntry);
      if (rc) {
        const p = path.join(opts.dir, 'tint2rc-session');
        writeIfChanged(p, rc);
        out.tint2Args = [['-c', p], ...rest];
      }
    }

    const userOpenbox = ['rc.xml', 'menu.xml'].some((f) => fs.existsSync(path.join(xdgConfig, 'openbox', f)));
    if (!userOpenbox) {
      const menu = path.join(opts.dir, 'openbox-menu.xml');
      const rc = openboxRc(readOr(opts.stockOpenboxRc || '/etc/xdg/openbox/rc.xml'), menu);
      if (rc) {
        writeIfChanged(menu, openboxMenu(terminal));
        const p = path.join(opts.dir, 'openbox-rc.xml');
        writeIfChanged(p, rc);
        out.openboxArgs = ['--config-file', p];
      }
    }

    const lxconf = path.join(xdgConfig, 'lxterminal', 'lxterminal.conf');
    if (!fs.existsSync(lxconf)) {
      fs.mkdirSync(path.dirname(lxconf), { recursive: true });
      fs.writeFileSync(lxconf, LXTERMINAL_CONF);
    }
  } catch {
    /* read-only home/dir: the desktop still starts, on its stock configs */
  }
  return out;
}
