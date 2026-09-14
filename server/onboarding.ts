// Onboarding & workspace provisioning — the deterministic engine.
// See docs/ONBOARDING.md for the full design.
//
// This module owns ALL mechanical, idempotent provisioning (detect / clone /
// install / env / probe) with NO Claude session and NO tokens spent, so the
// same code powers the Setup UI's auto-fix buttons AND headless trigger
// readiness. The onboarding *skill* is a thin conversational wrapper over these
// same actions — it must not reimplement any of this.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isWin, which, shellArgs, toPosixPath, HOME, chromeCandidates } from './lib/platform.js';
import { supervise } from './lib/children.js';
import { cfg } from './lib/config.js';
import { hasCredentials } from './accounts.js';
import * as funnel from './funnel.js';
import { resourceRoot } from './lib/resource-root.js';

const CONFIG_DIR = cfg.configDir as string;
const REPOS_FILE = path.join(CONFIG_DIR, 'repos.json');

// profiles/ ships in the repo (server/../profiles); users can add their own.
const REPO_ROOT = resourceRoot();
const SHIPPED_PROFILES = path.join(REPO_ROOT, 'profiles');
const USER_PROFILES = path.join(CONFIG_DIR, 'profiles');

const tilde = (p: string): string =>
  p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;

// A filesystem path as a shell literal. Every provisioning job runs under a
// POSIX shell (Git Bash on Windows), so native separators have to be flipped —
// `mkdir -p "C:\x\y"` would otherwise create one file literally named `C:xy`.
const sh = (p: string): string => JSON.stringify(toPosixPath(p));

const safeRead = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Environment detection (decision 2) — automatic, picks the auto-fix strategy.
// ---------------------------------------------------------------------------

export interface EnvInfo {
  container: boolean;
  strategy: 'borrow' | 'provide';
}

export function detectEnv(): EnvInfo {
  const container =
    fs.existsSync('/.dockerenv') ||
    /docker|kubepods|containerd|lima/.test(safeRead('/proc/1/cgroup'));
  return { container, strategy: container ? 'provide' : 'borrow' };
}

// ---------------------------------------------------------------------------
// repos.json (decision 4) — the generic repo registry.
// ---------------------------------------------------------------------------

export interface EnvSource {
  // none    — no env needed
  // file    — an env file is expected present in the repo (supplied out-of-band)
  // command — run a command to produce env (e.g. `vercel env pull`)
  // copy    — copy `files` (local absolute/tilde paths) into the repo dir
  kind: 'none' | 'file' | 'command' | 'copy';
  value?: string; // file glob for 'file' (default .env.local), command for 'command'
  files?: string[]; // for 'copy': local source paths to copy into the repo
}

export interface RepoEntry {
  name: string;
  // Where to FETCH the repo from — the host always keeps its own managed copy
  // under reposDir/<name> (it owns the .git, worktrees, skills, permissions):
  //   git URL (github.com/o/r or full)  → git clone
  //   absolute/tilde local path         → copy the working tree (minus node_modules)
  source: string;
  branch?: string;
  installCmd?: string;
  devCmd?: string;
  testCmd?: string;
  envSource?: EnvSource;
}

export function listRepos(): RepoEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
    return Array.isArray(raw) ? (raw as RepoEntry[]) : [];
  } catch {
    return [];
  }
}

function writeRepos(list: RepoEntry[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REPOS_FILE, JSON.stringify(list, null, 2) + '\n');
}

const getRepo = (name: string): RepoEntry | undefined =>
  listRepos().find((r) => r.name === name);

// The host-managed working directory for a repo. ALWAYS under reposDir/<name> —
// whether the source is a git URL (cloned) or a local path (copied in). The host
// owns this copy's .git so worktrees/branches/PRs never touch the user's live
// repo.
// Repo names become a path segment under reposDir and are interpolated into
// shell (git clone). Only allow a safe leaf name — no separators, no `..`, no
// shell metacharacters — so a crafted name can't traverse out of reposDir or
// inject a command.
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
export function assertRepoName(name: unknown): string {
  const n = String(name ?? '');
  if (!REPO_NAME_RE.test(n) || n === '.' || n === '..')
    throw new Error(`invalid repo name: ${JSON.stringify(name)} (allowed: letters, digits, . _ -)`);
  return n;
}

// A git branch/ref interpolated into `git clone --branch`. Reject anything that
// isn't a plain ref token (blocks `;`, spaces, `$()`, backticks, leading `-`).
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
function assertBranch(branch: unknown): string {
  const b = String(branch ?? '');
  if (!BRANCH_RE.test(b) || b.includes('..'))
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  return b;
}

export function repoDir(r: RepoEntry): string {
  const name = assertRepoName(r.name);
  const base = path.resolve(tilde(cfg.reposDir));
  const dir = path.resolve(base, name);
  // Defense in depth: the resolved dir must stay directly under reposDir.
  if (path.dirname(dir) !== base)
    throw new Error(`invalid repo name: ${JSON.stringify(r.name)}`);
  return dir;
}

const isLocalPath = (source: string): boolean =>
  source.startsWith('/') || source.startsWith('~') || /^[A-Za-z]:[\\/]/.test(source);

// Has the repo been fetched into its managed dir yet? A git source lands a .git;
// a copied local source keeps its .git too, but tolerate a non-git folder by
// also accepting a non-empty dir.
export function repoPresent(r: RepoEntry): boolean {
  const dir = repoDir(r);
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  if (isLocalPath(r.source)) {
    try {
      return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

// Normalize a git source to a clonable https URL.
function gitUrl(source: string): string {
  if (/^(https?:|git@|ssh:)/.test(source)) return source;
  const s = source.replace(/^github\.com\//, '').replace(/\.git$/, '');
  return `https://github.com/${s}.git`;
}

// ---------------------------------------------------------------------------
// Toolchain auto-detect + in-repo manifest. Precedence (low→high):
//   auto-detect  <  .arigami.json  <  stored repos.json (user edits win).
// ---------------------------------------------------------------------------

export interface Toolchain {
  pm?: string;
  installCmd?: string;
  devCmd?: string;
  testCmd?: string;
}

export function detectToolchain(dir: string): Toolchain {
  const has = (f: string): boolean => fs.existsSync(path.join(dir, f));
  const out: Toolchain = {};
  if (has('bun.lock') || has('bun.lockb')) {
    out.pm = 'bun';
    out.installCmd = 'bun install';
  } else if (has('pnpm-lock.yaml')) {
    out.pm = 'pnpm';
    out.installCmd = 'pnpm install --frozen-lockfile';
  } else if (has('yarn.lock')) {
    out.pm = 'yarn';
    out.installCmd = 'yarn install --frozen-lockfile';
  } else if (has('package-lock.json')) {
    out.pm = 'npm';
    out.installCmd = 'npm ci';
  } else if (has('requirements.txt')) {
    out.pm = 'pip';
    out.installCmd = 'pip install -r requirements.txt';
  } else if (has('go.mod')) {
    out.pm = 'go';
    out.installCmd = 'go mod download';
  } else if (has('Cargo.toml')) {
    out.pm = 'cargo';
    out.installCmd = 'cargo fetch';
  }
  // package.json but no lockfile → still a JS project; default to `npm install`
  // (not `npm ci`, which requires a lockfile).
  if (!out.pm && has('package.json')) {
    out.pm = 'npm';
    out.installCmd = 'npm install';
  }
  // dev/test from package.json scripts
  try {
    const pkg = JSON.parse(safeRead(path.join(dir, 'package.json')) || '{}');
    const runner = out.pm && out.pm !== 'npm' ? `${out.pm} run` : 'npm run';
    if (pkg.scripts?.dev) out.devCmd = `${runner} dev`;
    else if (pkg.scripts?.start) out.devCmd = `${runner} start`;
    if (pkg.scripts?.test) out.testCmd = `${runner} test`;
  } catch {
    /* no package.json */
  }
  return out;
}

// Is an executable resolvable on PATH? (cheap, no subprocess) — used to gate on
// the Claude Code CLI being installed before onboarding can open a session.
function onPath(bin: string): boolean {
  // which() applies PATHEXT on Windows (`claude` → claude.exe/.cmd) and there is
  // no X_OK bit there, so existence is the only meaningful test.
  if (isWin) return !!which(bin);
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

// Probe a local folder the user wants to add as a repo source: does it exist, is
// it a git repo, what toolchain, and which env files could be copied in. Powers
// the "From local folder" picker (prefill install cmd + offer env files).
export function detectLocalSource(p: string): {
  exists: boolean;
  isGit: boolean;
  toolchain: Toolchain;
  envCandidates: string[];
} {
  const dir = tilde(p || '').replace(/\/+$/, '');
  const exists = !!dir && fs.existsSync(dir) && (() => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!exists) return { exists: false, isGit: false, toolchain: {}, envCandidates: [] };
  let envCandidates: string[] = [];
  try {
    envCandidates = fs
      .readdirSync(dir)
      .filter((f) => /^\.env($|\.)/.test(f) && !/\.(example|sample|template)$/.test(f))
      .sort();
  } catch {
    /* unreadable */
  }
  return {
    exists,
    isGit: fs.existsSync(path.join(dir, '.git')),
    toolchain: detectToolchain(dir),
    envCandidates,
  };
}

function readManifest(dir: string): Partial<RepoEntry> {
  try {
    const m = JSON.parse(safeRead(path.join(dir, '.arigami.json')) || '{}');
    const out: Partial<RepoEntry> = {};
    for (const k of ['installCmd', 'devCmd', 'testCmd', 'envSource', 'branch'])
      if (m[k] !== undefined) (out as any)[k] = m[k];
    return out;
  } catch {
    return {};
  }
}

// Merge detect < manifest < stored, for the fields the user hasn't pinned.
export function resolveRepo(stored: RepoEntry): RepoEntry {
  const dir = repoDir(stored);
  const detected = fs.existsSync(dir) ? detectToolchain(dir) : {};
  const manifest = fs.existsSync(dir) ? readManifest(dir) : {};
  const pick = (k: 'installCmd' | 'devCmd' | 'testCmd'): string | undefined =>
    stored[k] ?? (manifest as any)[k] ?? (detected as any)[k];
  return {
    ...stored,
    installCmd: pick('installCmd'),
    devCmd: pick('devCmd'),
    testCmd: pick('testCmd'),
    branch: stored.branch ?? manifest.branch,
    envSource: stored.envSource ?? manifest.envSource ?? { kind: 'none' },
  };
}

export function addRepo(entry: RepoEntry): RepoEntry {
  assertRepoName(entry.name);
  if (entry.branch) assertBranch(entry.branch);
  const list = listRepos();
  if (list.some((r) => r.name === entry.name))
    throw new Error(`repo already registered: ${entry.name}`);
  list.push(entry);
  writeRepos(list);
  return resolveRepo(entry);
}

// User edit — highest precedence.
export function saveRepo(name: string, patch: Partial<RepoEntry>): RepoEntry {
  const list = listRepos();
  const i = list.findIndex((r) => r.name === name);
  if (i < 0) throw new Error(`no such repo: ${name}`);
  if (patch.branch) assertBranch(patch.branch);
  list[i] = { ...list[i], ...patch, name };
  writeRepos(list);
  return resolveRepo(list[i]);
}

export function removeRepo(name: string): boolean {
  const list = listRepos();
  const next = list.filter((r) => r.name !== name);
  if (next.length === list.length) return false;
  writeRepos(next);
  return true;
}

// ---------------------------------------------------------------------------
// Profiles (decision 5) — a declarative manifest that SEEDS the generic core.
// A profile is data, not a skill; applying it upserts its repos into repos.json
// (seed-then-auto-fix), so the normal per-step provisioning then runs. The
// shipped profiles are generic bundles; users add their own under ARIGAMI_DIR/profiles.
// ---------------------------------------------------------------------------

export interface Profile {
  name: string;
  title?: string;
  description?: string;
  repos?: RepoEntry[];
  ports?: unknown;
  issueSource?: string;
  plugins?: string[];
  workflows?: string[];
}

export function listProfiles(): Profile[] {
  const out: Profile[] = [];
  const seen = new Set<string>();
  // User profiles override shipped ones by name.
  for (const dir of [USER_PROFILES, SHIPPED_PROFILES]) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    // Profile Bundles (K3, the primary form): <dir>/bundles/<name>/profile.json
    // for the shipped tree, <dir>/<name>/profile.json for installed ones —
    // listed first so a bundle wins over a thin <name>.json of the same name.
    const bundleRoot = dir === SHIPPED_PROFILES ? path.join(dir, 'bundles') : dir;
    let bundles: string[] = [];
    try {
      bundles = fs.readdirSync(bundleRoot).filter((n) => fs.existsSync(path.join(bundleRoot, n, 'profile.json')));
    } catch {
      /* no bundles dir */
    }
    const sources = [...bundles.map((n) => path.join(bundleRoot, n, 'profile.json')), ...files.map((f) => path.join(dir, f))];
    for (const file of sources) {
      try {
        const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;
        if (p.name && !seen.has(p.name)) {
          seen.add(p.name);
          out.push(p);
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

// Seed: upsert the profile's repos into repos.json (profile fields win). Does NOT
// clone/install — the user drives that per-step via the UI or the onboarding skill.
export function applyProfile(name: string): { applied: string; repos: string[] } {
  const prof = listProfiles().find((p) => p.name === name);
  if (!prof) throw new Error(`no such profile: ${name}`);
  upsertRepos(prof.repos || []);
  return { applied: prof.name, repos: (prof.repos || []).map((r) => r.name) };
}

// Upsert entries into repos.json by name (entry fields win). Shared by
// applyProfile and the K3 bundle loader (server/profiles.ts).
export function upsertRepos(entries: RepoEntry[]): RepoEntry[] {
  const byName = new Map<string, RepoEntry>(listRepos().map((r) => [r.name, r]));
  for (const r of entries) {
    assertRepoName(r.name);
    byName.set(r.name, { ...byName.get(r.name), ...r });
  }
  const list = [...byName.values()];
  writeRepos(list);
  return entries.map((e) => byName.get(e.name)!);
}

// ---------------------------------------------------------------------------
// Actions (idempotent). Each returns { ok, output } — the HTTP layer awaits.
// ---------------------------------------------------------------------------

// Background jobs — provisioning commands (clone/install/env) can run for
// minutes, so they must NOT block the HTTP request (fetch/proxy/node timeouts).
// An action starts the job and returns immediately; status() reflects a running
// job as 'running', and the client polls until it flips to ok/error.
export type JobState = 'running' | 'done' | 'error';
interface Job {
  state: JobState;
  output: string;
  startedAt: number;
  endedAt?: number;
}
const jobs = new Map<string, Job>(); // key: `${repo}:${action}`

const jobKey = (name: string, action: string): string => `${name}:${action}`;
export const jobFor = (name: string, action: string): Job | undefined =>
  jobs.get(jobKey(name, action));

export interface ActionResult {
  started: boolean;
  state: JobState;
  output?: string;
}

function startJob(key: string, cmd: string, cwd?: string): ActionResult {
  const existing = jobs.get(key);
  if (existing?.state === 'running') return { started: false, state: 'running' };
  const job: Job = { state: 'running', output: '', startedAt: Date.now() };
  jobs.set(key, job);
  let child;
  try {
    const [sh, ...shArgs] = shellArgs(cmd);
    child = spawn(sh, shArgs, { cwd, env: process.env });
    supervise(child, `onboarding:${key}`); // clone/install runs must not outlive us
  } catch (e) {
    // No POSIX shell on this machine — surface it as a failed job rather than
    // throwing out of a status/auto-fix request.
    job.state = 'error';
    job.output = e instanceof Error ? e.message : String(e);
    job.endedAt = Date.now();
    return { started: false, state: 'error', output: job.output };
  }
  const cap = (d: Buffer): void => {
    job.output = (job.output + d.toString()).slice(-8000);
  };
  child.stdout?.on('data', cap);
  child.stderr?.on('data', cap);
  child.on('close', (code) => {
    job.state = code === 0 ? 'done' : 'error';
    job.endedAt = Date.now();
  });
  child.on('error', (e) => {
    job.state = 'error';
    job.output += `\n${e.message}`;
    job.endedAt = Date.now();
  });
  return { started: true, state: 'running' };
}

export function cloneRepo(name: string): ActionResult {
  const r = getRepo(name);
  if (!r) throw new Error(`no such repo: ${name}`);
  const dir = repoDir(r);
  if (repoPresent(r)) return { started: false, state: 'done', output: 'already present' };
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  if (isLocalPath(r.source)) {
    // Copy the local working tree into the host-managed workspace, EXCLUDING
    // node_modules (huge + platform-specific native binaries → rebuilt by
    // installCmd). Keep .git so the host has a real repo for worktrees/PRs. tar
    // is portable across the slim container and macOS; a fresh install rebuilds
    // deps afterward.
    const src = tilde(r.source).replace(/[\\/]+$/, '');
    if (!fs.existsSync(src))
      return { started: false, state: 'error', output: `local source not found: ${src}` };
    return startJob(
      jobKey(name, 'clone'),
      `mkdir -p ${sh(dir)} && ` +
        `tar -C ${sh(src)} --exclude=node_modules -cf - . | ` +
        `tar -C ${sh(dir)} -xf -`
    );
  }

  const branch = r.branch ? `--branch ${JSON.stringify(assertBranch(r.branch))} ` : '';
  return startJob(
    jobKey(name, 'clone'),
    `git clone --quiet ${branch}${JSON.stringify(gitUrl(r.source))} ${sh(dir)}`
  );
}

export function resolveEnv(name: string): ActionResult {
  const r = getRepo(name);
  if (!r) throw new Error(`no such repo: ${name}`);
  const es = resolveRepo(r).envSource || { kind: 'none' };
  if (es.kind === 'none') return { started: false, state: 'done', output: 'no env needed' };
  if (es.kind === 'command')
    return startJob(jobKey(name, 'env'), es.value || 'true', repoDir(r));
  if (es.kind === 'copy') {
    // Copy each picked local env file into the repo dir (basename preserved).
    const dir = repoDir(r);
    const srcs = (es.files || []).map((f) => tilde(f)).filter(Boolean);
    if (!srcs.length) return { started: false, state: 'done', output: 'no env files listed' };
    const missing = srcs.filter((s) => !fs.existsSync(s));
    if (missing.length)
      return { started: false, state: 'error', output: `env source(s) not found: ${missing.join(', ')}` };
    const cmd = srcs
      .map((s) => `cp ${sh(s)} ${sh(dir)}/`)
      .join(' && ');
    return startJob(jobKey(name, 'env'), cmd);
  }
  // kind 'file' — supplied out-of-band (upload / borrow); just report presence.
  const ok = envFilePresent(r);
  return { started: false, state: ok ? 'done' : 'error', output: ok ? 'present' : 'missing' };
}

// Shell prefix that sources the repo's env file(s) into the install job so
// private-registry tokens living IN .env.local (e.g. an auth token that a
// scoped package's registry requires) are present as env vars — otherwise a
// plain `bun install` 401s / fails to resolve those packages. Users keep the
// plain detected installCmd; the engine handles sourcing.
function envSourcingPrefix(eff: RepoEntry): string {
  const es = eff.envSource;
  if (!es || es.kind === 'none' || es.kind === 'command') return '';
  const dir = repoDir(eff);
  const names =
    es.kind === 'copy'
      ? (es.files || []).map((f) => path.basename(tilde(f)))
      : [es.value || '.env.local'];
  const present = names.filter((n) => fs.existsSync(path.join(dir, n)));
  if (!present.length) return '';
  return `set -a && ${present.map((n) => `. ./${n}`).join(' && ')} && set +a && `;
}

export function installDeps(name: string): ActionResult {
  const r = getRepo(name);
  if (!r) throw new Error(`no such repo: ${name}`);
  const eff = resolveRepo(r);
  const dir = repoDir(r);
  if (!fs.existsSync(dir)) return { started: false, state: 'error', output: 'repo not cloned yet' };
  if (!eff.installCmd) return { started: false, state: 'done', output: 'no install step' };
  return startJob(jobKey(name, 'install'), envSourcingPrefix(eff) + eff.installCmd, dir);
}

// ---------------------------------------------------------------------------
// Probes → status tree (decision 7).
// ---------------------------------------------------------------------------

export type StepStatus = 'ok' | 'missing' | 'error' | 'blocked' | 'running';

export interface Step {
  id: string;
  title: string;
  scope: string; // 'global' | `repo:<name>`
  status: StepStatus;
  autoFixable: boolean;
  dependsOn: string[];
  action?: string;
  detail?: string;
}

const claudeAuthed = (): boolean =>
  hasCredentials() || // macOS keychain login or a stored account token
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  !!process.env.ANTHROPIC_API_KEY ||
  fs.existsSync(path.join(HOME, '.claude', '.credentials.json'));

const gitAuthed = (): boolean =>
  !!process.env.GH_TOKEN ||
  !!process.env.GITHUB_TOKEN ||
  fs.existsSync(path.join(HOME, '.git-credentials'));

function envFilePresent(r: RepoEntry): boolean {
  const dir = repoDir(r);
  const es = resolveRepo(r).envSource;
  if (es?.kind === 'copy') {
    const files = es.files || [];
    return (
      files.length > 0 &&
      files.every((f) => fs.existsSync(path.join(dir, path.basename(tilde(f)))))
    );
  }
  const glob = (es?.value && es.kind === 'file' ? es.value : '.env.local') || '.env.local';
  return fs.existsSync(path.join(dir, glob));
}

const depsPresent = (r: RepoEntry): boolean => {
  // No install step (no lockfile / no package.json / non-code repo) → nothing to
  // install, so the step is trivially satisfied (never a stuck "missing").
  if (!resolveRepo(r).installCmd) return true;
  const dir = repoDir(r);
  const pm = detectToolchain(dir).pm;
  // JS toolchains have a reliable marker (node_modules). For others we can't
  // cheaply probe in P1, so don't block on them once cloned.
  if (['bun', 'pnpm', 'yarn', 'npm'].includes(pm || ''))
    return fs.existsSync(path.join(dir, 'node_modules'));
  return true;
};

export function status(): { environment: EnvInfo; steps: Step[] } {
  const env = detectEnv();
  const steps: Step[] = [];

  // --- Global credential gates ---
  // 0) The Claude Code CLI itself must be installed — the onboarding skill runs
  //    INSIDE a claude session, so without the binary there is no session to open.
  //    Guided manual install (not auto): npm/bun global + PATH refresh + auth are
  //    too flaky to silently automate. In the container it's baked in → always ok.
  const cliOk = onPath('claude');
  steps.push({
    id: 'claude-cli',
    title: 'Claude Code CLI installed',
    scope: 'global',
    status: cliOk ? 'ok' : 'missing',
    autoFixable: false,
    dependsOn: [],
    action: 'onboarding.claudeInstallHelp',
    detail: cliOk
      ? undefined
      : 'Install globally: npm i -g @anthropic-ai/claude-code (or `brew install claude`), then Recheck',
  });
  const claudeOk = claudeAuthed();
  steps.push({
    id: 'claude-auth',
    title: 'Claude Code authentication',
    scope: 'global',
    status: !cliOk ? 'blocked' : claudeOk ? 'ok' : 'missing',
    autoFixable: false, // CLAUDE_CODE_OAUTH_TOKEN / setup-token is user-driven
    dependsOn: ['claude-cli'],
    action: 'onboarding.claudeAuthHelp',
    detail: claudeOk
      ? undefined
      : 'Sign in with `claude` (subscription login → macOS keychain), add an account in the Accounts view, or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY',
  });
  const gitOk = gitAuthed();
  steps.push({
    id: 'git-auth',
    title: 'Git / GitHub authentication',
    scope: 'global',
    status: gitOk ? 'ok' : 'missing',
    autoFixable: env.strategy === 'borrow', // native: borrow `gh auth token`
    dependsOn: [],
    action: 'onboarding.gitAuth',
    detail: gitOk ? undefined : 'Provide GH_TOKEN, or (native) borrow from local gh',
  });

  // A running/failed background job overrides the filesystem-derived status, so
  // a long clone/install shows 'running' (client polls) then flips to ok/error.
  const overlay = (
    base: StepStatus,
    action: string,
    name: string,
    fsOk: boolean
  ): { status: StepStatus; detail?: string } => {
    const job = jobFor(name, action);
    if (job?.state === 'running') return { status: 'running', detail: 'running…' };
    if (job?.state === 'error' && !fsOk)
      return { status: 'error', detail: job.output.slice(-200).trim() };
    return { status: base };
  };

  // --- Per-repo groups ---
  for (const stored of listRepos()) {
    const r = resolveRepo(stored);
    const dir = repoDir(r);
    const local = isLocalPath(r.source);
    const cloned = repoPresent(r);
    // A local-copy source doesn't need git auth to fetch (it's a filesystem copy).
    const blockedNoAuth = !local && !gitOk;
    const cl = overlay(cloned ? 'ok' : blockedNoAuth ? 'blocked' : 'missing', 'clone', r.name, cloned);
    steps.push({
      id: `repo:${r.name}.cloned`,
      title: `${r.name}: repository present`,
      scope: `repo:${r.name}`,
      status: cl.status,
      autoFixable: true,
      dependsOn: local ? [] : ['git-auth'],
      action: 'onboarding.cloneRepo',
      detail:
        cl.detail ??
        (cloned ? dir : local ? `will copy ${tilde(r.source)} (minus node_modules)` : `will clone ${gitUrl(r.source)}`),
    });
    const envOk = (r.envSource?.kind ?? 'none') === 'none' || envFilePresent(r);
    const ev = overlay(!cloned ? 'blocked' : envOk ? 'ok' : 'missing', 'env', r.name, envOk);
    steps.push({
      id: `repo:${r.name}.env`,
      title: `${r.name}: environment`,
      scope: `repo:${r.name}`,
      status: ev.status,
      autoFixable: r.envSource?.kind === 'command' || r.envSource?.kind === 'copy',
      dependsOn: [`repo:${r.name}.cloned`],
      action: 'onboarding.resolveEnv',
      detail: ev.detail ?? `envSource: ${r.envSource?.kind ?? 'none'}`,
    });
    const deps = depsPresent(r);
    const dp = overlay(!cloned || !envOk ? 'blocked' : deps ? 'ok' : 'missing', 'install', r.name, deps);
    steps.push({
      id: `repo:${r.name}.deps`,
      title: `${r.name}: dependencies installed`,
      scope: `repo:${r.name}`,
      status: dp.status,
      autoFixable: true,
      dependsOn: [`repo:${r.name}.cloned`, `repo:${r.name}.env`],
      action: 'onboarding.installDeps',
      detail: dp.detail ?? (r.installCmd || 'no install step'),
    });
  }

  return { environment: env, steps };
}

// A repo is ready when all global gates and all its own steps are ok. This is
// exactly what an autonomous trigger checks before firing (headless, no tokens).
export function ready(repoName: string): boolean {
  const { steps } = status();
  const relevant = steps.filter(
    (s) => s.scope === 'global' || s.scope === `repo:${repoName}`
  );
  return relevant.length > 0 && relevant.every((s) => s.status === 'ok');
}

// The workspace is ready when the global gates are ok AND at least one repo is
// fully ready. Triggers check this before firing so an autonomous run never
// dead-ends on an unprovisioned workspace. Same logic as the launcher gate.
export function workspaceReady(): boolean {
  const { steps } = status();
  const globalsOk = steps
    .filter((s) => s.scope === 'global')
    .every((s) => s.status === 'ok');
  if (!globalsOk) return false;
  const names = [
    ...new Set(steps.filter((s) => s.scope.startsWith('repo:')).map((s) => s.scope.slice(5))),
  ];
  return names.some((n) =>
    steps.filter((s) => s.scope === `repo:${n}`).every((s) => s.status === 'ok')
  );
}

// ===========================================================================
// B3 / K5 — the first-run WIZARD state machine.
//
// One linear flow: pair → claude → git → profile → integrations → repo → health.
// Every step has a live PROBE (filesystem / env / config — never a network
// call except the explicit health run) and a persisted RECORD in
// $ARIGAMI_DIR/onboarding.json ({status:'complete'|'skipped', at, by}). The
// effective status is probe-first: a step whose probe passes is `ok` no matter
// what the record says; otherwise the record decides (skipped / complete),
// otherwise it's `todo`. The wizard UI, `bin/host doctor` and the funnel all
// read wizard() — there is no second source of truth.
//
// Every status transition emits exactly one `onboarding.step {step,status,at}`
// funnel event (funnel.ts → $ARIGAMI_DIR/funnel.jsonl) and the same object on
// the ws bus as {type:'onboarding.step'}; the last emitted status per step is
// stored alongside the records so restarts don't re-emit.
// ===========================================================================

export const WIZARD_STEPS = ['pair', 'claude', 'git', 'profile', 'integrations', 'repo', 'telemetry', 'health'] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];
export type WizardStatus = 'ok' | 'todo' | 'skipped' | 'blocked' | 'error' | 'running';

export interface WizardStep {
  id: WizardStepId;
  title: string;
  status: WizardStatus;
  fixable: boolean; // the UI can turn it green without leaving the wizard
  skippable: boolean;
  detail?: string;
  // Step-specific live facts the UI renders (never secrets).
  data?: Record<string, unknown>;
  // Who satisfied it, when (from the record) — only when not probe-derived.
  by?: 'user' | 'auto' | 'unattended';
  at?: string;
}

export interface WizardView {
  steps: WizardStep[];
  current: WizardStepId | null; // first REQUIRED step that is neither ok nor skipped
  done: boolean;
  completedAt?: string;
  unattended: boolean;
  // S1 (JIT setup): 'minimal' (default) = only pair + claude are required;
  // everything else is optional and connects just-in-time from the chat.
  // 'full' = the classic linear wizard ("Run full setup").
  mode: OnboardingMode;
  required: WizardStepId[];
}

export type OnboardingMode = 'minimal' | 'full';
export const MINIMAL_REQUIRED: readonly WizardStepId[] = ['pair', 'claude'];

export interface HealthCheck {
  id: 'claude' | 'desktop' | 'chrome' | 'whatsapp';
  ok: boolean;
  required: boolean;
  detail: string;
}
export interface HealthResult {
  ok: boolean; // every REQUIRED check passed
  at: string;
  checks: HealthCheck[];
}

interface StepRecord {
  status: 'complete' | 'skipped';
  at: string;
  by: 'user' | 'auto' | 'unattended';
}
interface OnboardingFile {
  version: 1;
  mode?: OnboardingMode; // absent = 'minimal'
  steps: Partial<Record<WizardStepId, StepRecord>>;
  emitted: Partial<Record<WizardStepId, WizardStatus>>;
  health?: HealthResult;
  done?: boolean;
  completedAt?: string;
}

export const ONBOARDING_FILE = path.join(CONFIG_DIR, 'onboarding.json');
export const PENDING_PROFILE_FILE = path.join(CONFIG_DIR, 'pending-profile');
const PROVENANCE_FILE = path.join(CONFIG_DIR, 'profile.json');

export function readOnboardingFile(): OnboardingFile {
  try {
    const j = JSON.parse(fs.readFileSync(ONBOARDING_FILE, 'utf8'));
    if (j && typeof j === 'object' && j.version === 1)
      return { steps: {}, emitted: {}, ...j } as OnboardingFile;
  } catch {
    /* absent / malformed → fresh */
  }
  return { version: 1, steps: {}, emitted: {} };
}

function writeOnboardingFile(f: OnboardingFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ONBOARDING_FILE, JSON.stringify(f, null, 2) + '\n');
}

export function getOnboardingMode(): OnboardingMode {
  const env = process.env.ARIGAMI_ONBOARDING_MODE;
  if (env === 'full' || env === 'minimal') return env;
  return readOnboardingFile().mode === 'full' ? 'full' : 'minimal';
}

/** "Run full setup" (→ 'full') / back to just-in-time ('minimal'). Returns the recomputed view. */
export function setOnboardingMode(mode: OnboardingMode, probes: Partial<WizardProbes> = {}): WizardView {
  if (mode !== 'full' && mode !== 'minimal') throw new Error(`unknown onboarding mode: ${String(mode)}`);
  const file = readOnboardingFile();
  file.mode = mode;
  writeOnboardingFile(file);
  return wizard(probes);
}

/** The steps that gate `done` in the given mode. */
export const requiredSteps = (mode: OnboardingMode): WizardStepId[] =>
  mode === 'full' ? [...WIZARD_STEPS] : [...MINIMAL_REQUIRED];

// --- probes -----------------------------------------------------------------
// Injectable so the state machine is unit-testable without a host, gh, or a
// Claude login on the test box. Defaults are the real filesystem/env probes.

export interface WizardProbes {
  hasAdmin: () => boolean;
  claudeCli: () => boolean;
  claudeAuth: () => boolean;
  gitAuth: () => boolean;
  profileApplied: () => string | null; // applied bundle name
  pendingProfile: () => string | null;
  integrations: () => { composio: boolean; whatsapp: string; tailscale: boolean };
  repos: () => string[];
  health: () => HealthResult | undefined;
  unattended: () => boolean;
  // D3: what applies right now (config + ARIGAMI_TELEMETRY + DO_NOT_TRACK).
  telemetry: () => { enabled: boolean; reason: 'dnt' | 'env' | 'config' };
}

const readTrim = (p: string): string | null => {
  const s = safeRead(p).trim();
  return s || null;
};

const ghCliAuthed = (): boolean =>
  fs.existsSync(path.join(HOME, '.config', 'gh', 'hosts.yml')) ||
  fs.existsSync(path.join(HOME, '.config', 'gh', 'hosts.yaml'));

export const defaultProbes: WizardProbes = {
  hasAdmin: () => {
    // users.json is C1's store; any admin role = paired. Read directly so this
    // works from the CLI (`bun server/onboarding.ts doctor`) with no host.
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'users.json'), 'utf8'));
      const users = Array.isArray(j) ? j : Array.isArray(j?.users) ? j.users : [];
      return users.some((u: any) => u && u.role === 'admin');
    } catch {
      return false;
    }
  },
  claudeCli: () => onPath('claude'),
  claudeAuth: () => claudeAuthed(),
  gitAuth: () => gitAuthed() || ghCliAuthed(),
  profileApplied: () => {
    try {
      const j = JSON.parse(fs.readFileSync(PROVENANCE_FILE, 'utf8'));
      return typeof j?.name === 'string' ? j.name : null;
    } catch {
      return null;
    }
  },
  pendingProfile: () => readTrim(PENDING_PROFILE_FILE),
  integrations: () => {
    let whatsapp = 'unknown';
    try {
      const WA_STATUS = '/home/arigami/.local/lib/whatsapp-mcp/data/bridge-status.json';
      const j = JSON.parse(fs.readFileSync(WA_STATUS, 'utf8'));
      whatsapp = typeof j?.status === 'string' ? j.status : 'disconnected';
    } catch {
      whatsapp = 'disconnected';
    }
    return {
      composio: !!(cfg.composioApiKey || process.env.COMPOSIO_API_KEY),
      whatsapp,
      tailscale: !!which('tailscale'),
    };
  },
  repos: () => listRepos().map((r) => r.name),
  health: () => readOnboardingFile().health,
  unattended: () => process.env.ARIGAMI_UNATTENDED === '1',
  telemetry: () => {
    const dnt = /^(1|true|yes)$/i.test(String(process.env.DO_NOT_TRACK || ''));
    const e = process.env.ARIGAMI_TELEMETRY;
    if (dnt) return { enabled: false, reason: 'dnt' };
    if (e != null && e !== '') return { enabled: /^(1|true|yes|on)$/i.test(e), reason: 'env' };
    return { enabled: !!cfg.telemetry?.enabled, reason: 'config' };
  },
};

// --- the machine ---------------------------------------------------------------

const TITLES: Record<WizardStepId, string> = {
  pair: 'Pair this device',
  claude: 'Connect Claude',
  git: 'Git / GitHub access',
  profile: 'Profile bundle',
  integrations: 'Integrations',
  repo: 'First repository',
  telemetry: 'Help improve Arigami',
  health: 'Health check',
};

const SKIPPABLE: Record<WizardStepId, boolean> = {
  pair: false,
  claude: false,
  git: true,
  profile: true,
  integrations: true,
  repo: true,
  telemetry: true,
  health: true,
};

function computeSteps(file: OnboardingFile, p: WizardProbes): WizardStep[] {
  const rec = (id: WizardStepId): StepRecord | undefined => file.steps[id];
  // probe-ok wins; else the record; else todo.
  const resolve = (id: WizardStepId, probeOk: boolean, fallback: WizardStatus = 'todo'): Pick<WizardStep, 'status' | 'by' | 'at'> => {
    if (probeOk) return { status: 'ok' };
    const r = rec(id);
    if (r?.status === 'skipped') return { status: 'skipped', by: r.by, at: r.at };
    if (r?.status === 'complete') return { status: 'ok', by: r.by, at: r.at };
    return { status: fallback };
  };

  const admin = p.hasAdmin();
  const cli = p.claudeCli();
  const cauth = p.claudeAuth();
  const gauth = p.gitAuth();
  const applied = p.profileApplied();
  const pending = p.pendingProfile();
  const integ = p.integrations();
  const repos = p.repos();
  const health = p.health();
  const tele = p.telemetry();

  const steps: WizardStep[] = [
    {
      id: 'pair',
      title: TITLES.pair,
      fixable: true,
      skippable: SKIPPABLE.pair,
      ...resolve('pair', admin),
      detail: admin ? 'an admin is paired' : 'enter the pairing code printed by the host',
    },
    {
      id: 'claude',
      title: TITLES.claude,
      fixable: cli,
      skippable: SKIPPABLE.claude,
      ...resolve('claude', cli && cauth, cli ? 'todo' : 'blocked'),
      detail: !cli
        ? 'Claude Code CLI not found on PATH — install it first (npm i -g @anthropic-ai/claude-code)'
        : cauth
          ? 'signed in'
          : 'sign in with Claude (PKCE) or paste a token',
      data: { cli, authed: cauth },
    },
    {
      id: 'git',
      title: TITLES.git,
      fixable: true,
      skippable: SKIPPABLE.git,
      ...resolve('git', gauth),
      detail: gauth ? 'git credentials present' : 'paste a GitHub token or sign in with gh — needed only for private repos',
      data: { gh: !!which('gh') },
    },
    {
      id: 'profile',
      title: TITLES.profile,
      fixable: true,
      skippable: SKIPPABLE.profile,
      ...resolve('profile', !!applied),
      detail: applied ? `applied: ${applied}` : pending ? `pending: ${pending} (staged by the installer)` : 'pick a bundle, or start blank',
      data: { applied, pending },
    },
    {
      id: 'integrations',
      title: TITLES.integrations,
      fixable: true,
      skippable: SKIPPABLE.integrations,
      ...resolve('integrations', false),
      detail: [
        integ.composio ? 'composio ✓' : 'composio –',
        `whatsapp ${integ.whatsapp}`,
        integ.tailscale ? 'tailscale ✓' : 'tailscale –',
      ].join(' · '),
      data: { ...integ },
    },
    {
      id: 'repo',
      title: TITLES.repo,
      fixable: true,
      skippable: SKIPPABLE.repo,
      ...resolve('repo', repos.length > 0),
      detail: repos.length ? repos.join(', ') : 'add a repository to work on',
      data: { repos },
    },
    {
      // D3: opt-in only. 'ok' when the user decided (either way — a recorded
      // 'complete' after "No thanks" is still a decision) or when it's
      // already on; DO_NOT_TRACK / env pin it and skip the question.
      id: 'telemetry',
      title: TITLES.telemetry,
      fixable: true,
      skippable: SKIPPABLE.telemetry,
      ...resolve('telemetry', tele.enabled || tele.reason !== 'config'),
      detail: tele.reason === 'dnt'
        ? 'DO_NOT_TRACK=1 — telemetry is off and cannot be enabled'
        : tele.reason === 'env'
          ? `pinned by ARIGAMI_TELEMETRY (${tele.enabled ? 'on' : 'off'})`
          : tele.enabled
            ? 'anonymous usage milestones are sent (Settings → Telemetry to review or turn off)'
            : 'off — send anonymous funnel milestones (no prompts, paths or names) to help prioritise work',
      data: { enabled: tele.enabled, reason: tele.reason },
    },
    {
      id: 'health',
      title: TITLES.health,
      fixable: true,
      skippable: SKIPPABLE.health,
      ...resolve('health', !!health?.ok),
      detail: health ? (health.ok ? `passed ${health.at}` : `failed: ${health.checks.filter((c) => !c.ok && c.required).map((c) => c.id).join(', ')}`) : 'not run yet',
      data: { health: health ?? null },
    },
  ];
  // A running health job overrides the persisted result.
  if (healthRunning) steps[steps.length - 1].status = 'running';
  return steps;
}

const settled = (s: WizardStatus): boolean => s === 'ok' || s === 'skipped';

/**
 * Compute the wizard view, emitting one funnel event per changed step status.
 * Pure w.r.t. `probes`; persists only the `emitted` map / done flag.
 */
export function wizard(probes: Partial<WizardProbes> = {}): WizardView {
  const p: WizardProbes = { ...defaultProbes, ...probes };
  const file = readOnboardingFile();
  const steps = computeSteps(file, p);
  let dirty = false;
  for (const s of steps) {
    if (file.emitted[s.id] !== s.status) {
      file.emitted[s.id] = s.status;
      dirty = true;
      emitStep(s.id, s.status);
    }
  }
  // Minimal mode (S1): done = every REQUIRED step settled; optional steps
  // never block and are connected just-in-time from the chat (request_setup).
  const mode = getOnboardingMode();
  // F8: record the effective mode in onboarding.json so a fresh install is
  // visibly `mode:'minimal'` (the file used to carry no mode at all).
  if (file.mode !== mode) {
    file.mode = mode;
    dirty = true;
  }
  const required = requiredSteps(mode);
  const isRequired = (id: WizardStepId): boolean => required.includes(id);
  const done = steps.every((s) => !isRequired(s.id) || settled(s.status));
  if (done && !file.done) {
    file.done = true;
    file.completedAt = new Date().toISOString();
    dirty = true;
    funnel.emit('onboarding.done', {});
  } else if (!done && file.done) {
    file.done = false;
    delete file.completedAt;
    dirty = true;
  }
  if (dirty) writeOnboardingFile(file);
  const current = steps.find((s) => isRequired(s.id) && !settled(s.status))?.id ?? null;
  return { steps, current, done, completedAt: file.completedAt, unattended: p.unattended(), mode, required };
}

function emitStep(step: WizardStepId, status: WizardStatus): void {
  const ev = funnel.emit('onboarding.step', { step, status });
  if (process.env.ARIGAMI_FUNNEL_QUIET !== '1')
    import('./bus.js').then((b: any) => b.broadcast({ type: 'onboarding.step', step, status, at: ev.at })).catch(() => {});
}

export type WizardAction = 'complete' | 'skip' | 'reset';

/** Record a user decision for a step. Throws on an illegal action. */
export function wizardAct(step: string, action: WizardAction, by: StepRecord['by'] = 'user', probes: Partial<WizardProbes> = {}): WizardView {
  if (!(WIZARD_STEPS as readonly string[]).includes(step)) throw new Error(`unknown wizard step: ${step}`);
  const id = step as WizardStepId;
  const file = readOnboardingFile();
  if (action === 'skip') {
    if (!SKIPPABLE[id]) throw new Error(`step ${id} cannot be skipped`);
    file.steps[id] = { status: 'skipped', at: new Date().toISOString(), by };
  } else if (action === 'complete') {
    file.steps[id] = { status: 'complete', at: new Date().toISOString(), by };
  } else if (action === 'reset') {
    delete file.steps[id];
    if (id === 'health') delete file.health;
  } else {
    throw new Error(`unknown wizard action: ${String(action)}`);
  }
  writeOnboardingFile(file);
  return wizard(probes);
}

/** "Run setup wizard" again: forget every decision (probes still decide). */
export function wizardReset(probes: Partial<WizardProbes> = {}): WizardView {
  const file = readOnboardingFile();
  file.steps = {};
  delete file.health;
  writeOnboardingFile(file);
  return wizard(probes);
}

/**
 * `install.sh --unattended` (B1): the env file carries ARIGAMI_UNATTENDED=1 plus
 * whatever tokens the operator had. Steps whose probes are satisfied by those
 * values are green by themselves; every SKIPPABLE step still open is marked
 * skipped (by:'unattended') so the wizard is done the moment pairing lands and
 * the UI never shows it. Pairing itself is never auto-completed.
 */
export function unattendedPrecomplete(probes: Partial<WizardProbes> = {}): WizardView | null {
  const p: WizardProbes = { ...defaultProbes, ...probes };
  if (!p.unattended()) return null;
  const view = wizard(probes);
  const file = readOnboardingFile();
  let changed = false;
  for (const s of view.steps) {
    if (settled(s.status) || !SKIPPABLE[s.id]) continue;
    file.steps[s.id] = { status: 'skipped', at: new Date().toISOString(), by: 'unattended' };
    changed = true;
  }
  if (changed) writeOnboardingFile(file);
  return wizard(probes);
}

// --- health -----------------------------------------------------------------------

let healthRunning = false;

export interface HealthDeps {
  claudePing?: () => Promise<string>;
  desktopDisplay?: () => string | null; // ':99' when a desktop is configured
  chromeVersion?: () => string | null;
  whatsapp?: () => string;
  screenEnabled?: () => boolean;
}

// Shared with lib/chrome.ts's chromeBin() (the actual launch) via
// chromeCandidates() — the same ordered list, so the health-check probe and
// the real browser never disagree about what "Chrome" means on this host.
function chromeVersionSync(): string | null {
  for (const b of chromeCandidates()) {
    const bin = path.isAbsolute(b) ? b : which(b);
    if (!bin) continue;
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

export function desktopUpSync(display: string): boolean {
  const xdpy = which('xdpyinfo');
  if (!xdpy) {
    // No xdpyinfo: the X socket is the next best evidence.
    const n = display.replace(/^:/, '').split('.')[0];
    return fs.existsSync(`/tmp/.X11-unix/X${n}`);
  }
  try {
    return spawnSync(xdpy, ['-display', display], { encoding: 'utf8', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** S1 capabilities registry reuses the same desktop gate. */
export const desktopUp = (display: string): boolean => desktopUpSync(display);

export async function runHealth(deps: HealthDeps = {}): Promise<HealthResult> {
  if (healthRunning) throw new Error('health check already running');
  healthRunning = true;
  const checks: HealthCheck[] = [];
  try {
    // 1) Claude one-shot — the only check that spends a (tiny) request.
    const ping = deps.claudePing ?? (async () => {
      const os = await import('./lib/oneshot.js');
      const engine = os.hostEngine();
      const out = await os.runOneShot('Reply with exactly the single word: pong', { engine, timeoutMs: 90_000, tag: 'wizard-health' });
      return engine === 'claude' ? out : `${engine}: ${out}`;
    });
    try {
      const out = (await ping()).trim();
      checks.push({ id: 'claude', ok: true, required: true, detail: out.slice(0, 80) || 'ok' });
    } catch (e) {
      checks.push({ id: 'claude', ok: false, required: true, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
    // 2) Desktop — required only when screen is enabled in config.
    const screenOn = deps.screenEnabled ? deps.screenEnabled() : !!cfg.screen?.enabled;
    const display = deps.desktopDisplay ? deps.desktopDisplay() : screenOn ? cfg.screen?.display || ':99' : null;
    if (!display) checks.push({ id: 'desktop', ok: true, required: false, detail: 'screen disabled (server profile)' });
    else {
      const up = desktopUpSync(display);
      checks.push({ id: 'desktop', ok: up, required: screenOn, detail: up ? `display ${display} up` : `display ${display} not reachable` });
    }
    // 3) Chrome — required only with a desktop.
    const cv = deps.chromeVersion ? deps.chromeVersion() : chromeVersionSync();
    checks.push({ id: 'chrome', ok: !!cv, required: !!display, detail: cv || 'no Chrome/Chromium binary found' });
    // 4) WhatsApp — informational.
    const wa = deps.whatsapp ? deps.whatsapp() : defaultProbes.integrations().whatsapp;
    checks.push({ id: 'whatsapp', ok: wa === 'connected', required: false, detail: wa });
  } finally {
    healthRunning = false;
  }
  const result: HealthResult = { ok: checks.every((c) => c.ok || !c.required), at: new Date().toISOString(), checks };
  const file = readOnboardingFile();
  file.health = result;
  writeOnboardingFile(file);
  return result;
}

// --- fixers used by the wizard's POST actions ----------------------------------------

/** Git PAT → ~/.git-credentials (same shape as the container entrypoint) + GH_TOKEN for gh. */
export function setGitToken(token: string, host = 'github.com'): { ok: true; file: string } {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9_\-.]{20,}$/.test(t)) throw new Error('that does not look like a GitHub token');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('invalid host');
  const file = path.join(HOME, '.git-credentials');
  const line = `https://x-access-token:${t}@${host}`;
  const existing = safeRead(file).split('\n').filter((l) => l && !l.endsWith(`@${host}`));
  fs.writeFileSync(file, [...existing, line].join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  try {
    spawnSync('git', ['config', '--global', 'credential.helper', 'store'], { timeout: 5000 });
  } catch {
    /* git missing — the credentials file is still useful once it is installed */
  }
  process.env.GH_TOKEN = t;
  return { ok: true, file };
}

/** Composio key → config.json (same place the Integrations view's CLI-login writes). */
export function setComposioKey(key: string): { ok: true } {
  const k = String(key || '').trim();
  if (k.length < 8) throw new Error('composio key too short');
  const configPath = (cfg as any).configFile as string;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    /* fresh */
  }
  data.composioApiKey = k;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
  (cfg as any).composioApiKey = k;
  return { ok: true };
}

/**
 * Pasted Anthropic credential. An OAuth token (sk-ant-oat…) becomes an account
 * (accounts.js — what sessions actually use); an API key (sk-ant-api…) is
 * stored in $ARIGAMI_DIR/secrets.env as ANTHROPIC_API_KEY and exported into
 * this process so the gate turns green now, not after a restart.
 */
export async function setClaudeToken(token: string, label?: string): Promise<{ ok: true; kind: 'oauth' | 'api-key' }> {
  const t = String(token || '').trim();
  if (!t || /\s/.test(t) || t.length < 20) throw new Error('paste the whole token (no spaces)');
  const isApiKey = /^sk-ant-api/.test(t);
  // F3 #2: prove the credential works BEFORE it is stored — a mistyped/revoked
  // token used to be saved and the step marked "connected" regardless.
  await verifyClaudeCredential(isApiKey ? { apiKey: t } : { token: t });
  if (isApiKey) {
    const sec = await import('./lib/secrets.js');
    const file = sec.SECRETS_ENV;
    const lines = safeRead(file).split('\n').filter((l) => l && !l.startsWith('ANTHROPIC_API_KEY='));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...lines, `ANTHROPIC_API_KEY=${t}`].join('\n') + '\n', { mode: 0o600 });
    process.env.ANTHROPIC_API_KEY = t;
    return { ok: true, kind: 'api-key' };
  }
  const acc = await import('./accounts.js');
  (acc as any).addTokenAccount({ label: label || 'wizard', token: t });
  return { ok: true, kind: 'oauth' };
}

export const TOKEN_VERIFY_TIMEOUT_MS = 60_000;

/**
 * The cheapest real auth probe we have: a one-shot `claude -p` with ONLY the
 * candidate credential in its env (server/lib/oneshot.ts strips the host's
 * own). A dead token comes back as `is_error` ("OAuth access token has been
 * revoked" / "Not logged in") → a clear, user-facing error; a timeout or a
 * missing CLI is reported as such rather than silently accepted.
 */
export async function verifyClaudeCredential(cred: { token?: string; apiKey?: string }): Promise<void> {
  const { runClaudeOneShot } = await import('./lib/oneshot.js');
  try {
    await runClaudeOneShot('Reply with the single word: pong', {
      ...cred,
      model: 'haiku',
      timeoutMs: TOKEN_VERIFY_TIMEOUT_MS,
      tag: 'wizard-token-verify',
    });
  } catch (e: any) {
    const raw = String(e?.message || e || '');
    if (/ENOENT/.test(raw)) throw new Error('claude CLI not found — install it first (see the wizard)');
    const reason = raw.replace(/^claude exited \d+:?\s*/, '').trim();
    throw new Error(`token rejected by Claude — not saved${reason ? `: ${reason}` : ' (no response before the timeout)'}`);
  }
}

// --- doctor (CLI) ------------------------------------------------------------------------
// `bin/host doctor` → `bun server/onboarding.ts doctor` — same steps, same
// statuses, no host needed (the funnel is left untouched: ARIGAMI_FUNNEL_QUIET).

export function formatDoctor(view: WizardView): string {
  const mark: Record<WizardStatus, string> = { ok: '✓', skipped: '–', todo: '○', blocked: '⊘', error: '✗', running: '…' };
  const lines = view.steps.map((s) => `  ${mark[s.status]} ${s.id.padEnd(13)} ${s.status.padEnd(8)} ${s.detail || ''}`);
  lines.push(`  mode: ${view.mode} (required: ${view.required.join(', ')})`);
  lines.push(view.done ? `  wizard: done${view.completedAt ? ` (${view.completedAt})` : ''}` : `  wizard: current step → ${view.current}`);
  return lines.join('\n');
}

if (import.meta.main && process.argv[2] === 'doctor') {
  process.env.ARIGAMI_FUNNEL_QUIET = '1';
  console.log(formatDoctor(wizard()));
}
