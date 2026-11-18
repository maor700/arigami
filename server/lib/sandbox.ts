// Restricted sessions in a sandbox — the standalone-install isolation (docs/SANDBOX.md).
//
// With `sandbox.mode: 'docker'`, a RESTRICTED session's engine (claude or codex — this wraps whatever the engine
// driver built, so it is engine-agnostic) runs in its own container:
//
//   - no host secrets: its env is the restricted allowlist (session-env.ts); its HOME is a fresh per-session dir; the
//     only host paths it sees are its own working tree (+ the repo's git dir), its scratch dir, its codex home and
//     the read-only Arigami code it needs (skills, docs, the policy hook) — never $ARIGAMI_DIR, the owner's home, the
//     gatekeeper store or any token file;
//   - no root: a non-root uid, all capabilities dropped, no-new-privileges, an image without sudo;
//   - no network but the egress proxy: the container sits on an --internal network. Its own host is reachable at the
//     very same ARIGAMI_URL as before (a loopback forwarder inside the container → the relay → the host's sandbox
//     listener, which takes nothing but a sandboxed session's own token); everything else goes through the egress
//     proxy, which lets through the model API plus whatever the profile's `egress` names, and logs every refusal.
//
// A Full session never reaches this module: wrapSpawn returns the very object it was given when the session has no
// profile or the sandbox is off.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config.js';
import { ARIGAMI_DIR } from './instance.js';
import { HOME, isWin } from './platform.js';
import { resourceRoot } from './resource-root.js';
import * as infra from './sandbox-infra.js';

// ---- egress allowlist ----------------------------------------------------------------------------------------------

/** What every sandbox may reach: the engines' model APIs (claude: Anthropic; codex: OpenAI / ChatGPT). */
export const MODEL_HOSTS = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'auth.openai.com'];

/** Named egress groups a profile's `egress` may list. cfg.sandbox.egressGroups adds or overrides. */
export const EGRESS_GROUPS: Record<string, string[]> = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  github: ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'],
  crates: ['crates.io', 'index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
};

/** A profile's egress entries → host patterns. Groups expand; an entry with a dot is a host pattern; others drop. */
export function expandEgress(entries: string[], groups: Record<string, string[]> = EGRESS_GROUPS): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (groups[e]) for (const h of groups[e]) out.add(h.toLowerCase());
    else if (e.includes('.')) out.add(e.toLowerCase());
  }
  return [...out];
}

/** Does `host` match a pattern (`a.b` exactly, `*.a.b` = any subdomain of a.b, not a.b itself)? */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

// ---- names ---------------------------------------------------------------------------------------------------------

export const enabled = (): boolean => cfg.sandbox?.mode === 'docker' || cfg.sandbox?.mode === 'sidecar';
/** The sandbox is a container of the host's own pod (Helm chart `isolation.sandbox`), not a container per session. */
export const sidecarMode = (): boolean => cfg.sandbox?.mode === 'sidecar';
export const SIDECAR_AGENT = (): string => cfg.sandbox?.agent || '127.0.0.1:3299';
export const SIDECAR_EGRESS = (): string => cfg.sandbox?.egress || '127.0.0.1:3128';
/** Is this session run in a sandbox? Restricted (has a profile) and the sandbox is on. */
export const isSandboxed = (s: { profile?: unknown } | null | undefined): boolean => enabled() && !!s?.profile;

// the port in ARIGAMI_URL (cfg.hostBase is built from it)
const hostPort = (): number => cfg.port;
export const instanceTag = (): string => crypto.createHash('sha256').update(`${ARIGAMI_DIR}:${hostPort()}`).digest('hex').slice(0, 8);
export const prefix = (): string => `arigami-sbx-${instanceTag()}`;
export const containerName = (sessionId: string): string => `${prefix()}-${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
export const SANDBOX_DIR = (): string => path.join(ARIGAMI_DIR, 'sandbox');
export const egressDir = (): string => path.join(SANDBOX_DIR(), 'egress');
/** The session's own HOME inside its container (same path on the host: the runner/host read its engine logs there). */
export const sessionHome = (sessionId: string): string => path.join(SANDBOX_DIR(), 'sessions', sessionId, 'home');
export const proxyLog = (): string => path.join(egressDir(), 'proxy.log');
const dockerBin = () => cfg.sandbox?.docker || 'docker';
const image = () => cfg.sandbox?.image || 'arigami-sandbox:latest';
const userSpec = () => (isWin || typeof process.getuid !== 'function' ? '1000:1000' : `${process.getuid()}:${process.getgid!()}`);

/** A host path as the docker daemon sees it (cfg.sandbox.pathMap: the host itself runs in a container). */
export function daemonPath(p: string, map: { from: string; to: string }[] = cfg.sandbox?.pathMap || []): string {
  for (const m of [...map].sort((a, b) => b.from.length - a.from.length)) {
    const from = m.from.replace(/\/+$/, '');
    if (p === from || p.startsWith(from + '/')) return m.to.replace(/\/+$/, '') + p.slice(from.length);
  }
  return p;
}

export function infraSpec(): infra.InfraSpec {
  const sb = cfg.sandbox || ({ mode: 'off' } as const);
  const pre = prefix();
  const outside = sb.outsideNetwork || `${pre}-out`;
  return {
    docker: dockerBin(),
    prefix: pre,
    tag: instanceTag(),
    image: image(),
    internal: `${pre}-int`,
    outside,
    outsideExternal: !!sb.outsideNetwork,
    ...(sb.subnet ? { subnet: sb.subnet } : {}),
    egress: `${pre}-egress`,
    egressDir: egressDir(),
    egressDirSource: daemonPath(egressDir()),
    codeDirSource: daemonPath(path.join(resourceRoot(), 'docker', 'sandbox')),
    user: userSpec(),
    ...(sb.dns?.length ? { dns: sb.dns } : {}),
  };
}

// ---- mounts --------------------------------------------------------------------------------------------------------

export interface Mount { host: string; target: string; ro: boolean }

/** Arigami's own code a session may see (read-only): what the plugin dir, the skills and the policy hook load. */
export const ROOT_SUBTREES = ['.claude-plugin', 'skills', 'docs', 'mcp', 'mods', 'commands', 'agents', 'hooks'];

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
/** p is `dir` itself or one of its ancestors (mounting it would expose dir). */
const covers = (p: string, dir: string) => within(dir, p);

export interface PlanFs {
  exists(p: string): boolean;
  realpath(p: string): string | null;
  readlink(p: string): string | null;
  /** Top-level symlinks of a directory: [link path, its target]. */
  links(dir: string): [string, string][];
  /** The repo a directory belongs to: its top level and its git common dir (null = not a repo). */
  git(dir: string): { top: string; common: string } | null;
}

export interface PlanInput {
  sessionId: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  root: string;
  arigamiDir: string;
  home: string;
  /** Where restricted work may live under $ARIGAMI_DIR (repos, workspace). */
  workAreas: string[];
}

/** Absolute-path tokens inside a string (an argv entry, a JSON blob, an env value). POSIX paths. */
export function pathTokens(s: string): string[] {
  return (String(s).match(/\/[^\s"'`\\:;,|<>(){}[\]]+/g) || []).map((t) => t.replace(/[.]+$/, '')).filter((t) => t.length > 1);
}

/**
 * Which host paths the container gets, or why the session must not start. Only these are mounted: the working tree
 * (+ git common dir) rw, scratch rw, codex home rw (+ its auth file), the per-session HOME rw, and read-only Arigami
 * code / user skills the argv names. Nothing else of the host — and never an ancestor of $HOME, $ARIGAMI_DIR or the
 * checkout.
 */
export interface CredentialLink {
  /** The account's login file the link resolves to (host side — read once to stage a copy, never mounted). */
  source: string;
  /** Where the engine looks for it inside the container (the link's own target path). */
  target: string;
}

export function planMounts(i: PlanInput, fsx: PlanFs): { mounts: Mount[]; codexAuth?: CredentialLink; refused?: string } {
  const mounts = new Map<string, Mount>();
  const add = (host: string, target: string, ro: boolean) => {
    const prev = mounts.get(target);
    if (!prev || (prev.ro && !ro)) mounts.set(target, { host, target, ro });
  };
  const protectedDirs = [i.home, i.arigamiDir, i.root, path.parse(i.cwd || '/').root || '/'];
  const unsafe = (p: string): string | null => {
    for (const d of protectedDirs) if (covers(p, d)) return `${p} would expose ${d}`;
    if (within(p, i.arigamiDir) && !i.workAreas.some((w) => within(p, w))) return `${p} is inside the host's state dir`;
    return null;
  };
  // 1. the working tree (+ the repo's git dir) — read-write
  const cwd = fsx.realpath(i.cwd) || i.cwd;
  const g = fsx.git(cwd);
  const top = g?.top || cwd;
  const why = unsafe(top);
  if (why) return { mounts: [], refused: `the session's folder cannot be mounted in its sandbox: ${why}. Give it a project folder of its own.` };
  add(top, top, false);
  if (g?.common && !within(g.common, top)) {
    const w = unsafe(g.common);
    if (w) return { mounts: [], refused: `the repo's git dir cannot be mounted in its sandbox: ${w}` };
    add(g.common, g.common, false);
  }
  if (i.cwd !== cwd && !within(i.cwd, top)) add(top, i.cwd, false); // a symlinked cwd: the same tree under its own name
  // 2. per-session dirs the host made for it — read-write
  const own = (p: string | undefined, rel: string) => (p && fsx.exists(p) && within(p, path.join(i.arigamiDir, rel)) ? p : null);
  const scratch = own(i.env.TMPDIR, 'scratch');
  if (scratch) add(scratch, scratch, false);
  const codexHome = own(i.env.CODEX_HOME, 'codex');
  let codexAuth: CredentialLink | undefined;
  if (codexHome) {
    add(codexHome, codexHome, false);
    // Its auth.json links to the account's login file (often under the owner's home). That file is NEVER mounted:
    // the caller stages a minimal read-only copy under $ARIGAMI_DIR and mounts it at the link's target.
    for (const [link, target] of fsx.links(codexHome)) {
      if (path.basename(link) !== 'auth.json') continue;
      const real = fsx.realpath(link);
      if (real) codexAuth = { source: real, target };
    }
  }
  // 3. read-only code / skills the argv and env name
  const ROOT_OK = ROOT_SUBTREES.map((d) => path.join(i.root, d));
  const ARI_OK = ['user-plugin', 'ext-plugin', 'skills', 'user/skills'].map((d) => path.join(i.arigamiDir, d));
  const roCandidate = (p: string) => {
    if (within(p, i.root)) {
      if (p === i.root) {
        for (const d of ROOT_OK) if (fsx.exists(d)) add(d, d, true);
        return;
      }
      const hit = ROOT_OK.find((d) => within(p, d));
      if (hit && fsx.exists(hit)) add(hit, hit, true);
      return;
    }
    if (within(p, i.arigamiDir)) {
      const hit = ARI_OK.find((d) => within(p, d));
      if (!hit || !fsx.exists(hit)) return;
      add(fsx.realpath(hit) || hit, hit, true);
      // plugin dirs link their skills dir elsewhere under $ARIGAMI_DIR: mount what they point at, under that name
      for (const [, target] of fsx.links(hit)) {
        const t = path.resolve(hit, target);
        const okT = ARI_OK.find((d) => within(t, d));
        if (okT && fsx.exists(t)) add(fsx.realpath(t) || t, t, true);
      }
    }
  };
  const skip = new Set(['HOME', 'PATH', 'TMPDIR', 'CODEX_HOME', 'PWD', 'ARIGAMI_DIR', 'ARIGAMI_TERMINAL_CWD']);
  const strings = [...i.args, ...Object.entries(i.env).filter(([k]) => !skip.has(k)).map(([, v]) => v)];
  for (const s of strings) for (const t of pathTokens(s)) {
    let p = t;
    while (p.length > 1 && !fsx.exists(p)) p = path.dirname(p);
    if (p.length > 1) roCandidate(p);
  }
  // 3b. every plugin dir the engine is given (extension mods live in their extension's dir): read-only, never one
  // that would expose the home, the state dir or the checkout root
  for (let k = 0; k < i.args.length - 1; k++) {
    if (i.args[k] !== '--plugin-dir') continue;
    const d = i.args[k + 1];
    if (!d || d === i.root || !fsx.exists(d) || [i.home, i.arigamiDir, i.root].some((p) => covers(d, p))) continue;
    if (within(d, i.root) || within(d, i.arigamiDir) || !within(d, i.home)) add(fsx.realpath(d) || d, d, true);
  }
  // 4. its own HOME
  const h = path.join(i.arigamiDir, 'sandbox', 'sessions', i.sessionId, 'home');
  add(h, h, false);
  return { mounts: [...mounts.values()].sort((a, b) => a.target.length - b.target.length), ...(codexAuth ? { codexAuth } : {}) };
}

const realFs: PlanFs = {
  exists: (p) => fs.existsSync(p),
  realpath: (p) => {
    try { return fs.realpathSync(p); } catch { return null; }
  },
  readlink: (p) => {
    try { return fs.readlinkSync(p); } catch { return null; }
  },
  links: (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isSymbolicLink()).map((e) => {
        const l = path.join(dir, e.name);
        return [l, path.resolve(dir, fs.readlinkSync(l))] as [string, string];
      });
    } catch { return []; }
  },
  git: (dir) => {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    const [top, common] = String(r.stdout).trim().split('\n');
    if (!top) return null;
    return { top: fs.realpathSync(top), common: common ? fs.realpathSync(path.resolve(dir, common)) : '' };
  },
};

// ---- the spawn -----------------------------------------------------------------------------------------------------

/** Env keys that are host-side plumbing and mean nothing (or the wrong thing) inside the container. */
const DROP_ENV = ['PATH', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'BUN_INSTALL', 'NVM_DIR', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SHELL', 'USER', 'LOGNAME', 'PWD'];

export interface LaunchSpec {
  v: 1;
  sessionId: string;
  name: string;
  image: string;
  infra: infra.InfraSpec;
  user: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  mounts: { source: string; target: string; ro: boolean }[];
  forwardPort: number;
  limits: { memory: string; cpus: string; pids: number };
  /** Host files that exist only for this run (the staged credential) — the launcher removes them when it ends. */
  ephemeral?: string[];
  error?: string;
}

/** The engine credentials in the env each engine may keep; the other engine's never enter its container. */
export const ENGINE_ENV_CREDENTIALS: Record<string, string[]> = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
};
const ALL_ENV_CREDENTIALS = [...new Set(Object.values(ENGINE_ENV_CREDENTIALS).flat())];

/**
 * A codex login (auth.json) reduced to what a turn needs: the API key or the access/id token and account id. The
 * refresh token — the long-lived half — never enters a sandbox: the host keeps the login fresh and every spawn
 * stages a new copy. null = not a codex login.
 */
export function minimalCodexAuth(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, any>;
  const out: Record<string, unknown> = {};
  if (typeof a.auth_mode === 'string') out.auth_mode = a.auth_mode;
  if ('OPENAI_API_KEY' in a) out.OPENAI_API_KEY = typeof a.OPENAI_API_KEY === 'string' ? a.OPENAI_API_KEY : null;
  if (a.tokens && typeof a.tokens === 'object') {
    const t: Record<string, unknown> = {};
    for (const k of ['id_token', 'access_token', 'account_id']) if (typeof a.tokens[k] === 'string') t[k] = a.tokens[k];
    // codex's login schema requires the field: it stays, EMPTY — the refresh token itself never leaves the host
    if (Object.keys(t).length) out.tokens = { ...t, refresh_token: '' };
  }
  if (typeof a.last_refresh === 'string') out.last_refresh = a.last_refresh;
  return out.tokens || typeof out.OPENAI_API_KEY === 'string' ? out : null;
}

/** Stage the minimal copy under the session's own sandbox dir (unique per launch, 0400). Returns its path or null. */
function stageCodexAuth(sessionId: string, source: string): string | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { return null; }
  const min = minimalCodexAuth(raw);
  if (!min) return null;
  const dir = path.join(SANDBOX_DIR(), 'sessions', sessionId, 'cred');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `codex-auth.${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, JSON.stringify(min), { mode: 0o400 });
  return f;
}

const secretOf = (key: string, sessionId: string) => crypto.createHmac('sha256', key).update(sessionId).digest('base64url').slice(0, 32);

function egressKey(): string {
  const f = path.join(egressDir(), 'key');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    fs.mkdirSync(egressDir(), { recursive: true, mode: 0o700 });
    const k = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, k, { mode: 0o600 });
    return k;
  }
}

/** The allowlist file the egress proxy reads for this session. */
export function writePolicy(sessionId: string, profile: { name?: string; egress?: string[] } | null | undefined): string[] {
  const groups = { ...EGRESS_GROUPS, ...(cfg.sandbox?.egressGroups || {}) };
  const allow = [...new Set([...(cfg.sandbox?.egressBase || MODEL_HOSTS), ...expandEgress(profile?.egress || [], groups)])];
  const dir = path.join(egressDir(), 'policies');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ session: sessionId, profile: profile?.name || null, allow }), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
  return allow;
}

/**
 * The owner's git author name/email — and nothing else of their git config (no credential helpers, no url rewrites,
 * no includes) — so commits made in the sandbox carry the same author as on the host.
 */
function seedGitIdentity(home: string): void {
  const f = path.join(home, '.gitconfig');
  if (fs.existsSync(f)) return;
  const get = (k: string) => {
    const r = spawnSync('git', ['config', '--global', '--get', k], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0 ? String(r.stdout).trim().replace(/[\r\n"\\]/g, '') : '';
  };
  const name = get('user.name'), email = get('user.email');
  if (!name && !email) return;
  fs.writeFileSync(f, `[user]\n${name ? `\tname = "${name}"\n` : ''}${email ? `\temail = "${email}"\n` : ''}`, { mode: 0o600 });
}

const LAUNCHER = () => path.join(resourceRoot(), 'server', 'lib', 'sandbox-launch.ts');

type Built = { bin: string; args: string[]; env: Record<string, string | undefined>; cwd: string };

/**
 * The spawn that actually runs: `built` itself for a Full session (or with the sandbox off), else the launcher that
 * starts the same engine argv in the session's container. The launcher carries no session env of its own (the
 * kit-direct probe and the host's process sweep find the ENGINE by ARIGAMI_SESSION_ID — inside the container).
 */
export function wrapSpawn<T extends Built>(s: { id: string; profile?: { name?: string; egress?: string[] } | null } | null | undefined, built: T, engineId: string): T | Built {
  if (!s || !isSandboxed(s)) return built;
  if (sidecarMode()) return wrapSidecar(s as { id: string; profile: { name?: string; egress?: string[] } }, built, engineId);
  const spec = launchSpec(s as { id: string; profile: { name?: string; egress?: string[] } }, built, engineId);
  const dir = path.join(SANDBOX_DIR(), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${s.id}.${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, JSON.stringify(spec), { mode: 0o600 });
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'LANG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'TMPDIR', 'TEMP', 'TMP'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return { bin: process.execPath, args: [LAUNCHER(), f], env, cwd: SANDBOX_DIR() };
}

export function launchSpec(s: { id: string; profile: { name?: string; egress?: string[] } }, built: Built, engineId: string): LaunchSpec {
  const sb = cfg.sandbox || ({ mode: 'docker' } as const);
  const root = resourceRoot();
  const base: Omit<LaunchSpec, 'argv' | 'env' | 'mounts'> = {
    v: 1,
    sessionId: s.id,
    name: containerName(s.id),
    image: image(),
    infra: infraSpec(),
    user: userSpec(),
    cwd: built.cwd,
    forwardPort: hostPort(),
    limits: { memory: sb.memory || '4g', cpus: sb.cpus || '2', pids: Number(sb.pids) || 1024 },
  };
  // Container paths are POSIX and identical to the host's: a Windows host needs pathMap first (docs/SANDBOX.md).
  if (isWin && !(sb.pathMap || []).length) return { ...base, argv: [], env: {}, mounts: [], error: 'the sandbox on a Windows host needs sandbox.pathMap (docs/SANDBOX.md § Platforms)' };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(built.env)) if (v !== undefined && !DROP_ENV.includes(k)) env[k] = String(v);
  const workAreas = [cfg.reposDir, path.join(ARIGAMI_DIR, 'workspace'), path.join(ARIGAMI_DIR, 'repos'), path.join(ARIGAMI_DIR, 'worktrees')].filter(Boolean).map((p) => path.resolve(p));
  const plan = planMounts({ sessionId: s.id, cwd: built.cwd, args: built.args, env, root, arigamiDir: ARIGAMI_DIR, home: HOME, workAreas }, realFs);
  if (plan.refused) return { ...base, argv: [], env: {}, mounts: [], error: plan.refused };
  // Only this engine's own credential: the other engine's env key never enters the container.
  const keepCred = ENGINE_ENV_CREDENTIALS[engineId] || [];
  for (const k of ALL_ENV_CREDENTIALS) if (!keepCred.includes(k)) delete env[k];
  const ephemeral: string[] = [];
  const extraMounts: Mount[] = [];
  if (engineId === 'codex' && plan.codexAuth) {
    const staged = stageCodexAuth(s.id, plan.codexAuth.source);
    if (!staged) return { ...base, argv: [], env: {}, mounts: [], error: `the codex login (${plan.codexAuth.source}) is unreadable or has no token — sign codex in again` };
    ephemeral.push(staged);
    extraMounts.push({ host: staged, target: plan.codexAuth.target, ro: true });
  }
  const home = sessionHome(s.id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  seedGitIdentity(home);
  writePolicy(s.id, s.profile);
  const cred = `${encodeURIComponent(s.id)}:${secretOf(egressKey(), s.id)}`;
  const proxy = `http://${cred}@${infra.PROXY_ALIAS}:${infra.PROXY_PORT}`;
  Object.assign(env, {
    HOME: home,
    PATH: `${home}/.local/bin:${home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    USER: 'sandbox',
    SHELL: '/bin/bash',
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    ARIGAMI_SANDBOX: 'docker',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const engine = sb.engines?.[engineId] || engineId;
  return {
    ...base,
    argv: [engine, ...built.args],
    env,
    mounts: [...plan.mounts, ...extraMounts].map((m) => ({ source: daemonPath(m.host), target: m.target, ro: m.ro })),
    ...(ephemeral.length ? { ephemeral } : {}),
  };
}

// ---- sidecar mode (a sandbox container in the host's own pod) ------------------------------------------------------
//
// The pod (Helm chart `isolation.sandbox`) has a `sandbox` container next to the host's: no secrets, no sudo, a
// different primary group that the pod's packet filter lets reach only the host's API port and the egress proxy on
// the pod's loopback, and only cfg.sandbox.workRoots of the shared disk (plus the per-session HOMEs under
// $ARIGAMI_DIR/sandbox/sessions). Its agent (docker/sandbox/sidecar-agent.ts) starts the engine there; the host's
// launcher (sandbox-sidecar-launch.ts) relays the engine's stdio. Same rules as a container per session: the
// restricted env, this engine's credential only, a per-session HOME and TMPDIR, the egress policy of its profile.

const SIDECAR_LAUNCHER = () => path.join(resourceRoot(), 'server', 'lib', 'sandbox-sidecar-launch.ts');

/** Why a restricted session's folder cannot run in the sidecar (it is not inside a shared work root), or null. */
export function sidecarCwdError(cwd: string, roots: string[], guard: { home: string; arigamiDir: string; root: string }, fsx: Pick<PlanFs, 'realpath' | 'git'> = realFs): string | null {
  if (!roots.length) return 'the sandbox sidecar has no shared work roots (sandbox.workRoots)';
  const real = fsx.realpath(cwd) || cwd;
  const g = fsx.git(real);
  for (const p of [real, g?.top, g?.common].filter(Boolean) as string[]) {
    if (!roots.some((r) => within(p, r))) return `${p} is not in a folder the sandbox shares (${roots.join(', ')}). Give the session a project folder there.`;
    for (const d of [guard.home, guard.arigamiDir, guard.root]) if (covers(p, d)) return `${p} would expose ${d}`;
  }
  return null;
}

/** codex in the sidecar: its own CODEX_HOME under the session's sandbox dir, with the config and a staged login. */
function sidecarCodexHome(sessionId: string, hostCodexHome: string | undefined): { dir: string; staged?: string; error?: string } {
  const dir = path.join(SANDBOX_DIR(), 'sessions', sessionId, 'codex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let source: string | null = null;
  if (hostCodexHome && fs.existsSync(hostCodexHome)) {
    for (const e of fs.readdirSync(hostCodexHome, { withFileTypes: true })) {
      const from = path.join(hostCodexHome, e.name);
      if (e.name === 'auth.json') { try { source = fs.realpathSync(from); } catch {} continue; }
      // the host's config for this session (MCP servers, model, …): plain files only, refreshed at every launch
      if (e.isFile()) try { fs.copyFileSync(from, path.join(dir, e.name)); } catch {}
    }
  }
  if (!source) return { dir };
  const staged = stageCodexAuth(sessionId, source);
  if (!staged) return { dir, error: `the codex login (${source}) is unreadable or has no token — sign codex in again` };
  const auth = path.join(dir, 'auth.json');
  try { fs.rmSync(auth, { force: true }); } catch {}
  fs.copyFileSync(staged, auth);
  fs.chmodSync(auth, 0o400);
  fs.rmSync(staged, { force: true });
  return { dir, staged: auth };
}

export function sidecarSpec(s: { id: string; profile: { name?: string; egress?: string[] } }, built: Built, engineId: string): import('./sandbox-sidecar-launch.js').SidecarSpec {
  const base = { v: 1 as const, sessionId: s.id, agent: SIDECAR_AGENT(), cwd: built.cwd };
  const roots = (cfg.sandbox?.workRoots || []).map((r) => path.resolve(r));
  const why = sidecarCwdError(built.cwd, roots, { home: HOME, arigamiDir: ARIGAMI_DIR, root: resourceRoot() });
  if (why) return { ...base, argv: [], env: {}, error: `the session's folder cannot be used in its sandbox: ${why}` };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(built.env)) if (v !== undefined && !DROP_ENV.includes(k)) env[k] = String(v);
  const keepCred = ENGINE_ENV_CREDENTIALS[engineId] || [];
  for (const k of ALL_ENV_CREDENTIALS) if (!keepCred.includes(k)) delete env[k];
  const sessDir = path.join(SANDBOX_DIR(), 'sessions', s.id);
  const home = sessionHome(s.id);
  const tmp = path.join(sessDir, 'tmp');
  for (const d of [home, tmp]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  seedGitIdentity(home);
  const ephemeral: string[] = [];
  if (engineId === 'codex') {
    const c = sidecarCodexHome(s.id, env.CODEX_HOME);
    if (c.error) return { ...base, argv: [], env: {}, error: c.error };
    env.CODEX_HOME = c.dir;
    if (c.staged) ephemeral.push(c.staged);
  } else delete env.CODEX_HOME;
  writePolicy(s.id, s.profile);
  const cred = `${encodeURIComponent(s.id)}:${secretOf(egressKey(), s.id)}`;
  const proxy = `http://${cred}@${SIDECAR_EGRESS()}`;
  Object.assign(env, {
    HOME: home,
    TMPDIR: tmp,
    PATH: `${home}/.local/bin:${home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    USER: 'sandbox',
    SHELL: '/bin/bash',
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    ARIGAMI_SANDBOX: 'sidecar',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  // The engine binary: cfg.sandbox.engines, else the file the driver resolved, by its REAL path (an engine the host
  // installed in its home is a symlink into a versions dir the chart shares read-only — isolation.sandbox.engineDirs).
  let bin = cfg.sandbox?.engines?.[engineId] || built.bin;
  if (!cfg.sandbox?.engines?.[engineId]) try { bin = fs.realpathSync(built.bin); } catch {}
  return { ...base, argv: [bin, ...built.args], env, ...(ephemeral.length ? { ephemeral } : {}) };
}

function wrapSidecar(s: { id: string; profile: { name?: string; egress?: string[] } }, built: Built, engineId: string): Built {
  const spec = sidecarSpec(s, built, engineId);
  const dir = path.join(SANDBOX_DIR(), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${s.id}.${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, JSON.stringify(spec), { mode: 0o600 });
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return { bin: process.execPath, args: [SIDECAR_LAUNCHER(), f], env, cwd: SANDBOX_DIR() };
}

/** Boot in sidecar mode: the egress proxy's key and config (it shares $ARIGAMI_DIR/sandbox/egress), no listener. */
export async function startSidecar(log: (m: string) => void = console.log): Promise<SandboxStatus> {
  try {
    fs.mkdirSync(egressDir(), { recursive: true, mode: 0o700 });
    const run = path.join(SANDBOX_DIR(), 'run');
    for (const f of fs.existsSync(run) ? fs.readdirSync(run) : []) try { fs.rmSync(path.join(run, f), { force: true }); } catch {}
    const sessDir = path.join(SANDBOX_DIR(), 'sessions');
    for (const sid of fs.existsSync(sessDir) ? fs.readdirSync(sessDir) : []) {
      try { fs.rmSync(path.join(sessDir, sid, 'cred'), { recursive: true, force: true }); } catch {}
      try { fs.rmSync(path.join(sessDir, sid, 'codex', 'auth.json'), { force: true }); } catch {}
    }
    egressKey();
    const [, port] = SIDECAR_EGRESS().split(':');
    const f = path.join(egressDir(), 'config.json');
    // relayPort 0: no relay — the sandbox shares the pod's loopback with the host and reaches its API directly
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ proxyPort: Number(port) || 3128, relayPort: 0, bind: '127.0.0.1', updatedAt: new Date().toISOString() }, null, 2), { mode: 0o640 });
    fs.renameSync(`${f}.tmp`, f);
    if (!(cfg.sandbox?.workRoots || []).length) throw new Error('sandbox.workRoots is empty: the sidecar shares no folder with the host');
    Object.assign(status, { ready: true, listen: null, target: SIDECAR_AGENT(), error: null });
    log(`[sandbox] restricted sessions run in the pod's sandbox sidecar (agent ${SIDECAR_AGENT()}, egress ${SIDECAR_EGRESS()}, work roots ${(cfg.sandbox?.workRoots || []).join(', ')})`);
  } catch (e) {
    Object.assign(status, { ready: false, error: (e as Error).message });
    log(`[sandbox] NOT ready — restricted sessions will refuse to start: ${(e as Error).message}`);
  }
  return sandboxStatus();
}

// ---- the host's sandbox listener -----------------------------------------------------------------------------------

export interface SandboxStatus { enabled: boolean; ready: boolean; listen: string | null; target: string | null; error: string | null; image: string; prefix: string }
const status: SandboxStatus = { enabled: false, ready: false, listen: null, target: null, error: null, image: '', prefix: '' };
export const sandboxStatus = (): SandboxStatus => ({ ...status, enabled: enabled(), image: image(), prefix: prefix() });

/** Headers a client behind the relay must not be able to set (the host would read them as a proxy's). */
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip'];

export interface ListenerDeps {
  /** The session a request's bearer token belongs to (auth.sessionFromBearer). */
  sessionOf(req: IncomingMessage): string | null;
  getSession(id: string): { id: string; profile?: unknown } | null;
  /** The host's own request handler (server.emit('request')). */
  handle(req: IncomingMessage, res: ServerResponse): void;
}

/** A request arriving through the relay: only a sandboxed session's own token gets past this, never a cookie/admin. */
export function sandboxGate(req: IncomingMessage, res: ServerResponse, deps: Pick<ListenerDeps, 'sessionOf' | 'getSession'>): boolean {
  for (const h of FORWARDED) delete req.headers[h];
  delete req.headers.cookie;
  const sid = deps.sessionOf(req);
  const s = sid ? deps.getSession(sid) : null;
  if (s && isSandboxed(s)) return false;
  res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'sandbox relay: only a sandboxed session with its own token' }));
  return true;
}

function parseListen(v: string | undefined): { host: string | null; port: number } {
  if (!v) return { host: null, port: 0 };
  const m = /^(.*?)(?::(\d+))?$/.exec(v.trim())!;
  return { host: m[1] || null, port: Number(m[2] || 0) };
}

function writeEgressConfig(target: string): void {
  fs.mkdirSync(egressDir(), { recursive: true, mode: 0o700 });
  egressKey();
  const f = path.join(egressDir(), 'config.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ hostTarget: target, proxyPort: infra.PROXY_PORT, relayPort: infra.RELAY_PORT, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

let server: http.Server | null = null;

/**
 * Boot: sweep the previous run's session containers, make the networks, open the sandbox listener, point the egress
 * relay at it and start the egress container. Errors are kept in sandboxStatus() (a restricted spawn then fails with
 * the reason — it never falls back to running on the host).
 */
export async function startSandbox(deps: ListenerDeps, log: (m: string) => void = console.log): Promise<SandboxStatus> {
  if (!enabled()) return sandboxStatus();
  const spec = infraSpec();
  try {
    fs.mkdirSync(egressDir(), { recursive: true, mode: 0o700 });
    const ver = infra.docker(spec.docker, ['version', '--format', '{{.Server.Version}}'], 15_000);
    if (ver.code !== 0) throw new Error(`docker is not reachable (${ver.err.split('\n')[0] || 'no daemon'})`);
    const img = infra.docker(spec.docker, ['image', 'inspect', '-f', '{{.Id}}', spec.image], 15_000);
    if (img.code !== 0) throw new Error(`the sandbox image ${spec.image} is missing — build it: docker build -t ${spec.image} -f docker/sandbox/Dockerfile .`);
    // launch specs / env files a launcher that died early left behind (they hold a session's env)
    const run = path.join(SANDBOX_DIR(), 'run');
    for (const f of fs.existsSync(run) ? fs.readdirSync(run) : []) try { fs.rmSync(path.join(run, f), { force: true }); } catch {}
    // credentials staged for containers the previous run left (all of them are removed just below)
    const sessDir = path.join(SANDBOX_DIR(), 'sessions');
    for (const sid of fs.existsSync(sessDir) ? fs.readdirSync(sessDir) : []) try { fs.rmSync(path.join(sessDir, sid, 'cred'), { recursive: true, force: true }); } catch {}
    const gone = infra.removeContainers(spec.docker, infra.sessionContainers(spec));
    if (gone) log(`[sandbox] removed ${gone} session container(s) left from the previous run`);
    infra.withLock(egressDir(), () => infra.ensureNetworks(spec));
    const want = parseListen(cfg.sandbox?.hostListen);
    const native = process.platform === 'linux';
    const bindHost = want.host || (native ? infra.outsideGateway(spec) : '127.0.0.1');
    if (!bindHost) throw new Error(`cannot find the gateway of ${spec.outside}; set sandbox.hostListen`);
    server = http.createServer((req, res) => {
      if (sandboxGate(req, res, deps)) return;
      deps.handle(req, res);
    });
    server.on('upgrade', (_req, socket) => { try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {} });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(want.port, bindHost, () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const target = cfg.sandbox?.hostTarget || (native ? `${bindHost}:${port}` : `host.docker.internal:${port}`);
    writeEgressConfig(target);
    infra.withLock(egressDir(), () => infra.ensureEgress(spec));
    Object.assign(status, { ready: true, listen: `${bindHost}:${port}`, target, error: null });
    log(`[sandbox] restricted sessions run in containers (${spec.image}); host relay ${bindHost}:${port}, egress ${spec.egress}`);
    // The egress container is the only way out: bring it back if it dies (cheap: one inspect a minute).
    setInterval(() => {
      try { infra.withLock(egressDir(), () => infra.ensureEgress(spec), 5_000); } catch (e) { status.error = (e as Error).message; }
    }, 60_000).unref?.();
  } catch (e) {
    Object.assign(status, { ready: false, error: (e as Error).message });
    log(`[sandbox] NOT ready — restricted sessions will refuse to start: ${(e as Error).message}`);
  }
  return sandboxStatus();
}

/** For the API: where a sandboxed session lives (the bench's kit-direct enters it with `docker exec`). */
export function sessionSandbox(s: { id: string; profile?: unknown } | null | undefined) {
  if (!s || !isSandboxed(s)) return null;
  if (sidecarMode()) return { mode: 'sidecar', container: 'sandbox', home: sessionHome(s.id), agent: SIDECAR_AGENT(), proxyLog: proxyLog() };
  return { container: containerName(s.id), home: sessionHome(s.id), image: image(), network: `${prefix()}-int`, proxyLog: proxyLog(), docker: dockerBin() };
}
