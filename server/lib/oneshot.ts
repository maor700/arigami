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
import { spawn } from 'node:child_process';
import { supervise, killTree } from './children.js';
import { tokenForSession, getActiveId } from '../accounts.js';
import { cfg } from './config.js';
import { auth } from '../auth.js';

function baseEnv(): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...rest } = process.env;
  return rest;
}

function accountEnv(): NodeJS.ProcessEnv {
  try {
    const r = tokenForSession(getActiveId());
    return r ? { CLAUDE_CODE_OAUTH_TOKEN: r.token } : {};
  } catch {
    return {};
  }
}

export interface OneShotOptions {
  model?: string; // default: 'sonnet'
  cwd?: string; // default: process.cwd()
  timeoutMs?: number; // default: 3 minutes
  tag?: string; // supervise() tag for the children.json record — default 'oneshot'
}

const STDERR_CAP = 20_000; // generous — this is for full diagnostic logging, not a UI-facing string

// Runs `claude -p <prompt>` headless (bypassPermissions, --output-format json)
// with the host's active-account auth, and resolves the unwrapped result text
// (the --output-format json envelope's `.result`, or raw stdout if the output
// wasn't that envelope). Rejects on a non-zero exit — the full stderr is always
// logged via console.error first (not just a truncated snippet in the Error),
// since auth/config failures like this one are otherwise invisible.
export function runClaudeOneShot(prompt: string, opts: OneShotOptions = {}): Promise<string> {
  const bin = process.env.ARIGAMI_CLAUDE_BIN || 'claude';
  const args = ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'json'];
  args.push('--model', opts.model || 'sonnet');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      env: {
        ...baseEnv(),
        ...accountEnv(),
        // C1: a one-shot has no session, so it gets the host-scoped internal
        // token — its MCP/curl calls back into the host still authenticate.
        ARIGAMI_URL: cfg.hostBase,
        ARIGAMI_TOKEN: auth.hostToken,
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
