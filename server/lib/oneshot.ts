// Shared runner for one-shot, non-interactive `claude -p` calls — used by any
// server module that needs a single headless completion outside a live session
// process (skills.ts's analyze(), memory.ts's episode hook).
//
// THE BUG THIS FIXES: a session's claude proc gets its auth two ways
// (claude.js) — baseEnv() strips any inherited CLAUDE_CODE_OAUTH_TOKEN (so a
// stray token from the shell that launched the host can't silently pin every
// session to one account), then accountEnv() injects the session's OWN
// resolved token. A one-shot spawned with plain `env: {...process.env}` gets
// neither: no session to resolve a token FROM, and nothing strips the (usually
// absent, sometimes stale) inherited token either way — it just runs with
// whatever auth happens to be in the host process's own environment, which is
// normally none, and fails with "claude exited 1". This helper resolves the
// same way a session does, just against the ACTIVE account instead of a
// per-session assignment (there is no session).
//
// runOneShot() picks the engine: claude = `claude -p`, codex = `codex exec --ephemeral`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supervise, killTree } from './children.js';
import { tokenForSession, getActiveId, hasCredentials, codexAuthPathFor } from '../accounts.js';
import { claudeBin } from './claude-bin.js';
import { cfg } from './config.js';
import { auth } from '../auth.js';

function baseEnv(): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...rest } = process.env;
  return rest;
}

// Resolved AT CALL TIME (never cached across runs): the active account may be
// switched, or its token refreshed by the oauth refresher, between two one-shots
// — a token captured once at boot would go stale (F3 #7: "OAuth access token
// has been revoked" from the episode hook right after a restart).
function accountEnv(opts: OneShotOptions): NodeJS.ProcessEnv {
  if (opts.apiKey) return { ANTHROPIC_API_KEY: opts.apiKey };
  if (opts.token) return { CLAUDE_CODE_OAUTH_TOKEN: opts.token };
  try {
    const r = tokenForSession(opts.account ?? getActiveId());
    return r ? { CLAUDE_CODE_OAUTH_TOKEN: r.token } : {};
  } catch {
    return {};
  }
}

// What `claude -p` says when its bearer token is dead. Matched on the
// --output-format json envelope's `.result` (plus stderr) of a failed run.
const AUTH_FAILURE = /\b401\b|revoked|expired|invalid.?(?:token|grant)|not logged in|authentication.?(?:failed|error)|unauthori[sz]ed/i;
export function isAuthFailure(reason: string): boolean {
  return AUTH_FAILURE.test(reason || '');
}

// Try to renew the active account's access token (oauth-login accounts carry a
// refresh token). Returns true when a NEW token is now stored — the caller
// re-resolves it via accountEnv() on the retry.
async function refreshActiveToken(opts: OneShotOptions): Promise<boolean> {
  try {
    const a = tokenForSession(opts.account ?? getActiveId())?.account;
    if (!a || a.type !== 'oauth-token' || !a.refreshToken) return false;
    const o = await import('../oauth-login.js');
    return !!(await (o as any).refreshOne(a.id));
  } catch {
    return false;
  }
}

export type OneShotEngine = 'claude' | 'codex';

export interface OneShotOptions {
  engine?: OneShotEngine; // default: 'claude'
  model?: string; // claude default 'sonnet'; codex: only gpt/codex/o* names pass, else codex's default
  effort?: string; // codex model_reasoning_effort — default 'low'
  json?: object; // JSON Schema for the final message (codex --output-schema; claude relies on the prompt)
  account?: string | null; // account id to run as (pinned session account); default the active one
  env?: Record<string, string>; // extra env, e.g. a session's ARIGAMI_SESSION_ID/TOKEN
  mcpServers?: Record<string, any>; // {command,args,env?} servers — replaces the user's global MCP set
  pluginDirs?: string[]; // claude only
  cwd?: string; // default: process.cwd()
  timeoutMs?: number; // default: 3 minutes
  tag?: string; // supervise() tag for the children.json record — default 'oneshot'
  // Explicit credential for THIS run instead of the active account (used to
  // verify a pasted token before it becomes an account — onboarding.ts).
  token?: string;
  apiKey?: string;
  // Internal: set on the retry after a token refresh so we don't loop.
  _retried?: boolean;
}

const STDERR_CAP = 20_000; // generous — this is for full diagnostic logging, not a UI-facing string

// Runs `claude -p <prompt>` headless (bypassPermissions, --output-format json)
// with the host's active-account auth, and resolves the unwrapped result text
// (the --output-format json envelope's `.result`, or raw stdout if the output
// wasn't that envelope). Rejects on a non-zero exit — the full stderr is always
// logged via console.error first (not just a truncated snippet in the Error),
// since auth/config failures like this one are otherwise invisible.
//
// F3 #7: when the run fails with an auth error (revoked/expired token — e.g.
// the episode hook fired before the boot-time token refresh finished) and the
// active account has a refresh token, refresh it once and retry once with the
// freshly resolved token. Explicit `opts.token`/`opts.apiKey` runs never retry.
export async function runClaudeOneShot(prompt: string, opts: OneShotOptions = {}): Promise<string> {
  return runOneShot(prompt, { ...opts, engine: 'claude' });
}

/** One headless completion on `opts.engine`; resolves the final message text. */
export async function runOneShot(prompt: string, opts: OneShotOptions = {}): Promise<string> {
  if (opts.engine === 'codex') return runCodexOnce(prompt, opts);
  try {
    return await runOnce(prompt, opts);
  } catch (e: any) {
    const explicit = !!(opts.token || opts.apiKey);
    if (opts._retried || explicit || !isAuthFailure(String(e?.message || ''))) throw e;
    if (!(await refreshActiveToken(opts))) throw e;
    console.warn('[oneshot] auth failure — token refreshed, retrying once');
    return runOnce(prompt, { ...opts, _retried: true });
  }
}

function runOnce(prompt: string, opts: OneShotOptions): Promise<string> {
  const bin = claudeBin();
  const args = ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'json'];
  args.push('--model', opts.model || 'sonnet');
  if (opts.mcpServers) args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }), '--strict-mcp-config');
  for (const d of opts.pluginDirs || []) args.push('--plugin-dir', d);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      env: {
        ...baseEnv(),
        ...accountEnv(opts),
        // C1: a one-shot has no session, so it gets the host-scoped internal
        // token — its MCP/curl calls back into the host still authenticate.
        ARIGAMI_URL: cfg.hostBase,
        ARIGAMI_TOKEN: auth.hostToken,
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    supervise(child, opts.tag || 'oneshot');
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-STDERR_CAP); });
    // killTree, not child.kill: a one-shot run has its own MCP/tool children.
    const guard = setTimeout(() => killTree(child.pid), opts.timeoutMs || 3 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(guard); reject(e); });
    child.on('close', (code) => {
      clearTimeout(guard);
      if (code) {
        // The interesting failures here (no credentials, quota, etc.) exit 1
        // with EMPTY stderr — `claude`'s own error ("Not logged in · Please
        // run /login") lands in the --output-format json envelope on STDOUT
        // (`is_error:true`, `.result`), not stderr. Surface that first; fall
        // back to stderr, then a bare exit code, and always log everything
        // captured (not just a truncated snippet) so this failure mode is
        // diagnosable instead of a bare "claude exited 1".
        let reason = '';
        try {
          const env = JSON.parse(out);
          if (env && env.is_error && typeof env.result === 'string') reason = env.result;
        } catch { /* not the envelope */ }
        if (!reason) reason = err.trim();
        console.error(`[oneshot] claude exited ${code}${reason ? ': ' + reason : ''}\nstdout:\n${out}\nstderr:\n${err}`);
        return reject(new Error(`claude exited ${code}${reason ? ': ' + reason.slice(0, 500) : ''}`));
      }
      // --output-format json wraps the run; the final text is in .result.
      let text = out;
      try {
        const env = JSON.parse(out);
        if (env && typeof env.result === 'string') text = env.result;
      } catch { /* not the envelope — treat stdout as the text */ }
      resolve(text);
    });
  });
}

// ---- codex ------------------------------------------------------------------

const CODEX_MODEL_RE = /^(?:gpt|codex|o[0-9])[a-zA-Z0-9._-]*$/;
const tstr = (v: unknown): string => JSON.stringify(String(v ?? ''));
const tkey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tstr(k));

function codexConfig(cwd: string, servers: Record<string, any> = {}): string {
  const out = [`[projects.${tstr(cwd)}]`, 'trust_level = "trusted"', ''];
  for (const [name, sv] of Object.entries(servers)) {
    if (!sv || typeof sv.command !== 'string') continue;
    out.push(`[mcp_servers.${tkey(name)}]`, `command = ${tstr(sv.command)}`, `args = [${(sv.args || []).map(tstr).join(', ')}]`, '');
    if (sv.env && typeof sv.env === 'object') {
      out.push(`[mcp_servers.${tkey(name)}.env]`);
      for (const [k, v] of Object.entries(sv.env)) out.push(`${tkey(k)} = ${tstr(v)}`);
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

// Scratch $CODEX_HOME under $ARIGAMI_DIR (codex warns about PATH aliases for a home under /tmp).
function scratchCodexHome(tag: string): string {
  const root = path.join(cfg.configDir || os.homedir(), 'oneshot-codex');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${tag.replace(/[^\w-]/g, '_')}-`));
}

async function runCodexOnce(prompt: string, opts: OneShotOptions): Promise<string> {
  const authSrc = codexAuthPathFor(opts.account ?? null);
  if (!authSrc) throw new Error('codex: no Codex account is connected');
  const cwd = opts.cwd || process.cwd();
  const home = scratchCodexHome(opts.tag || 'oneshot');
  try {
    fs.symlinkSync(authSrc, path.join(home, 'auth.json'));
    fs.writeFileSync(path.join(home, 'config.toml'), codexConfig(cwd, opts.mcpServers));
    const outFile = path.join(home, 'last-message.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-o', outFile];
    if (opts.model && CODEX_MODEL_RE.test(opts.model)) args.push('-m', opts.model);
    args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort || 'low')}`);
    if (opts.json) {
      const schema = path.join(home, 'schema.json');
      fs.writeFileSync(schema, JSON.stringify(opts.json));
      args.push('--output-schema', schema);
    }
    args.push('-');
    const { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...rest } = process.env;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.ARIGAMI_CODEX_BIN || 'codex', args, {
        cwd,
        env: { ...rest, CODEX_HOME: home, ARIGAMI_URL: cfg.hostBase, ARIGAMI_TOKEN: auth.hostToken, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      supervise(child, opts.tag || 'oneshot');
      let err = '';
      const keep = (d: any) => { err = (err + d).slice(-STDERR_CAP); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.stdin.on('error', () => {});
      child.stdin.end(prompt); // EOF starts the turn; an open stdin hangs codex
      const guard = setTimeout(() => killTree(child.pid), opts.timeoutMs || 3 * 60 * 1000);
      child.on('error', (e) => { clearTimeout(guard); reject(e); });
      child.on('close', (c) => {
        clearTimeout(guard);
        if (c) {
          console.error(`[oneshot] codex exited ${c}\n${err}`);
          const line = err.trim().split('\n').filter((l) => /error/i.test(l)).pop() || err.trim().split('\n').pop() || '';
          return reject(new Error(`codex exited ${c}${line ? ': ' + line.slice(0, 500) : ''}`));
        }
        resolve();
      });
    });
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---- engine routing ---------------------------------------------------------

/** Engine for a host-level utility: cfg.defaultEngine, else the first engine with an account (claude first). */
export function hostEngine(): OneShotEngine {
  const d = (cfg as any).defaultEngine;
  if (d === 'claude' || d === 'codex') return d;
  try {
    if (hasCredentials('claude')) return 'claude';
    if (hasCredentials('codex')) return 'codex';
  } catch { /* accounts not loaded */ }
  return 'claude';
}

/** Engine for a utility about a session: the session's own engine. */
export function sessionEngine(s: { engine?: string | null } | null | undefined): OneShotEngine {
  return s?.engine === 'codex' ? 'codex' : 'claude';
}
