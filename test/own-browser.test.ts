// desktop "own" in a sandbox (server/session-profile.ts + server/lib/sandbox.ts): the session's own browser is the
// Playwright MCP inside its container — allowed with "own", denied with "none"; the host's browser/screen tools (which
// act outside the container) are denied in a sandbox; the injected browser never points at the owner's Chrome.
import { test, expect, describe, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './_tmp.js';
import * as sp from '../server/session-profile.ts';
import * as pol from '../server/agent-policy.ts';
import * as sbx from '../server/lib/sandbox.ts';

const prof = (desktop: 'none' | 'own' | 'shared', tools: string[] | null = ['git']) => sp.fromSpec({ name: 'p', tools, desktop });
const allows = (p: sp.SessionProfile | null, name: string) => pol.toolAllowed(sp.policyForSession(p ? { profile: p } : {}), name);
afterEach(() => sp.setSandboxedCheck(null));

describe('tool filter', () => {
  const PW = ['mcp__playwright__browser_navigate', 'mcp__playwright__browser_take_screenshot'];
  test('desktop "own" allows the own browser even when the allowlist does not name it; "none" denies it', () => {
    for (const t of PW) {
      expect(allows(prof('own'), t)).toBe(true);
      expect(allows(prof('shared'), t)).toBe(true);
      expect(allows(prof('none'), t)).toBe(false);
      expect(allows(prof('none', null), t)).toBe(false); // even with no allowlist layer at all
    }
  });
  test('in a sandbox the host-side browser and screen tools are denied, whatever the desktop mode', () => {
    sp.setSandboxedCheck(() => true);
    for (const t of ['browser_open', 'browser_navigate', 'capture_screen', 'desktop_keyboard', 'desktop_pointer', 'request_screen']) {
      expect(allows(prof('own'), t)).toBe(false);
      expect(allows(prof('shared'), t)).toBe(false);
    }
    expect(allows(prof('own'), 'mcp__playwright__browser_navigate')).toBe(true);
  });
  test('without a sandbox, desktop "own" keeps the host tools on its own Chrome (unchanged); the owner\'s stay denied', () => {
    expect(allows(prof('own'), 'browser_open')).toBe(true);
    expect(allows(prof('own'), 'capture_screen')).toBe(true);
    for (const t of ['sign_in', 'shared_desktop_acquire', 'vault_fill']) expect(allows(prof('own'), t)).toBe(false);
  });
  test('a Full session is untouched', () => {
    sp.setSandboxedCheck(() => true);
    expect(sp.policyForSession({})).toBe(null);
    expect(allows(null, 'browser_open')).toBe(true);
  });
  test('deny patterns hit only their server', () => {
    expect(allows(prof('none'), 'mcp__playwright-other__x')).toBe(false); // not allowlisted anyway
    expect(allows(prof('none', null), 'mcp__playwrightx__browser_navigate')).toBe(true);
  });
});

describe('the injected browser', () => {
  test('its config: headless Chromium, in-memory profile, the egress proxy with the session credentials — no CDP, no user data dir', () => {
    const c = sbx.ownBrowserConfig({ server: 'http://arigami-egress:3128', username: 's1', password: 'pw' }, '/tmp/out') as any;
    expect(c.browser.isolated).toBe(true);
    expect(c.browser.launchOptions.headless).toBe(true);
    expect(c.browser.launchOptions.proxy).toEqual({ server: 'http://arigami-egress:3128', username: 's1', password: 'pw', bypass: 'localhost,127.0.0.1' });
    const flat = JSON.stringify(c);
    for (const bad of ['userDataDir', 'cdpEndpoint', 'extension', 'google-chrome']) expect(flat).not.toContain(bad);
  });
  test('claude: added to the --mcp-config servers, the host server kept', () => {
    const args = ['-p', '--mcp-config', JSON.stringify({ mcpServers: { arigami: { type: 'http', url: 'u' } } }), '--strict-mcp-config'];
    const out = sbx.withOwnBrowser('claude', args, {}, '/h/conf.json');
    const cfg = JSON.parse(out[2]);
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['arigami', 'playwright']);
    expect(cfg.mcpServers.playwright).toEqual({ type: 'stdio', command: 'playwright-mcp', args: ['--config', '/h/conf.json'], env: { TMPDIR: '/tmp' } });
    expect(out.slice(3)).toEqual(['--strict-mcp-config']);
  });
  test('codex: one [mcp_servers.playwright] table appended to its own config.toml', () => {
    const home = tmpDir('cx-');
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.arigami]\nurl = "u"\n');
    sbx.withOwnBrowser('codex', ['app-server'], { CODEX_HOME: home }, '/h/conf.json');
    sbx.withOwnBrowser('codex', ['app-server'], { CODEX_HOME: home }, '/h/conf.json');
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(toml.match(/\[mcp_servers\.playwright\]/g)!.length).toBe(1);
    expect(toml).toContain('command = "playwright-mcp"');
    expect(toml).toContain('[mcp_servers.arigami]');
  });
});
