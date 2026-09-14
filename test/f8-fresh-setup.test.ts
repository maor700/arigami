// F8 — fresh-install fixes (UX-FRESH-SETUP.md blockers), against a real host:
//   0. a full child forks its worktree from the CALLER's `cwd`, not the master's
//      (a master in a plain workspace folder used to 500 "not a git repository");
//   1. minimal onboarding is the recorded default: onboarding.json carries
//      mode:'minimal', required = [pair, claude], "Run full setup" flips it;
//   3. WhatsApp tool calls answer {needs_setup:'whatsapp'} while the bridge is
//      down (host-mcp `whatsapp` tool → POST /__api/whatsapp/tool);
//   4. the first turn introduces Arigami (identity reminder + connectable list).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess | null = null;
let base = '';
let dir = '';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-F8-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_FUNNEL_QUIET: '1',
      ARIGAMI_ONBOARDING_MODE: '',
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_WA_MCP_DIR: path.join(dir, 'wa-mcp-missing'),
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      ARIGAMI_REPOS_DIR: path.join(dir, 'repos'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => (log += d));
  host.stderr!.on('data', (d) => (log += d));
  try {
    await until(async () => { try { return (await fetch(base + '/__api/config')).ok; } catch { return false; } }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default
afterAll(() => { try { host?.kill('SIGTERM'); } catch {} });

// ---- 1. minimal mode is the recorded default -------------------------------
test('fresh install: wizard is minimal, onboarding.json records mode:minimal, Run-full-setup flips it', async () => {
  const w = (await api('GET', '/__api/onboarding/wizard')).json;
  expect(w.mode).toBe('minimal');
  expect(w.required).toEqual(['pair', 'claude']);
  expect(w.done).toBe(false);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'onboarding.json'), 'utf8'));
  expect(file.mode).toBe('minimal');
  const full = (await api('POST', '/__api/onboarding/wizard/mode', { mode: 'full' })).json;
  expect(full.mode).toBe('full');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'onboarding.json'), 'utf8')).mode).toBe('full');
  const back = (await api('POST', '/__api/onboarding/wizard/mode', { mode: 'minimal' })).json;
  expect(back.mode).toBe('minimal');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'onboarding.json'), 'utf8')).mode).toBe('minimal');
});

// ---- 0. full child worktree from the caller's cwd ---------------------------
test('create_session kind:full from a non-repo master forks the worktree from the `cwd` argument', async () => {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const master = await api('POST', '/__api/sessions', { title: 'master', cwd: workspace });
  expect(master.status).toBe(201);
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');

  const child = await api('POST', '/__api/sessions', { master: master.json.id, kind: 'full', subtask: 'F8-child', cwd: repo });
  expect(child.status).toBe(201);
  const md = child.json.metadata;
  expect(md.role).toBe('child');
  expect(md.kind).toBe('full');
  expect(md.base).toBe('main');
  expect(md.branch).toMatch(/^child\/F8-child-/);
  expect(md.worktree).toBe(path.join(dir, 'repos', 'proj-wt-F8-child'));
  expect(child.json.cwd).toBe(md.worktree);
  expect(fs.existsSync(path.join(md.worktree, 'a.txt'))).toBe(true);
  expect(git(repo, 'worktree', 'list')).toContain(md.worktree);

  // metadata.repo works the same way; and with neither, a non-repo master still fails loudly.
  const viaMeta = await api('POST', '/__api/sessions', { master: master.json.id, kind: 'full', subtask: 'F8-meta', metadata: { repo: repo } });
  expect(viaMeta.status).toBe(201);
  expect(viaMeta.json.metadata.worktree).toBe(path.join(dir, 'repos', 'proj-wt-F8-meta'));
  const bare = await api('POST', '/__api/sessions', { master: master.json.id, kind: 'full', subtask: 'F8-none' });
  expect(bare.status).toBe(500);
  expect(bare.text).toMatch(/not a git repository/);
});

// ---- 3. WhatsApp JIT --------------------------------------------------------
test('whatsapp tool: bridge down → needs_setup (never "no access"); unknown tool → error; host-mcp exposes it', async () => {
  const r = (await api('POST', '/__api/whatsapp/tool', { tool: 'list_chats', args: { limit: 5 }, why: 'read your chats' })).json;
  expect(r).toEqual({ needs_setup: 'whatsapp', why: 'read your chats', hint: 'call request_setup' });
  const bad = (await api('POST', '/__api/whatsapp/tool', { tool: 'nuke' })).json;
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/unknown whatsapp tool/);
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp', 'host-mcp.js'), 'utf8');
  expect(mcp).toMatch(/name: 'whatsapp'/);
  expect(mcp).toMatch(/\/__api\/whatsapp\/tool/);
  expect(mcp).toMatch(/needs_setup:"whatsapp"/);
});

// ---- 4. first-turn identity + connectable capabilities ----------------------
test('first turn introduces Arigami (not "I am Claude") and lists connectable capabilities', () => {
  const r = runInChild(
    "const c=await import('./server/claude.js');const hint=await c.refreshCapabilitiesHint();emit({text:c.identityReminder(hint),hint});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'), COMPOSIO_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '', ARIGAMI_FUNNEL_QUIET: '1' }
  );
  expect(r.ok).toBe(true);
  const { text, hint } = r.out[0];
  expect(text).toMatch(/You are the agent inside Arigami/);
  expect(text).toMatch(/not by the name of the CLI\/model behind you \("Claude", "Codex"\)/); // engine-aware wording since the Codex engine
  expect(text).toMatch(/WhatsApp/);
  expect(text).toMatch(/language the human writes in/);
  expect(hint).toMatch(/needs_setup/);
  expect(hint).toMatch(/whatsapp/);
  expect(text).toContain(hint);
});

// ---- 2. PKCE: callback read-out surfaces as a real route ---------------------
test('oauth read-browser: unknown flow / no session desktop are clean errors, not 500s', async () => {
  const r = await api('POST', '/__api/accounts/oauth/read-browser', { id: 'oauth_nope' });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: false, error: 'unknown login flow' });
  const started = (await api('POST', '/__api/accounts/oauth/start', { label: 't' })).json;
  expect(started.state).toBe('awaiting-code');
  const noSess = (await api('POST', '/__api/accounts/oauth/read-browser', { id: started.id })).json;
  expect(noSess.ok).toBe(false);
  expect(noSess.error).toMatch(/no session desktop/);
  await api('POST', '/__api/accounts/oauth/cancel', { id: started.id });
});

// ---- "Not logged in" from the CLI → Connect-Claude card, not a dead end ----
test('AUTH_RE catches the CLI "Not logged in · Please run /login" text', () => {
  const r = runInChild("const c=await import('./server/claude.js');emit({m:c.AUTH_RE.test('Not logged in · Please run /login'), m2:c.AUTH_RE.test('all good')});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_FUNNEL_QUIET: '1' });
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ m: true, m2: false });
});
