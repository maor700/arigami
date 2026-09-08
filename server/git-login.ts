// B3 — `gh auth login --web` driven from the cockpit (no TTY for the user).
// gh needs a real terminal for its prompts, so it runs under the same pty relay
// mcp-auth.js uses (lib/pty-bridge.py / winpty). We answer the "Press Enter to
// open github.com in your browser" prompt ourselves and surface the one-time
// device code + URL for the human to enter on any device.
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ptyArgs, which } from './lib/platform.js';
import { supervise, killTree } from './lib/children.js';
import { resourceRoot } from './lib/resource-root.js';

const BRIDGE = path.join(resourceRoot(), 'server', 'lib', 'pty-bridge.py');

export type GhLoginState = 'idle' | 'starting' | 'awaiting' | 'done' | 'error';
export interface GhLoginView {
  state: GhLoginState;
  code: string | null;
  url: string | null;
  error: string | null;
}

interface Flow extends GhLoginView {
  child?: ChildProcess;
  buf: string;
  timer?: NodeJS.Timeout;
  pressed?: boolean;
}

let flow: Flow | null = null;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const view = (f: Flow | null): GhLoginView =>
  f ? { state: f.state, code: f.code, url: f.url, error: f.error } : { state: 'idle', code: null, url: null, error: null };

export function ghLoginStatus(): GhLoginView {
  return view(flow);
}

export function cancelGhLogin(): GhLoginView {
  if (flow?.child?.pid) killTree(flow.child.pid);
  if (flow?.timer) clearTimeout(flow.timer);
  flow = null;
  return view(flow);
}

export function startGhLogin(): GhLoginView {
  if (flow && (flow.state === 'starting' || flow.state === 'awaiting')) return view(flow);
  const gh = which('gh');
  if (!gh) return { state: 'error', code: null, url: null, error: 'gh CLI is not installed — paste a token instead' };
  const f: Flow = { state: 'starting', code: null, url: null, error: null, buf: '' };
  let child: ChildProcess;
  try {
    const [bin, ...args] = ptyArgs(BRIDGE, [gh, 'auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key']);
    child = spawn(bin, args, { env: { ...process.env, GH_PROMPT_DISABLED: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    supervise(child, 'gh-login');
  } catch (e) {
    f.state = 'error';
    f.error = `could not start gh: ${e instanceof Error ? e.message : String(e)}`;
    return view(f);
  }
  f.child = child;
  flow = f;
  const onText = (d: Buffer | string): void => {
    f.buf = (f.buf + d.toString()).slice(-20_000);
    const clean = stripAnsi(f.buf);
    const code = clean.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
    if (code && !f.code) f.code = code[1].toUpperCase();
    const url = clean.match(/https:\/\/github\.com\/login\/device\S*/);
    if (url && !f.url) f.url = url[0];
    if (f.code && f.url && f.state === 'starting') f.state = 'awaiting';
    if (/press enter/i.test(clean) && !f.pressed) {
      f.pressed = true;
      try {
        child.stdin?.write('\n');
      } catch {
        /* ignore */
      }
    }
    if (/logged in as|authentication complete|✓ Logged in/i.test(clean)) f.state = 'done';
    if (/^\s*(error|X)\b.*$/im.test(clean) && f.state !== 'done') {
      const m = clean.split('\n').map((l) => l.trim()).filter((l) => /error/i.test(l)).pop();
      if (m) f.error = m.slice(0, 200);
    }
  };
  child.stdout?.on('data', onText);
  child.stderr?.on('data', onText);
  child.on('close', (code) => {
    if (f.timer) clearTimeout(f.timer);
    if (f.state === 'done') return;
    if (code === 0) f.state = 'done';
    else {
      f.state = 'error';
      f.error = f.error || stripAnsi(f.buf).split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ') || 'gh auth login failed';
    }
  });
  f.timer = setTimeout(() => {
    if (child.pid) killTree(child.pid);
    if (f.state !== 'done') {
      f.state = 'error';
      f.error = f.error || 'timed out waiting for the device code';
    }
  }, 15 * 60_000);
  f.timer.unref?.();
  return view(f);
}
