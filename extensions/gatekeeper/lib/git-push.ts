// Pushing a session's commits without giving the session a token — and without running the session's git config.
//
//   1. `git fetch <session repo> <ref>` into a bare mirror the GATEKEEPER owns ($DIR/git/<session>.git). Command-line
//      -c beats the repo's own config, so hooks, fsmonitor and pack-objects hooks the session may have planted in its
//      .git/config never run here.
//   2. `git push` from that mirror to https://github.com/<the one repo>.git, with the installation token in an
//      http.extraheader passed through GIT_CONFIG_* env of THIS child only — never argv, never the session's env.
//
// The destination URL is built here from the configured repo; a remote the session configured is never used.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DIR, redact } from './store.ts';

const SAFE = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'uploadpack.packObjectsHook=',
  '-c', 'protocol.file.allow=always',
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
];

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return { ...env, HOME: DIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', ...extra };
}

export function runGit(args: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('git', [...SAFE, ...args], { cwd: o.cwd || DIR, env: baseEnv(o.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs || 180_000);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out: redact(out), err: redact(err) });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 1, out: '', err: String(e.message) });
    });
  });
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/;

/** Bring `ref` of the session's repo into the mirror as refs/heads/<branch>; returns the commit sha. */
export async function fetchFromSession(mirror: string, sessionRepo: string, ref: string, branch: string): Promise<string> {
  if (!REF_RE.test(ref) || ref.includes('..')) throw new Error(`invalid ref "${ref.slice(0, 60)}"`);
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
    const init = await runGit(['init', '--bare', '--quiet', mirror]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.err.trim()}`);
  }
  const f = await runGit(['--git-dir', mirror, 'fetch', '--no-tags', '--quiet', '--no-recurse-submodules', sessionRepo, `+${ref}:refs/heads/${branch}`]);
  if (f.code !== 0) throw new Error(`could not read ${ref} from the session repo: ${f.err.trim().slice(0, 300)}`);
  const sha = await runGit(['--git-dir', mirror, 'rev-parse', `refs/heads/${branch}`]);
  if (sha.code !== 0) throw new Error('fetched ref has no commit');
  return sha.out.trim();
}

/** Push refs/heads/<branch> of the mirror to the one repo. `force` only when the config allows it. */
export async function pushToRepo(mirror: string, o: { webUrl: string; repo: string; branch: string; token: string; force: boolean }): Promise<{ ok: boolean; detail: string }> {
  const url = `${o.webUrl.replace(/\/+$/, '')}/${o.repo}.git`;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`;
  const r = await runGit(['--git-dir', mirror, 'push', '--no-verify', '--porcelain', url, `${o.force ? '+' : ''}refs/heads/${o.branch}:refs/heads/${o.branch}`], {
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${o.webUrl.replace(/\/+$/, '')}/.extraheader`, GIT_CONFIG_VALUE_0: header },
  });
  return { ok: r.code === 0, detail: (r.out + '\n' + r.err).trim().slice(0, 600) };
}
