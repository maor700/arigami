// The gatekeeper's own store — and the ONLY place its bot credentials live.
//
//   $ARIGAMI_DIR/gatekeeper/            (0700)
//     identities.json   0600  the bot credentials (GitHub App key, Slack bot token, Linear key, Sentry tokens)
//     config.json       0600  scope: the repo, the incident channel, operators, the Linear team, the Sentry project…
//     state.json        0600  thread bindings per session, approvals already used, branches pushed
//     audit.log         0600  one JSON line per decision (allowed / refused / failed) — what an auditor reads
//     git/<session>.git       bare mirrors the gatekeeper pushes from (never the session's own repo)
//
// Credentials never go into a session's env, argv, files or tool results, nor into extensions.json (whose secrets
// become a tool server's env). This process reads them per call; a status view shows only which ones are set.
import fs from 'node:fs';
import path from 'node:path';
import type { Binding } from './decide.ts';
import type { AutoRule } from './decide.ts';

export const DIR = process.env.GATEKEEPER_DIR || path.join(process.env.ARIGAMI_DIR || path.join(process.env.HOME || '.', '.arigami'), 'gatekeeper');
const f = (n: string) => path.join(DIR, n);

export interface Identities {
  github?: { appId?: string; installationId?: string; privateKey?: string };
  slack?: { botToken?: string };
  linear?: { apiKey?: string };
  sentry?: { token?: string; alertsToken?: string };
}

export interface Operator { id: string; name?: string }

export interface Config {
  github: {
    repo: string;
    apiUrl: string;
    webUrl: string;
    protectedBranches: string[];
    branchPattern: string | null;
    mergeMethod: 'merge' | 'squash' | 'rebase';
    allowForcePush: boolean;
    autoMerge: AutoRule;
  };
  slack: {
    apiUrl: string;
    channel: string;
    operators: Operator[];
    /** user / bot / app ids whose thread roots a session may bind itself to (operators always count) */
    threadOpeners: string[];
    bindOnFirstUse: boolean;
  };
  linear: { apiUrl: string; teamId: string; projectId: string | null };
  sentry: { baseUrl: string; org: string; project: string; alertRules: string[] };
  approvals: { maxAgeMin: number; verbs: Record<string, string[]> };
}

export const DEFAULT_CONFIG: Config = {
  github: {
    repo: '',
    apiUrl: 'https://api.github.com',
    webUrl: 'https://github.com',
    protectedBranches: ['main', 'master', 'release/*', 'production', 'gh-pages'],
    branchPattern: null,
    mergeMethod: 'squash',
    allowForcePush: false,
    autoMerge: { enabled: false, requiredChecks: [], approvers: [], minApprovals: 1 },
  },
  slack: { apiUrl: 'https://slack.com/api', channel: '', operators: [], threadOpeners: [], bindOnFirstUse: true },
  linear: { apiUrl: 'https://api.linear.app/graphql', teamId: '', projectId: null },
  sentry: { baseUrl: 'https://sentry.io', org: '', project: '', alertRules: [] },
  approvals: { maxAgeMin: 240, verbs: {} },
};

export interface GkState {
  bindings: Record<string, Binding>;
  consumed: Record<string, { action: string; target: string; session: string; at: string }>;
}

function ensureDir(): void {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); } catch { /* not ours to fix */ }
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(f(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, v: unknown): void {
  ensureDir();
  const tmp = `${f(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f(name));
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, any> = { ...(base as any) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out && isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v;
  return out as T;
}

export const readConfig = (): Config => deepMerge(DEFAULT_CONFIG, readJson('config.json', {}));
export const readIdentities = (): Identities => readJson<Identities>('identities.json', {});
export const readState = (): GkState => {
  const s = readJson<Partial<GkState>>('state.json', {});
  return { bindings: isObj(s.bindings) ? (s.bindings as any) : {}, consumed: isObj(s.consumed) ? (s.consumed as any) : {} };
};

export function writeConfig(c: Config): Config {
  writeJson('config.json', c);
  return readConfig();
}
export function writeIdentities(i: Identities): void {
  writeJson('identities.json', i);
}
export function updateState(fn: (s: GkState) => void): GkState {
  const s = readState();
  fn(s);
  writeJson('state.json', s);
  return s;
}

/** Which credentials are set — never their values. */
export function identityStatus(i: Identities = readIdentities()) {
  return {
    github: { appId: !!i.github?.appId, installationId: !!i.github?.installationId, privateKey: !!i.github?.privateKey },
    slack: { botToken: !!i.slack?.botToken },
    linear: { apiKey: !!i.linear?.apiKey },
    sentry: { token: !!i.sentry?.token, alertsToken: !!i.sentry?.alertsToken },
  };
}

// ---- the audit log -------------------------------------------------------------------------------------------------

export interface AuditEntry {
  session: string | null;
  profile?: string | null;
  tool: string;
  action?: string;
  target?: string;
  decision: 'allowed' | 'refused' | 'failed' | 'config';
  reason?: string;
  approval?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const SECRETISH = /(xox[abposr]-[A-Za-z0-9-]{8,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9]{20,}|sntrys_[A-Za-z0-9_=-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;
/** Belt and braces: whatever an upstream error echoes, a token shape never reaches the log or a tool result. */
export const redact = (s: string): string => String(s).replace(SECRETISH, '[redacted]');

export function audit(e: AuditEntry): void {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e, reason: e.reason ? redact(e.reason).slice(0, 500) : undefined });
    fs.appendFileSync(f('audit.log'), line + '\n', { mode: 0o600 });
  } catch {
    /* an audit failure must not turn into an allowed call — callers decide before they log */
  }
}

export function auditTail(n = 200): Record<string, unknown>[] {
  try {
    const lines = fs.readFileSync(f('audit.log'), 'utf8').trim().split('\n').slice(-Math.max(1, Math.min(2000, n)));
    return lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }).reverse();
  } catch {
    return [];
  }
}

export const mirrorDir = (session: string) => path.join(DIR, 'git', `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.git`);
export const AUDIT_FILE = () => f('audit.log');
