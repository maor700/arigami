// Repo source for a restricted session, without giving it a token or github.com (github_checkout).
//
//   1. The gatekeeper fetches the ONE configured repo into its own bare mirror ($DIR/git/upstream/<owner>__<name>.git),
//      the installation token in an http.extraheader passed through GIT_CONFIG_* env of that one git process (as
//      github_push does). The URL is built from the config; nothing the session says can point it elsewhere.
//   2. First checkout: cloned from that mirror and checked out in a gatekeeper-PRIVATE temp dir — the session cannot
//      touch its config while git runs there — with origin set to the plain https URL of the repo (no token in it, no
//      credential config), then copied into the session's own directory. Nothing in the session dir is overwritten.
//   3. Later fetches: the gatekeeper never runs git inside a repo the session controls (its .git/config could make git
//      run a command in the host's process: core.fsmonitor, core.alternateRefsCommand, filter drivers…). It writes a
//      fresh bundle of the mirror into the checkout's own .git; the session fetches from that file itself, locally,
//      inside its sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR } from './store.ts';
import { runGit } from './git-push.ts';

export const BUNDLE_NAME = 'arigami-origin.bundle';
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;

export const upstreamMirror = (repo: string): string => path.join(DIR, 'git', 'upstream', `${repo.replace(/[^A-Za-z0-9._-]/g, '__')}.git`);
export const originUrl = (webUrl: string, repo: string): string => `${webUrl.replace(/\/+$/, '')}/${repo}.git`;

// One fetch of the mirror at a time (concurrent sessions would race on its refs/locks).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/** Bring every branch and tag of the one repo into the gatekeeper's mirror. */
export function fetchUpstream(o: { webUrl: string; repo: string; token: string }): Promise<string> {
  return serial(async () => {
    const mirror = upstreamMirror(o.repo);
    if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
      fs.mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
      const init = await runGit(['init', '--bare', '--quiet', mirror]);
      if (init.code !== 0) throw new Error(`git init failed: ${init.err.trim()}`);
    }
    const base = o.webUrl.replace(/\/+$/, '');
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`;
    const f = await runGit(['--git-dir', mirror, 'fetch', '--prune', '--no-recurse-submodules', '--quiet', originUrl(base, o.repo), '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], {
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${base}/.extraheader`, GIT_CONFIG_VALUE_0: header },
    });
    if (f.code !== 0) throw new Error(`could not fetch ${o.repo}: ${f.err.trim().slice(0, 300)}`);
    return mirror;
  });
}

/** A branch, tag or commit of the mirror → { sha, branch (when it is one) }. */
export async function resolveRef(mirror: string, ref: string): Promise<{ sha: string; branch: string | null }> {
  if (!REF_RE.test(ref) || ref.includes('..')) throw new Error(`invalid ref "${ref.slice(0, 60)}"`);
  const tries: [string, boolean][] = [[`refs/heads/${ref}`, true], [`refs/tags/${ref}`, false], ...(/^[0-9a-f]{7,40}$/.test(ref) ? [[ref, false] as [string, boolean]] : [])];
  for (const [r, isBranch] of tries) {
    const v = await runGit(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', `${r}^{commit}`]);
    if (v.code === 0 && v.out.trim()) return { sha: v.out.trim(), branch: isBranch ? ref : null };
  }
  throw new Error(`no branch, tag or commit "${ref}" in the repo`);
}

/** Where a checkout may go: inside the session's own directory, nothing on the way a symlink out of it. */
export function checkoutTarget(root: string, rel: string, pathInside: (c: string, r: string) => boolean): { target: string; exists: boolean } {
  const realRoot = fs.realpathSync(root);
  const want = path.resolve(realRoot, rel || '.');
  if (!pathInside(want, realRoot)) throw new Error('the checkout must be inside the session\'s own directory');
  let exists = false;
  try {
    const real = fs.realpathSync(want);
    if (!pathInside(real, realRoot)) throw new Error('the checkout must be inside the session\'s own directory');
    exists = true;
  } catch (e) {
    if ((e as Error).message.includes('own directory')) throw e;
    const parent = fs.realpathSync(path.dirname(want)); // the parent must exist, and be inside too
    if (!pathInside(parent, realRoot)) throw new Error('the checkout must be inside the session\'s own directory');
  }
  return { target: want, exists };
}

/** First checkout: built privately, then copied in (never overwriting anything). */
export async function freshCheckout(mirror: string, o: { target: string; sha: string; branch: string | null; origin: string }): Promise<void> {
  const tmpRoot = path.join(DIR, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const tmp = path.join(tmpRoot, `co-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const c = await runGit(['clone', '--no-checkout', '--no-hardlinks', '--quiet', mirror, tmp]);
    if (c.code !== 0) throw new Error(`clone failed: ${c.err.trim().slice(0, 300)}`);
    const steps: string[][] = [
      ['-C', tmp, 'remote', 'set-url', 'origin', o.origin],
      o.branch ? ['-C', tmp, 'checkout', '--quiet', '-B', o.branch, o.sha] : ['-C', tmp, 'checkout', '--quiet', '--detach', o.sha],
      ...(o.branch ? [['-C', tmp, 'branch', '--quiet', `--set-upstream-to=origin/${o.branch}`, o.branch]] : []),
    ];
    for (const s of steps) {
      const r = await runGit(s);
      if (r.code !== 0) throw new Error(`git ${s[2]} failed: ${r.err.trim().slice(0, 300)}`);
    }
    // the target: a new directory (mkdir fails if anything is there), checked to be a real directory right before use
    if (fs.existsSync(o.target)) {
      const st = fs.lstatSync(o.target);
      if (!st.isDirectory() || fs.readdirSync(o.target).length) throw new Error('the target exists and is not an empty directory');
    } else fs.mkdirSync(o.target);
    if (!fs.lstatSync(o.target).isDirectory()) throw new Error('the target is not a directory');
    for (const e of fs.readdirSync(tmp)) fs.cpSync(path.join(tmp, e), path.join(o.target, e), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Later fetch: a bundle of the mirror written into the checkout's own .git (a real directory inside the session dir). */
export async function writeBundle(mirror: string, target: string, pathInside: (c: string, r: string) => boolean, root: string): Promise<string> {
  const gitDir = path.join(target, '.git');
  const st = fs.lstatSync(gitDir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error('not a checkout made by github_checkout (no .git directory there) — pick an empty path for a new one');
  if (!pathInside(fs.realpathSync(gitDir), fs.realpathSync(root))) throw new Error('the checkout must be inside the session\'s own directory');
  const tmp = path.join(DIR, 'tmp', `b-${crypto.randomBytes(6).toString('hex')}.bundle`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true, mode: 0o700 });
  try {
    const b = await runGit(['--git-dir', mirror, 'bundle', 'create', '--quiet', tmp, '--branches', '--tags']);
    if (b.code !== 0) throw new Error(`bundle failed: ${b.err.trim().slice(0, 300)}`);
    const dest = path.join(gitDir, BUNDLE_NAME);
    try { if (fs.lstatSync(dest).isFile()) fs.unlinkSync(dest); } catch {}
    fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL); // a new file — never through a link, never over one
    return dest;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The one command the session runs in its checkout after a refresh. */
export const fetchCommand = (rel: string) => `git -C ${JSON.stringify(rel)} fetch --prune .git/${BUNDLE_NAME} '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'`;
