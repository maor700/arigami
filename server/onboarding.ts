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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isWin, which, shellArgs, toPosixPath, HOME } from './lib/platform.js';
import { cfg } from './lib/config.js';
import { hasCredentials } from './accounts.js';

const CONFIG_DIR = cfg.configDir as string;
const REPOS_FILE = path.join(CONFIG_DIR, 'repos.json');

// profiles/ ships in the repo (server/../profiles); users can add their own.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
function repoPresent(r: RepoEntry): boolean {
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
// (seed-then-auto-fix), so the normal per-step provisioning then runs. Acme is
// the first profile (app only).
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
    for (const f of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Profile;
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
  const byName = new Map<string, RepoEntry>(listRepos().map((r) => [r.name, r]));
  for (const r of prof.repos || []) byName.set(r.name, { ...byName.get(r.name), ...r });
  writeRepos([...byName.values()]);
  return { applied: prof.name, repos: (prof.repos || []).map((r) => r.name) };
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
