// A3 guard: no `http://localhost:<port>` link may leave the host toward a human.
// Every match of a loopback URL in server/, mcp/ and skills/ must be on the
// allowlist below (internal host→self fetches, OAuth redirect fallbacks, log
// lines, doc prose). Anything new fails here — build a relative path with
// server/lib/public-url.ts (publicUrl/sessionPath) instead.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [file, substring the matching line must contain]
const ALLOW = [
  ['server/lib/config.ts', 'hostBase:'], // the internal base itself
  ['server/lib/public-url.ts', 'cfg.hostBase ||'], // absoluteUrl() loopback fallback
  ['server/claude.js', 'ARIGAMI_URL: cfg.hostBase ||'], // internal env for the agent
  ['server/claude.js', 'pass http://localhost:$PORT'], // guidance: give it to open_tab, not the human
  ['server/lib/chrome-cdp.ts', '/json/list'], // F8: loopback DevTools port of the session Chrome — host-internal
  ['server/index.ts', '[host] arigami up on'], // boot log line
  ['server/linear-mcp.ts', 'fallbackOrigin = ()'], // OAuth redirect_uri must be absolute
  ['server/proxy.ts', 'req.headers.host ||'], // request-URL parsing base
  ['server/pages.js', 'req.headers.host ||'], // request-URL parsing base
  ['server/api.ts', 'req.headers.host ||'], // request-URL parsing base
  ['server/api.ts', "new URL(req.url || '/', 'http://localhost')"], // URL parsing base
  ['server/vnc.ts', "new URL(req.url || '/', 'http://localhost')"], // URL parsing base
  ['server/screencast.ts', "new URL(req.url || '/', 'http://localhost')"], // URL parsing base
  ['server/remote.js', 'tailscale'], // hands the loopback to `tailscale serve`
  ['server/remote.js', "'serve', '--bg'"],
  ['server/voice.js', '"open localhost:3000"'], // prose example in the voice router prompt
  ['mcp/host-mcp.js', "const HOST = process.env.ARIGAMI_URL"], // internal fetch base
  ['mcp/policy-hook.js', "const HOST = process.env.ARIGAMI_URL"], // A3 hook: internal fetch base
  ['mcp/ext-mcp.js', "const HOST = process.env.ARIGAMI_URL"], // EXT tool wrapper: internal fetch base
  ['server/codex-account.ts', "const LOOPBACK = 'http://127.0.0.1:1455/auth/callback'"], // Codex's own OAuth callback — host-internal loopback
  ['mcp/host-mcp.js', 'url:"http://localhost:<port>"'], // allocate_port guidance → open_tab
  ['mcp/host-mcp.js', 'pass its http://localhost:<port> URL here'], // open_tab guidance
  ['mcp/host-mcp.js', 'never prefix it with http://localhost'],
  // Skill guidance: the loopback URL goes INTO open_tab (host proxies it), not to the human.
  ['skills/machine-work/SKILL.md', 'open_tab({type:"url", url:"http://localhost:$PORT"})'],
  ['skills/dispatch/SKILL.md', 'open_tab({type:"url", url:"http://localhost:$PORT"})'],
  ['skills/project-manager/SKILL.md', 'open_tab({type:"url", url:"http://localhost:$PORT"})'],
];

const RE = /https?:\/\/(localhost|127\.0\.0\.1)(:\$\{[^}]+\}|:\d+|:\$?[A-Z_]*PORT\b|(?=[\/'"`\s)<]))/;

function* files(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* files(rel); continue; }
    if (/\.(ts|js|md|json)$/.test(e.name) && !e.name.endsWith('.test.js')) yield rel;
  }
}

test('no outgoing http://localhost links in server/, mcp/, skills/, .claude-plugin/', () => {
  const offenders = [];
  for (const dir of ['server', 'mcp', 'skills', '.claude-plugin']) {
    for (const f of files(dir)) {
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!RE.test(line)) return;
        if (ALLOW.some(([af, needle]) => af === f && line.includes(needle))) return;
        offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  expect(offenders).toEqual([]);
});

test('create_session result url is host-relative (no origin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp/host-mcp.js'), 'utf8');
  expect(src).not.toMatch(/url: `\$\{HOST\}/);
  expect(src).toMatch(/const url = `\$\{PUBLIC_PATH\}\?session=/);
});

test('publicUrl(): relative by default, absolute only with ARIGAMI_PUBLIC_URL', async () => {
  const { runInChild } = await import('./_child.js');
  const body =
    "const {publicUrl,sessionPath,absoluteUrl}=await import('./server/lib/public-url.js');" +
    "emit({a:publicUrl('/__host/?session=x'),b:sessionPath('a b'),c:absoluteUrl('/__host/'),d:publicUrl('https://ext/x')});";
  const rel = runInChild(body, { ARIGAMI_PUBLIC_URL: '', ARIGAMI_PORT: '3497' });
  expect(rel.ok).toBe(true);
  expect(rel.out[0].a).toBe('/__host/?session=x');
  expect(rel.out[0].b).toBe('/__host/#/session/a%20b');
  expect(rel.out[0].c).toBe('http://127.0.0.1:3497/__host/'); // C1: hostBase is the loopback bind, never 'localhost'
  expect(rel.out[0].d).toBe('https://ext/x');
  const abs = runInChild(body, { ARIGAMI_PUBLIC_URL: 'https://example.invalid/', ARIGAMI_PORT: '3497' });
  expect(abs.ok).toBe(true);
  expect(abs.out[0].a).toBe('https://example.invalid/__host/?session=x');
  expect(abs.out[0].c).toBe('https://example.invalid/__host/');
});
