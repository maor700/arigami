// S1 — Just-in-time setup: the CAPABILITY REGISTRY (SPEC-ARIGAMI-JIT-SETUP).
//
// One list is the source of truth for "what can this host do right now" — the
// wizard, `bin/host doctor`, Settings → Connections and the in-chat Setup card
// all read it. Every entry's `check()` reuses the gates already in
// server/onboarding.ts (never a second probe for the same fact).
//
// Also here: the `needs_setup` shape tools return instead of throwing, the
// identity file ($ARIGAMI_DIR/identity.json — never secrets) and the audit
// trail ($ARIGAMI_DIR/connections.log, JSONL). The pending-request state
// machine (request_setup / report_setup) lives in server/api.ts next to
// request_screen, which it mirrors.
import fs from 'node:fs';
import path from 'node:path';
import { which, HOME } from './lib/platform.js';
import { resourceRoot } from './lib/resource-root.js';
import { mcpCatalog, connectableMcp, mcpSpec, grantName, grantToolPattern } from './mcp-catalog.js';
import * as mcpConn from './mcp-connections.js';
import * as hostGrants from './lib/mcp-grants.js';
import { cfg } from './lib/config.js';
import { ARIGAMI_DIR } from './lib/instance.js';
import * as ob from './onboarding.js';

// ---------------------------------------------------------------------------
// Shared contract (ids, shapes) — S2 (web) and S3 (skills) depend on these.
// ---------------------------------------------------------------------------

export type ManualKind = 'token' | 'oauth' | 'qr' | 'toggle' | 'repo' | 'takeover';
export type Playbook = 'connect-identity' | 'connect-composio' | 'connect-claude' | 'connect-codex' | 'connect-tailscale' | 'connect-github' | 'connect-mcp';

/**
 * M1 — WHERE a connection's tokens live and who the calls go through:
 *   native-mcp  the vendor's own remote MCP server, OAuth straight from Claude
 *               Code (token in the host's `.credentials.json`, no broker).
 *   composio    brokered by Composio (token in Composio's cloud, calls proxied).
 *   local       this host (a Google login in its Chrome, the WhatsApp bridge,
 *               gh credentials, the desktop…) — nothing leaves the machine.
 * The Connections hub orders the sections by this: native first, Composio after.
 */
export type Provider = 'native-mcp' | 'composio' | 'local';

export interface CheckResult {
  ok: boolean;
  detail: string;
  // Live facts the card can render (never secrets): qr data-url, user, urls…
  data?: Record<string, unknown>;
  // A2: where an OK answer came from — 'agent:<slug>' (the agent's own
  // connection) or 'global' (the shared one an agent session fell back to).
  owner?: Owner;
}

export interface ManualSpec {
  kind: ManualKind;
  // What the human pastes / clicks. Rendered by S2's per-kind sub-component.
  fields?: Array<{ name: string; label: string; secret?: boolean; placeholder?: string }>;
  // Endpoint that starts an external flow (oauth / qr) — host-relative.
  start?: string;
  // Free-form instructions shown on the card.
  help?: string;
  // oauth: which sign-in the UI runs (web/src/components/setup/OAuthCodeStep.jsx) —
  // 'mcp' polls until the grant is live, the paste-back is only the fallback.
  flow?: 'pkce' | 'mcp' | 'codex' | 'device' | 'redirect';
}

export interface Capability {
  id: string;
  title: string;
  // Group for Settings → Connections / doctor output.
  group: 'core' | 'code' | 'messaging' | 'integrations' | 'machine' | 'host';
  // M1: which provider backs it (native-mcp / composio / local).
  provider: Provider;
  check: () => CheckResult | Promise<CheckResult>;
  manual: ManualSpec;
  // May the agent connect it itself (machine-work playbook) once a Google
  // identity is signed in on the session's Chrome?
  autoCapable: boolean;
  playbook?: Playbook;
  // Bus / funnel event types after which the status may have changed — the
  // web re-fetches GET /__api/setup/capabilities on any of them.
  events: string[];
}

export interface CapabilityStatus {
  id: string;
  title: string;
  group: Capability['group'];
  provider: Provider;
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
  manual: ManualSpec;
  autoCapable: boolean;
  playbook?: Playbook;
  events: string[];
  // Effective default mode for a request_setup on this capability right now.
  defaultMode: 'auto' | 'manual';
  // A2: can this capability be owned by an agent at all (identity, composio:*)?
  ownable: boolean;
  // A2: the owner the status was resolved FOR, and where it resolved FROM.
  // For an agent owner: 'agent:<slug>' when the agent's own connection is up,
  // 'global' when it fell back to the shared one (or the capability is host-level).
  owner: Owner;
  resolvedFrom: Owner | null; // null = not connected anywhere
}

/** The tool result every wrapped MCP/REST tool returns instead of throwing. */
export interface NeedsSetup {
  needs_setup: string;
  why: string;
  hint: string;
}
export const needsSetup = (capability: string, why: string, hint = 'call request_setup'): NeedsSetup => ({
  needs_setup: capability,
  why,
  hint,
});
export const isNeedsSetup = (x: unknown): x is NeedsSetup =>
  !!x && typeof x === 'object' && typeof (x as any).needs_setup === 'string';

// Static ids. `repo:<name>`, `composio:<toolkit>` and `mcp:<service>` are
// dynamic (see getCapability()).
export const STATIC_CAPABILITY_IDS = ['identity', 'claude', 'codex', 'git', 'whatsapp', 'desktop', 'push', 'remote', 'telemetry'] as const;
// M1: what Composio still brokers for us. Linear/Notion/GitHub moved to their
// vendors' own MCP servers (mcp:*), and `whatsapp` was never our WhatsApp —
// Composio's toolkit is the Business Cloud API, ours is the local bridge.
export const KNOWN_COMPOSIO_TOOLKITS = ['gmail', 'googledrive', 'googlecalendar', 'googledocs', 'slack', 'facebook'] as const;
// M1: native remote-MCP services listed even before anyone asked for them.
export const knownMcpServices = (): string[] => connectableMcp().map((s) => s.slug);
/** @deprecated snapshot taken at import; call knownMcpServices() for the live list. */
export const KNOWN_MCP_SERVICES: readonly string[] = connectableMcp().map((s) => s.slug);
const CAP_ID_RE = /^(identity|claude|codex|git|whatsapp|desktop|push|remote|telemetry|repo:[A-Za-z0-9._-]{1,64}|composio:[a-z0-9_-]{1,40}|mcp:[a-z0-9-]{1,40})$/;
export const isCapabilityId = (id: unknown): id is string => typeof id === 'string' && CAP_ID_RE.test(id);

// ---------------------------------------------------------------------------
// A2 — owners. A connection belongs to the host ('global') or to one agent
// ('agent:<slug>', PRD-ARIGAMI-AGENTS §3 A2). Only capabilities that carry
// real per-identity state are ownable: `identity` (the Google login in the
// agent's own Chrome profile → $ARIGAMI_DIR/agents/<slug>/identity.json) and
// `composio:*` (a Composio connected account with user_id = the owner).
// Everything else (claude, codex, git, whatsapp, desktop, push, remote, telemetry,
// repo:*) is host-level and resolves to 'global' for every owner. A session
// born from an agent resolves the agent's connection FIRST, then the global.
// ---------------------------------------------------------------------------

export type Owner = string; // 'global' | 'agent:<slug>'
export const GLOBAL_OWNER: Owner = 'global';
const AGENT_OWNER_RE = /^agent:([a-z0-9][a-z0-9-]{0,39})$/;
/** Normalise an owner value: ''/undefined/'global' → 'global'; 'agent:<slug>' kept; anything else → null (invalid). */
export function parseOwner(v: unknown): Owner | null {
  if (v === undefined || v === null || v === '' || v === GLOBAL_OWNER) return GLOBAL_OWNER;
  const str = String(v).trim();
  return AGENT_OWNER_RE.test(str) ? str : null;
}
export const ownerSlug = (owner: Owner | null | undefined): string | null => (owner && AGENT_OWNER_RE.exec(owner)?.[1]) || null;
/** The owner a session acts for: 'agent:<slug>' when born from an agent (metadata.agent), else 'global'. */
export const ownerForAgent = (agentSlug: unknown): Owner => (typeof agentSlug === 'string' && agentSlug ? `agent:${agentSlug}` : GLOBAL_OWNER);
export const isOwnable = (id: string): boolean => id === 'identity' || id.startsWith('composio:') || id.startsWith('mcp:');

/** M1 — the provider behind a capability id. */
export function providerOf(id: string): Provider {
  if (id.startsWith('mcp:')) return 'native-mcp';
  if (id.startsWith('composio:')) return 'composio';
  return 'local';
}

// ---------------------------------------------------------------------------
// Identity ($ARIGAMI_DIR/identity.json) — no secrets, ever.
// ---------------------------------------------------------------------------

export const IDENTITY_FILE = path.join(ARIGAMI_DIR, 'identity.json');
export const AUDIT_FILE = path.join(ARIGAMI_DIR, 'connections.log');
// F6: open setup cards survive a host restart (server/api.ts persists them here).
export const SETUP_PENDING_FILE = path.join(ARIGAMI_DIR, 'setup-pending.json');

export interface Identity {
  email: string;
  provider: 'google';
  connectedAt: string;
  chromeProfile: string; // 'base' — the shared chrome-base profile (T8)
  providers: Record<string, { at: string }>;
}

const SECRET_RE = /(sk-ant-|ghp_|github_pat_|xox[abp]-|eyJ[A-Za-z0-9_-]{20,}|password|secret|token)/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** identity.json of an owner: the global one, or $ARIGAMI_DIR/agents/<slug>/identity.json (A2). */
export function identityFile(owner: Owner = GLOBAL_OWNER): string {
  const slug = ownerSlug(owner);
  return slug ? path.join(ARIGAMI_DIR, 'agents', slug, 'identity.json') : IDENTITY_FILE;
}

export function readIdentity(owner: Owner = GLOBAL_OWNER): Identity | null {
  try {
    const j = JSON.parse(fs.readFileSync(identityFile(owner), 'utf8'));
    if (j && typeof j === 'object' && typeof j.email === 'string') return { providers: {}, ...j } as Identity;
  } catch {
    /* absent / malformed */
  }
  return null;
}

/** Write (or merge into) identity.json. Refuses anything that smells like a secret. */
export function writeIdentity(patch: { email?: string; chromeProfile?: string; provider?: 'google' }, owner: Owner = GLOBAL_OWNER): Identity {
  const cur = readIdentity(owner);
  const email = String(patch.email ?? cur?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('identity: a valid email is required');
  for (const v of Object.values(patch)) {
    if (typeof v === 'string' && SECRET_RE.test(v) && !EMAIL_RE.test(v)) throw new Error('identity: refusing to store what looks like a secret');
  }
  const id: Identity = {
    email,
    provider: 'google',
    connectedAt: cur?.email === email ? cur.connectedAt : new Date().toISOString(),
    // A2: an agent's identity lives in the agent's own Chrome profile.
    chromeProfile: patch.chromeProfile || cur?.chromeProfile || (ownerSlug(owner) ? owner : 'base'),
    providers: cur?.providers || {},
  };
  const file = identityFile(owner);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(id, null, 2) + '\n', { mode: 0o600 });
  return id;
}

/** Record that `capability` was connected through the identity (auto playbook). */
export function markIdentityProvider(capability: string, owner: Owner = GLOBAL_OWNER): Identity | null {
  const cur = readIdentity(owner);
  if (!cur) return null;
  cur.providers[capability] = { at: new Date().toISOString() };
  fs.writeFileSync(identityFile(owner), JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  return cur;
}

export function clearIdentity(owner: Owner = GLOBAL_OWNER): boolean {
  try {
    fs.unlinkSync(identityFile(owner));
    return true;
  } catch {
    return false;
  }
}

export const identityConnected = (owner: Owner = GLOBAL_OWNER): boolean => !!readIdentity(owner);

// ---------------------------------------------------------------------------
// Audit ($ARIGAMI_DIR/connections.log — JSONL, append-only)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  at: string;
  sessionId: string | null;
  capability: string;
  mode: 'auto' | 'manual' | 'ask' | 'none';
  // 'already' = the agent asked and it was connected already (no card shown).
  result: 'requested' | 'already' | 'done' | 'failed' | 'skipped' | 'timeout' | 'disconnected';
  evidence: string | null; // '/__artifacts/<id>/' or null
  human: boolean; // did a human act (paste / click / take over)?
  detail?: string;
  owner?: Owner; // A2: 'agent:<slug>' when the connection belongs to an agent; absent = global
}

export function appendAudit(e: Omit<AuditEntry, 'at'> & { at?: string }): AuditEntry {
  const entry: AuditEntry = { at: e.at || new Date().toISOString(), ...e } as AuditEntry;
  if (!entry.owner || entry.owner === GLOBAL_OWNER) delete entry.owner;
  if (entry.detail && SECRET_RE.test(entry.detail) && !/needs|missing|not /i.test(entry.detail)) delete entry.detail;
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch {
    /* never fail the caller */
  }
  return entry;
}

/** Newest last. `owner` filters to one owner's lines ('global' = lines without an owner). */
export function readAudit(limit = 50, owner?: Owner): AuditEntry[] {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    const all = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry];
      } catch {
        return [];
      }
    });
    const mine = owner ? all.filter((e) => (e.owner || GLOBAL_OWNER) === owner) : all;
    return mine.slice(-limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Probes — injectable so the registry is unit-testable without gh / claude /
// Composio / a desktop. Defaults reuse onboarding.ts's gates verbatim.
// ---------------------------------------------------------------------------

export interface CapabilityProbes {
  // A2: called with the owner being resolved ('global' or 'agent:<slug>').
  identity: (owner?: Owner) => Identity | null;
  claude: () => { cli: boolean; authed: boolean };
  codex: () => { cli: boolean; authed: boolean };
  git: () => { authed: boolean; gh: boolean };
  repos: () => Array<{ name: string; present: boolean; dir: string; source: string }>;
  whatsapp: () => { status: string; qr: string | null; user: string | null; reason?: string };
  desktop: () => { enabled: boolean; display: string | null; up: boolean };
  push: () => boolean;
  remote: () => { available: boolean; loggedIn?: boolean; serving?: boolean; httpsUrl?: string | null; reason?: string };
  telemetry: () => { enabled: boolean; reason: string };
  composioKey: () => boolean;
  // Connected toolkits (ACTIVE connected accounts). null = unknown (no key / offline).
  // Entries: '<toolkit>' for the host's accounts (user_id 'default'), and
  // 'agent:<slug>:<toolkit>' for an agent-owned account (A2, user_id = owner).
  composioConnected: () => Promise<Set<string> | null>;
  // M1: Claude Code's own MCP state — which grant names hold a live token and
  // which server names are configured. Read from files, so this is offline.
  mcp: () => mcpConn.McpState;
  // M1: the connection records this host wrote for an owner (never secrets).
  mcpConnections: (owner: Owner) => mcpConn.McpConnection[];
  // P2-4: Codex's own MCP grants (name → live).
  codexMcp: () => Map<string, boolean>;
  // P2-4: the engine asking (a session's), or null for Settings/doctor — mcp:* then counts any engine's grant.
  engine: () => mcpConn.McpEngine | null;
}

// Connected-accounts probe: one network call, cached — a tool that checks
// `composio:gmail` before every message must not hit the API every time.
const COMPOSIO_CACHE_MS = 60_000;
let composioCache: { at: number; slugs: Set<string> | null; keyed: boolean } | null = null;
export function invalidateComposioCache(): void {
  composioCache = null;
}
async function fetchComposioConnected(): Promise<Set<string> | null> {
  const key = cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';
  if (!key) return null;
  const now = Date.now();
  if (composioCache && composioCache.keyed && now - composioCache.at < COMPOSIO_CACHE_MS) return composioCache.slugs;
  try {
    const r = await fetch('https://backend.composio.dev/api/v3.1/connected_accounts?limit=200', {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`composio ${r.status}`);
    const j = (await r.json()) as any;
    const slugs = new Set<string>();
    for (const c of j.items || []) {
      if (c.status !== 'ACTIVE') continue;
      const slug = String(c.toolkit?.slug || '').toLowerCase();
      if (!slug) continue;
      const uid = String(c.user_id ?? c.entity_id ?? '');
      slugs.add(AGENT_OWNER_RE.test(uid) ? `${uid}:${slug}` : slug);
    }
    composioCache = { at: now, slugs, keyed: true };
    return slugs;
  } catch {
    // Keep a stale answer rather than flapping to "unknown" on a blip.
    return composioCache?.slugs ?? null;
  }
}

/**
 * F6: a retried OAuth flow leaves stale connected accounts behind (INITIALIZING /
 * INITIATED / FAILED / EXPIRED) next to the one that reached ACTIVE. Once an
 * ACTIVE account exists for `slug`, delete the others for that toolkit.
 * Never touches ACTIVE accounts and never other toolkits. Returns what it did.
 */
export async function pruneComposioOrphans(slug: string, opts: { fetchImpl?: typeof fetch; owner?: Owner } = {}): Promise<{ active: number; removed: string[]; skipped: boolean }> {
  const key = cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';
  const f = opts.fetchImpl || fetch;
  slug = slug.toLowerCase();
  if (!key) return { active: 0, removed: [], skipped: true };
  const hdr = { 'x-api-key': key, 'Content-Type': 'application/json' };
  const r = await f('https://backend.composio.dev/api/v3.1/connected_accounts?limit=200', { headers: hdr, signal: AbortSignal.timeout(8000) });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(j?.error?.message || `Composio ${r.status}`);
  const owner = opts.owner || GLOBAL_OWNER;
  const mine = (j.items || []).filter((c: any) => String(c.toolkit?.slug || '').toLowerCase() === slug && composioOwnerOf(c) === owner);
  const active = mine.filter((c: any) => c.status === 'ACTIVE').length;
  if (!active) return { active: 0, removed: [], skipped: true };
  const removed: string[] = [];
  for (const c of mine) {
    if (c.status === 'ACTIVE' || !c.id) continue;
    try {
      const d = await f(`https://backend.composio.dev/api/v3.1/connected_accounts/${c.id}`, { method: 'DELETE', headers: hdr, signal: AbortSignal.timeout(8000) });
      if (d.ok) removed.push(String(c.id));
    } catch {
      /* best effort — the next successful connection prunes again */
    }
  }
  if (removed.length) invalidateComposioCache();
  return { active, removed, skipped: false };
}

/** The owner a Composio connected account belongs to (its user_id / entity_id). */
export const composioOwnerOf = (c: any): Owner => {
  const uid = String(c?.user_id ?? c?.entity_id ?? '');
  return AGENT_OWNER_RE.test(uid) ? uid : GLOBAL_OWNER;
};

const desktopProbe = (): { enabled: boolean; display: string | null; up: boolean } => {
  const enabled = !!cfg.screen?.enabled;
  const display = enabled ? cfg.screen?.display || ':99' : null;
  return { enabled, display, up: display ? ob.desktopUp(display) : false };
};

export const defaultProbes: CapabilityProbes = {
  identity: readIdentity,
  claude: () => ({ cli: ob.defaultProbes.claudeCli(), authed: ob.defaultProbes.claudeAuth() }),
  codex: () => ({ cli: ob.defaultProbes.codexCli(), authed: ob.defaultProbes.codexAuth() }),
  git: () => ({ authed: ob.defaultProbes.gitAuth(), gh: !!which('gh') }),
  repos: () =>
    ob.listRepos().map((r) => {
      const rr = ob.resolveRepo(r);
      return { name: rr.name, present: ob.repoPresent(rr), dir: ob.repoDir(rr), source: rr.source };
    }),
  whatsapp: () => {
    // Same file the wizard's integrations probe reads; the bridge module owns the path.
    try {
      const file = path.join(process.env.ARIGAMI_WA_DATA_DIR || path.join(process.env.ARIGAMI_WA_MCP_DIR || path.join(HOME, '.local', 'lib', 'whatsapp-mcp'), 'data'), 'bridge-status.json');
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j?.pid && j.status !== 'disconnected') {
        try {
          process.kill(j.pid, 0);
        } catch {
          return { status: 'disconnected', qr: null, user: null };
        }
      }
      return { status: typeof j?.status === 'string' ? j.status : 'disconnected', qr: j?.qrUrl ?? null, user: j?.user ?? null, ...(typeof j?.reason === 'string' ? { reason: j.reason } : {}) };
    } catch {
      return { status: 'disconnected', qr: null, user: null };
    }
  },
  desktop: desktopProbe,
  push: () => {
    // push.ts keeps subscriptions in $ARIGAMI_DIR/push-subscriptions.json; read
    // the file so doctor (no host) answers the same as the host.
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ARIGAMI_DIR, 'push-subscriptions.json'), 'utf8'));
      return Array.isArray(j) ? j.length > 0 : Array.isArray(j?.subscriptions) ? j.subscriptions.length > 0 : false;
    } catch {
      return false;
    }
  },
  remote: () => {
    if (!which('tailscale')) return { available: false, reason: 'Tailscale is not installed' };
    try {
      // Lazy require keeps the CLI path (doctor) from importing remote.js's config side effects twice.
      const remote = require('./remote.js');
      return remote.remoteStatus();
    } catch {
      return { available: true, loggedIn: false, reason: 'could not query tailscale' };
    }
  },
  telemetry: () => ob.defaultProbes.telemetry(),
  composioKey: () => !!(cfg.composioApiKey || process.env.COMPOSIO_API_KEY),
  composioConnected: fetchComposioConnected,
  mcp: () => mcpConn.readMcpState(),
  mcpConnections: (owner) => mcpConn.readConnections(owner),
  codexMcp: () => mcpConn.readCodexMcpGrants(),
  engine: () => null,
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const SETUP_EVENTS = ['setup', 'onboarding.step'];

function staticCapabilities(p: CapabilityProbes, owner: Owner = GLOBAL_OWNER): Capability[] {
  return [
    {
      id: 'identity',
      title: 'Google identity (Chrome)',
      group: 'core',
      provider: 'local',
      check: () => {
        // A2: the agent's own identity first (its Chrome profile), then the shared one.
        const own = p.identity(owner);
        const id = own || (owner !== GLOBAL_OWNER ? p.identity(GLOBAL_OWNER) : null);
        const from: Owner = own ? owner : GLOBAL_OWNER;
        return id
          ? { ok: true, owner: from, detail: `signed in as ${id.email}${from !== owner ? ' (shared)' : ''}`, data: { email: id.email, connectedAt: id.connectedAt, providers: Object.keys(id.providers), owner: from } }
          : { ok: false, detail: 'sign in to Google once on the session desktop — the agent can then connect other services itself' };
      },
      manual: { kind: 'takeover', help: 'The agent opens accounts.google.com on its desktop and hands the screen to you; you sign in, click Done.' },
      autoCapable: false,
      playbook: 'connect-identity',
      events: [...SETUP_EVENTS],
    },
    {
      id: 'claude',
      title: 'Claude',
      group: 'core',
      provider: 'local',
      check: () => {
        const c = p.claude();
        if (!c.cli) return { ok: false, detail: 'Claude Code CLI not found on PATH — install it first (npm i -g @anthropic-ai/claude-code)', data: { cli: false } };
        return c.authed ? { ok: true, detail: 'signed in', data: { cli: true } } : { ok: false, detail: 'sign in with Claude (PKCE) or paste a token', data: { cli: true } };
      },
      manual: {
        kind: 'oauth',
        start: '/__api/accounts/oauth/start',
        fields: [{ name: 'token', label: 'Claude token (sk-ant-…)', secret: true }],
        help: 'Sign in with Claude (opens claude.ai, paste the code back) or paste a setup-token / API key.',
      },
      autoCapable: true,
      playbook: 'connect-claude',
      events: [...SETUP_EVENTS, 'accounts'],
    },
    {
      id: 'codex',
      title: 'Codex',
      group: 'core',
      provider: 'local',
      check: () => {
        const c = p.codex();
        if (!c.cli) return { ok: false, detail: 'Codex CLI not found on PATH — install it first (npm i -g @openai/codex)', data: { cli: false } };
        return c.authed ? { ok: true, detail: 'signed in', data: { cli: true } } : { ok: false, detail: 'sign in with ChatGPT or paste an OpenAI API key', data: { cli: true } };
      },
      manual: {
        kind: 'oauth',
        start: '/__api/accounts/login/start',
        fields: [{ name: 'token', label: 'OpenAI API key (sk-…)', secret: true }],
        help: 'Sign in with ChatGPT (codex login; paste the callback address back if the browser is not on this host) or paste an OpenAI API key.',
      },
      autoCapable: true,
      playbook: 'connect-codex',
      events: [...SETUP_EVENTS, 'accounts'],
    },
    {
      id: 'git',
      title: 'Git / GitHub',
      group: 'code',
      provider: 'local',
      check: () => {
        const g = p.git();
        return g.authed
          ? { ok: true, detail: 'git credentials present', data: { gh: g.gh } }
          : { ok: false, detail: g.gh ? 'sign in with gh (device code) or paste a token' : 'paste a GitHub token (needed for private repos)', data: { gh: g.gh } };
      },
      manual: {
        kind: 'token',
        start: '/__api/onboarding/wizard/git',
        fields: [{ name: 'token', label: 'GitHub token', secret: true, placeholder: 'ghp_… / github_pat_…' }],
        help: 'A fine-grained PAT with repo scope, or `gh auth login` on the host.',
      },
      autoCapable: true,
      playbook: 'connect-github',
      events: [...SETUP_EVENTS, 'ghLogin'],
    },
    {
      id: 'whatsapp',
      title: 'WhatsApp',
      group: 'messaging',
      provider: 'local',
      check: () => {
        const w = p.whatsapp();
        return w.status === 'connected'
          ? { ok: true, detail: `connected${w.user ? ` · ${w.user}` : ''}`, data: { status: w.status, user: w.user } }
          : {
              ok: false,
              detail: w.status === 'qr' ? 'scan the QR code with WhatsApp'
                : w.reason === 'logged-out' ? 'WhatsApp unlinked this device — Show QR to pair again'
                : w.reason === 'creds-corrupt' ? 'the saved WhatsApp pairing is damaged (creds.json empty) — Show QR to pair again'
                : w.reason === 'crash-loop' ? 'the WhatsApp process keeps exiting — see the host log, then Show QR'
                : 'not connected — scan a QR code to pair',
              data: { status: w.status, qr: w.qr, ...(w.reason ? { reason: w.reason } : {}) },
            };
      },
      manual: { kind: 'qr', start: '/__api/whatsapp/connect', help: 'WhatsApp → Linked devices → Link a device → scan.' },
      autoCapable: false,
      events: [...SETUP_EVENTS, 'whatsapp'],
    },
    {
      id: 'desktop',
      title: 'Desktop (browser / screen)',
      group: 'machine',
      provider: 'local',
      check: () => {
        const d = p.desktop();
        if (!d.enabled) return { ok: false, detail: 'screen share is disabled (server profile) — enable it to let the agent drive a browser', data: { enabled: false } };
        return d.up
          ? { ok: true, detail: `display ${d.display} up`, data: { enabled: true, display: d.display } }
          : { ok: false, detail: `display ${d.display} not reachable — install Xvfb/x11vnc or enable the desktop`, data: { enabled: true, display: d.display } };
      },
      manual: { kind: 'toggle', help: 'Turns on the shared desktop (Xvfb + VNC) the agent uses for browser work.' },
      autoCapable: false,
      events: [...SETUP_EVENTS, 'screen'],
    },
    {
      id: 'push',
      title: 'Push notifications',
      group: 'host',
      provider: 'local',
      check: () =>
        p.push()
          ? { ok: true, detail: 'a device is subscribed' }
          : { ok: false, detail: 'no device subscribed — allow notifications in the cockpit on your phone' },
      manual: { kind: 'toggle', help: 'Enable notifications from the cockpit (browser permission) on the device you want buzzed.' },
      autoCapable: false,
      events: [...SETUP_EVENTS, 'push'],
    },
    {
      id: 'remote',
      title: 'Remote access (Tailscale)',
      group: 'host',
      provider: 'local',
      check: () => {
        const r = p.remote();
        if (!r.available) return { ok: false, detail: r.reason || 'Tailscale is not installed', data: { available: false } };
        if (!r.loggedIn) return { ok: false, detail: r.reason || 'Tailscale is not connected', data: { available: true, loggedIn: false } };
        return { ok: true, detail: r.serving ? `serving ${r.httpsUrl || ''}`.trim() : 'tailnet up (HTTPS serve off)', data: { available: true, loggedIn: true, serving: !!r.serving, httpsUrl: r.httpsUrl ?? null } };
      },
      manual: { kind: 'toggle', start: '/__api/remote', help: '`tailscale up` on the host, then turn on HTTPS serve.' },
      autoCapable: true,
      playbook: 'connect-tailscale',
      events: [...SETUP_EVENTS, 'remote'],
    },
    {
      id: 'telemetry',
      title: 'Anonymous telemetry',
      group: 'host',
      provider: 'local',
      check: () => {
        const t = p.telemetry();
        return t.enabled
          ? { ok: true, detail: `on (${t.reason})`, data: { enabled: true, reason: t.reason } }
          : { ok: false, detail: t.reason === 'dnt' ? 'off — DO_NOT_TRACK=1' : 'off (opt-in)', data: { enabled: false, reason: t.reason } };
      },
      manual: { kind: 'toggle', start: '/__api/telemetry', help: 'Sends funnel milestone names + timestamps only. Off by default.' },
      autoCapable: false,
      events: [...SETUP_EVENTS, 'telemetry'],
    },
  ];
}

function repoCapability(name: string, p: CapabilityProbes): Capability {
  return {
    id: `repo:${name}`,
    title: `Repository ${name}`,
    group: 'code',
    provider: 'local',
    check: () => {
      const r = p.repos().find((x) => x.name === name);
      if (!r) return { ok: false, detail: `${name} is not registered — provide its git URL`, data: { registered: false } };
      return r.present
        ? { ok: true, detail: r.dir, data: { registered: true, dir: r.dir } }
        : { ok: false, detail: `not cloned yet (${r.source})`, data: { registered: true, dir: r.dir, source: r.source } };
    },
    manual: {
      kind: 'repo',
      start: '/__api/onboarding/repos',
      fields: [{ name: 'url', label: 'Git URL or local path', placeholder: 'https://github.com/org/repo.git' }],
      help: 'The host clones it (or copies a local folder) and installs dependencies.',
    },
    autoCapable: false,
    events: [...SETUP_EVENTS, 'onboarding.job'],
  };
}

function composioCapability(toolkit: string, p: CapabilityProbes, owner: Owner = GLOBAL_OWNER): Capability {
  const slug = toolkit.toLowerCase();
  return {
    id: `composio:${slug}`,
    title: `${slug[0].toUpperCase()}${slug.slice(1)} (via Composio)`,
    group: 'integrations',
    provider: 'composio',
    check: async () => {
      if (!p.composioKey()) return { ok: false, detail: 'Composio is not connected — sign in to Composio first', data: { hasKey: false } };
      const set = await p.composioConnected();
      if (set === null) return { ok: false, detail: 'could not reach Composio to verify the connection', data: { hasKey: true, unknown: true } };
      // A2: the agent's own connected account (user_id = owner) first, then the host's.
      if (owner !== GLOBAL_OWNER && set.has(`${owner}:${slug}`)) return { ok: true, owner, detail: 'connected', data: { hasKey: true, owner } };
      return set.has(slug)
        ? { ok: true, owner: GLOBAL_OWNER, detail: owner !== GLOBAL_OWNER ? 'connected (shared)' : 'connected', data: { hasKey: true, owner: GLOBAL_OWNER } }
        : { ok: false, detail: `${slug} is not connected in Composio — authorize it`, data: { hasKey: true } };
    },
    manual: {
      kind: 'oauth',
      start: '/__api/composio/connect',
      fields: [{ name: 'key', label: 'Composio API key (only if Composio itself is not signed in)', secret: true }],
      help: 'Opens the provider\'s consent screen through Composio; approve, come back.',
    },
    autoCapable: true,
    playbook: 'connect-composio',
    events: [...SETUP_EVENTS, 'composio'],
  };
}

/**
 * M1 — a native remote-MCP service (`mcp:<slug>`). One shape for every vendor in
 * mcp-catalog.ts; the only per-service data is that catalog row.
 *
 * Connected means: this owner (or, for an agent, the host) has a connection
 * record AND the grant behind it is still usable — a stored OAuth token for
 * `auth:'oauth'`, a configured header server for `auth:'bearer'`. Both facts are
 * read from files, so the check is offline and safe to call on every refresh.
 */
function mcpCapability(slug: string, p: CapabilityProbes, owner: Owner = GLOBAL_OWNER): Capability {
  const s = slug.toLowerCase();
  const spec = mcpSpec(s);
  const title = spec ? spec.title : `${s[0].toUpperCase()}${s.slice(1)}`;
  const name = grantName(s, owner);
  return {
    id: `mcp:${s}`,
    title,
    group: 'integrations',
    provider: 'native-mcp',
    check: () => {
      if (!spec) return { ok: false, detail: `${s} is not in the native MCP catalog` };
      if (spec.auth === 'oauth-byo-client')
        return { ok: false, detail: `${title} has no dynamic client registration — it needs an OAuth app of your own (client id + secret)`, data: { auth: spec.auth, url: spec.url, docs: spec.docs } };
      const state = p.mcp();
      const codex = p.codexMcp();
      const engine = p.engine();
      const own = p.mcpConnections(owner).find((c) => c.cap === `mcp:${s}`);
      const shared = owner === GLOBAL_OWNER ? null : p.mcpConnections(GLOBAL_OWNER).find((c) => c.cap === `mcp:${s}`);
      let heldElsewhere: string[] = [];
      for (const [conn, from] of [[own, owner] as const, [shared, GLOBAL_OWNER] as const]) {
        if (!conn) continue;
        const engines = mcpConn.grantEngines(conn.name, conn.auth || spec.auth, state, codex);
        if (engine ? !engines.includes(engine) : !engines.length) {
          if (engines.length && !heldElsewhere.length) heldElsewhere = engines;
          continue;
        }
        // Who holds it matters to a person: the host's grant serves every engine;
        // an engine's own (`claude mcp login`) serves only that engine.
        const heldBy = hostGrants.isHostHeld(conn.name) ? 'host' : 'engine';
        return {
          ok: true,
          owner: from,
          detail: `connected as ${conn.name}${from !== owner ? ' (shared)' : ''} · ${heldBy === 'host' ? 'via Arigami, every engine' : `${engines.join(', ')} only`}`,
          data: { name: conn.name, url: conn.url, auth: conn.auth || spec.auth, owner: from, engines, heldBy, tools: grantToolPattern(conn.name), docs: spec.docs, ...(spec.note ? { note: spec.note } : {}) },
        };
      }
      if (engine && heldElsewhere.length)
        return {
          ok: false,
          detail: engine === 'codex' && spec.auth === 'bearer' ? `${title} is token-based — not wired for Codex sessions yet` : `${title} is granted for ${heldElsewhere.join(', ')} only — authorize it once more for ${engine}`,
          data: { name, url: spec.url, auth: spec.auth, docs: spec.docs, engines: heldElsewhere, engine, tools: grantToolPattern(name) },
        };
      const stale = own || shared;
      // The bearer rows never see a consent screen — saying "authorize" there
      // would send the human looking for a browser step that does not exist.
      const how = spec.auth === 'bearer' ? (spec.tokenFrom === 'gh' ? `add a ${title} token (the host can reuse the one \`gh\` already has)` : `add a ${title} token`) : `authorize ${title} once`;
      return {
        ok: false,
        detail: stale ? `${stale.name} needs authentication again` : `not connected — ${how}`,
        data: { name, url: spec.url, auth: spec.auth, docs: spec.docs, tools: grantToolPattern(name), ...(spec.readonlyUrl ? { readonlyUrl: spec.readonlyUrl } : {}), ...(spec.note ? { note: spec.note } : {}), ...(stale ? { stale: true } : {}) },
      };
    },
    manual:
      spec?.auth === 'bearer'
        ? {
            kind: 'token',
            fields: [{ name: 'token', label: `${title} token`, secret: true }],
            help: spec.tokenFrom === 'gh' ? 'Leave empty to reuse the token `gh auth login` already stored on this host.' : `A token with access to ${title}.`,
          }
        : {
            kind: 'oauth',
            // 'mcp': start → the vendor's page → poll until the grant is live (the
            // redirect lands on the host by itself); pasting the final URL is the fallback.
            flow: 'mcp' as const,
            help: `Opens ${title}'s own consent screen. The token is stored on this host — no third party in between.`,
          },
    autoCapable: spec?.auth === 'oauth',
    ...(spec?.auth === 'oauth' ? { playbook: 'connect-mcp' as Playbook } : {}),
    events: [...SETUP_EVENTS, 'mcp-auth'],
  };
}

/** All capabilities currently worth listing: statics + every registered repo + known/seen toolkits. */
export function listCapabilities(probes: Partial<CapabilityProbes> = {}, owner: Owner = GLOBAL_OWNER): Capability[] {
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  const repos = p.repos().map((r) => repoCapability(r.name, p));
  const toolkits = [...new Set([...KNOWN_COMPOSIO_TOOLKITS, ...seenToolkits])].map((t) => composioCapability(t, p, owner));
  // M1: native cards come first — they are the recommended path for anything
  // the vendors host themselves; Composio is the fallback broker below them.
  // EXT: the MERGED catalog — core rows plus the user's own mcp-catalog.json,
  // so a service the user declared gets a capability card like any other.
  const native = mcpCatalog().map((sv) => mcpCapability(sv.slug, p, owner));
  return [...staticCapabilities(p, owner), ...repos, ...native, ...toolkits];
}

// Toolkits somebody asked about (request_setup / check) join the listing.
const seenToolkits = new Set<string>();

/** Resolve one id (dynamic ids are built on demand). null = not a valid id. */
export function getCapability(id: string, probes: Partial<CapabilityProbes> = {}, owner: Owner = GLOBAL_OWNER): Capability | null {
  if (!isCapabilityId(id)) return null;
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  if (id.startsWith('repo:')) return repoCapability(id.slice(5), p);
  if (id.startsWith('composio:')) {
    seenToolkits.add(id.slice(9).toLowerCase());
    return composioCapability(id.slice(9), p, owner);
  }
  if (id.startsWith('mcp:')) return mcpCapability(id.slice(4), p, owner);
  return staticCapabilities(p, owner).find((c) => c.id === id) ?? null;
}

// AUTO_CAPABLE — the ids the agent may connect itself once an identity exists.
export const AUTO_CAPABLE = (id: string): boolean => !!getCapability(id)?.autoCapable;

/**
 * A2: the identity an auto playbook would drive: for an agent owner, the
 * AGENT's own Google identity (its Chrome profile is what the playbook uses) —
 * the shared one does not count; for global, the host's.
 */
export function identityForAuto(owner: Owner = GLOBAL_OWNER, probes: Partial<CapabilityProbes> = {}): Identity | null {
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  return p.identity(owner);
}

/** Effective default `mode` for a request_setup right now. */
export function defaultMode(cap: Capability, probes: Partial<CapabilityProbes> = {}, owner: Owner = GLOBAL_OWNER): 'auto' | 'manual' {
  return cap.autoCapable && !!identityForAuto(owner, probes) ? 'auto' : 'manual';
}

export async function statusOf(cap: Capability, probes: Partial<CapabilityProbes> = {}, owner: Owner = GLOBAL_OWNER): Promise<CapabilityStatus> {
  let r: CheckResult;
  try {
    r = await cap.check();
  } catch (e) {
    r = { ok: false, detail: `check failed: ${(e as Error).message}` };
  }
  const ownable = isOwnable(cap.id);
  return {
    id: cap.id,
    title: cap.title,
    group: cap.group,
    provider: cap.provider,
    ok: r.ok,
    detail: r.detail,
    ...(r.data ? { data: r.data } : {}),
    manual: cap.manual,
    autoCapable: cap.autoCapable,
    ...(cap.playbook ? { playbook: cap.playbook } : {}),
    events: cap.events,
    defaultMode: defaultMode(cap, probes, owner),
    ownable,
    owner,
    resolvedFrom: r.ok ? (ownable ? r.owner || GLOBAL_OWNER : GLOBAL_OWNER) : null,
  };
}

/** GET /__api/setup/capabilities payload (`?owner=agent:<slug>` resolves for that agent — A2). */
export async function capabilitiesStatus(probes: Partial<CapabilityProbes> = {}, owner: Owner = GLOBAL_OWNER): Promise<{ owner: Owner; identity: Identity | null; sharedIdentity: Identity | null; capabilities: CapabilityStatus[] }> {
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  const caps = listCapabilities(probes, owner);
  const capabilities = await Promise.all(caps.map((c) => statusOf(c, probes, owner)));
  return { owner, identity: p.identity(owner), sharedIdentity: owner === GLOBAL_OWNER ? null : p.identity(GLOBAL_OWNER), capabilities };
}

/** `{ok:true}` or the needs_setup shape — the one helper every wrapper uses. */
export async function ensure(id: string, why: string, probes: Partial<CapabilityProbes> = {}, owner: Owner = GLOBAL_OWNER): Promise<{ ok: true; detail: string; owner?: Owner } | NeedsSetup> {
  const cap = getCapability(id, probes, owner);
  if (!cap) return needsSetup(id, why, `unknown capability ${id} — use one of the registry ids`);
  try {
    const r = await cap.check();
    if (r.ok) return { ok: true, detail: r.detail, owner: r.owner || GLOBAL_OWNER };
  } catch {
    /* treat as missing */
  }
  return needsSetup(id, why);
}

// ---------------------------------------------------------------------------
// doctor (CLI) — `bun server/capabilities.ts doctor`, called by bin/host doctor.
// Network probes (Composio) are skipped: offline answers only.
// ---------------------------------------------------------------------------

export async function formatDoctor(probes: Partial<CapabilityProbes> = {}): Promise<string> {
  const view = await capabilitiesStatus({ composioConnected: async () => null, ...probes });
  const lines = view.capabilities
    .filter((c) => !(c.id.startsWith('composio:') && c.data?.unknown))
    .map((c) => `  ${c.ok ? '✓' : '○'} ${c.id.padEnd(22)} ${c.detail}${c.autoCapable ? '  [auto]' : ''}`);
  lines.push(`  identity: ${view.identity ? view.identity.email : 'none (connect Google once for automatic setup)'}`);
  return lines.join('\n');
}

if (import.meta.main && process.argv[2] === 'doctor') {
  process.env.ARIGAMI_FUNNEL_QUIET = '1';
  console.log(await formatDoctor());
}

// Keep the path helper visible for tests/tools.
export const REPO_ROOT = resourceRoot();
