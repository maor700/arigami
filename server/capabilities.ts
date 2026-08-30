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
import { fileURLToPath } from 'node:url';
import { which, HOME } from './lib/platform.js';
import { cfg } from './lib/config.js';
import { ARIGAMI_DIR } from './lib/instance.js';
import * as ob from './onboarding.js';

// ---------------------------------------------------------------------------
// Shared contract (ids, shapes) — S2 (web) and S3 (skills) depend on these.
// ---------------------------------------------------------------------------

export type ManualKind = 'token' | 'oauth' | 'qr' | 'toggle' | 'repo' | 'takeover';
export type Playbook = 'connect-identity' | 'connect-composio' | 'connect-claude' | 'connect-tailscale' | 'connect-github';

export interface CheckResult {
  ok: boolean;
  detail: string;
  // Live facts the card can render (never secrets): qr data-url, user, urls…
  data?: Record<string, unknown>;
}

export interface ManualSpec {
  kind: ManualKind;
  // What the human pastes / clicks. Rendered by S2's per-kind sub-component.
  fields?: Array<{ name: string; label: string; secret?: boolean; placeholder?: string }>;
  // Endpoint that starts an external flow (oauth / qr) — host-relative.
  start?: string;
  // Free-form instructions shown on the card.
  help?: string;
}

export interface Capability {
  id: string;
  title: string;
  // Group for Settings → Connections / doctor output.
  group: 'core' | 'code' | 'messaging' | 'integrations' | 'machine' | 'host';
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
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
  manual: ManualSpec;
  autoCapable: boolean;
  playbook?: Playbook;
  events: string[];
  // Effective default mode for a request_setup on this capability right now.
  defaultMode: 'auto' | 'manual';
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

// Static ids. `repo:<name>` and `composio:<toolkit>` are dynamic (see resolve()).
export const STATIC_CAPABILITY_IDS = ['identity', 'claude', 'git', 'whatsapp', 'desktop', 'push', 'remote', 'telemetry'] as const;
// Toolkits we always list even before anyone asked for them.
export const KNOWN_COMPOSIO_TOOLKITS = ['gmail', 'googledrive', 'googlecalendar', 'slack', 'linear', 'notion', 'github'] as const;
const CAP_ID_RE = /^(identity|claude|git|whatsapp|desktop|push|remote|telemetry|repo:[A-Za-z0-9._-]{1,64}|composio:[a-z0-9_-]{1,40})$/;
export const isCapabilityId = (id: unknown): id is string => typeof id === 'string' && CAP_ID_RE.test(id);

// ---------------------------------------------------------------------------
// Identity ($ARIGAMI_DIR/identity.json) — no secrets, ever.
// ---------------------------------------------------------------------------

export const IDENTITY_FILE = path.join(ARIGAMI_DIR, 'identity.json');
export const AUDIT_FILE = path.join(ARIGAMI_DIR, 'connections.log');

export interface Identity {
  email: string;
  provider: 'google';
  connectedAt: string;
  chromeProfile: string; // 'base' — the shared chrome-base profile (T8)
  providers: Record<string, { at: string }>;
}

const SECRET_RE = /(sk-ant-|ghp_|github_pat_|xox[abp]-|eyJ[A-Za-z0-9_-]{20,}|password|secret|token)/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function readIdentity(): Identity | null {
  try {
    const j = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    if (j && typeof j === 'object' && typeof j.email === 'string') return { providers: {}, ...j } as Identity;
  } catch {
    /* absent / malformed */
  }
  return null;
}

/** Write (or merge into) identity.json. Refuses anything that smells like a secret. */
export function writeIdentity(patch: { email?: string; chromeProfile?: string; provider?: 'google' }): Identity {
  const cur = readIdentity();
  const email = String(patch.email ?? cur?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('identity: a valid email is required');
  for (const v of Object.values(patch)) {
    if (typeof v === 'string' && SECRET_RE.test(v) && !EMAIL_RE.test(v)) throw new Error('identity: refusing to store what looks like a secret');
  }
  const id: Identity = {
    email,
    provider: 'google',
    connectedAt: cur?.email === email ? cur.connectedAt : new Date().toISOString(),
    chromeProfile: patch.chromeProfile || cur?.chromeProfile || 'base',
    providers: cur?.providers || {},
  };
  fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(id, null, 2) + '\n', { mode: 0o600 });
  return id;
}

/** Record that `capability` was connected through the identity (auto playbook). */
export function markIdentityProvider(capability: string): Identity | null {
  const cur = readIdentity();
  if (!cur) return null;
  cur.providers[capability] = { at: new Date().toISOString() };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  return cur;
}

export function clearIdentity(): boolean {
  try {
    fs.unlinkSync(IDENTITY_FILE);
    return true;
  } catch {
    return false;
  }
}

export const identityConnected = (): boolean => !!readIdentity();

// ---------------------------------------------------------------------------
// Audit ($ARIGAMI_DIR/connections.log — JSONL, append-only)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  at: string;
  sessionId: string | null;
  capability: string;
  mode: 'auto' | 'manual' | 'ask' | 'none';
  result: 'requested' | 'done' | 'failed' | 'skipped' | 'timeout' | 'disconnected';
  evidence: string | null; // '/__artifacts/<id>/' or null
  human: boolean; // did a human act (paste / click / take over)?
  detail?: string;
}

export function appendAudit(e: Omit<AuditEntry, 'at'> & { at?: string }): AuditEntry {
  const entry: AuditEntry = { at: e.at || new Date().toISOString(), ...e } as AuditEntry;
  if (entry.detail && SECRET_RE.test(entry.detail) && !/needs|missing|not /i.test(entry.detail)) delete entry.detail;
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch {
    /* never fail the caller */
  }
  return entry;
}

/** Newest last. */
export function readAudit(limit = 50): AuditEntry[] {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Probes — injectable so the registry is unit-testable without gh / claude /
// Composio / a desktop. Defaults reuse onboarding.ts's gates verbatim.
// ---------------------------------------------------------------------------

export interface CapabilityProbes {
  identity: () => Identity | null;
  claude: () => { cli: boolean; authed: boolean };
  git: () => { authed: boolean; gh: boolean };
  repos: () => Array<{ name: string; present: boolean; dir: string; source: string }>;
  whatsapp: () => { status: string; qr: string | null; user: string | null };
  desktop: () => { enabled: boolean; display: string | null; up: boolean };
  push: () => boolean;
  remote: () => { available: boolean; loggedIn?: boolean; serving?: boolean; httpsUrl?: string | null; reason?: string };
  telemetry: () => { enabled: boolean; reason: string };
  composioKey: () => boolean;
  // Connected toolkits (ACTIVE connected accounts). null = unknown (no key / offline).
  composioConnected: () => Promise<Set<string> | null>;
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
    const slugs = new Set<string>(
      (j.items || []).filter((c: any) => c.status === 'ACTIVE').map((c: any) => String(c.toolkit?.slug || '').toLowerCase()).filter(Boolean)
    );
    composioCache = { at: now, slugs, keyed: true };
    return slugs;
  } catch {
    // Keep a stale answer rather than flapping to "unknown" on a blip.
    return composioCache?.slugs ?? null;
  }
}

const desktopProbe = (): { enabled: boolean; display: string | null; up: boolean } => {
  const enabled = !!cfg.screen?.enabled;
  const display = enabled ? cfg.screen?.display || ':99' : null;
  return { enabled, display, up: display ? ob.desktopUp(display) : false };
};

export const defaultProbes: CapabilityProbes = {
  identity: readIdentity,
  claude: () => ({ cli: ob.defaultProbes.claudeCli(), authed: ob.defaultProbes.claudeAuth() }),
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
      return { status: typeof j?.status === 'string' ? j.status : 'disconnected', qr: j?.qrUrl ?? null, user: j?.user ?? null };
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
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const SETUP_EVENTS = ['setup', 'onboarding.step'];

function staticCapabilities(p: CapabilityProbes): Capability[] {
  return [
    {
      id: 'identity',
      title: 'Google identity (Chrome)',
      group: 'core',
      check: () => {
        const id = p.identity();
        return id
          ? { ok: true, detail: `signed in as ${id.email}`, data: { email: id.email, connectedAt: id.connectedAt, providers: Object.keys(id.providers) } }
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
      id: 'git',
      title: 'Git / GitHub',
      group: 'code',
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
      check: () => {
        const w = p.whatsapp();
        return w.status === 'connected'
          ? { ok: true, detail: `connected${w.user ? ` · ${w.user}` : ''}`, data: { status: w.status, user: w.user } }
          : { ok: false, detail: w.status === 'qr' ? 'scan the QR code with WhatsApp' : 'not connected — scan a QR code to pair', data: { status: w.status, qr: w.qr } };
      },
      manual: { kind: 'qr', start: '/__api/whatsapp/connect', help: 'WhatsApp → Linked devices → Link a device → scan.' },
      autoCapable: false,
      events: [...SETUP_EVENTS, 'whatsapp'],
    },
    {
      id: 'desktop',
      title: 'Desktop (browser / screen)',
      group: 'machine',
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

function composioCapability(toolkit: string, p: CapabilityProbes): Capability {
  const slug = toolkit.toLowerCase();
  return {
    id: `composio:${slug}`,
    title: `${slug[0].toUpperCase()}${slug.slice(1)} (via Composio)`,
    group: 'integrations',
    check: async () => {
      if (!p.composioKey()) return { ok: false, detail: 'Composio is not connected — sign in to Composio first', data: { hasKey: false } };
      const set = await p.composioConnected();
      if (set === null) return { ok: false, detail: 'could not reach Composio to verify the connection', data: { hasKey: true, unknown: true } };
      return set.has(slug)
        ? { ok: true, detail: 'connected', data: { hasKey: true } }
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

/** All capabilities currently worth listing: statics + every registered repo + known/seen toolkits. */
export function listCapabilities(probes: Partial<CapabilityProbes> = {}): Capability[] {
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  const repos = p.repos().map((r) => repoCapability(r.name, p));
  const toolkits = [...new Set([...KNOWN_COMPOSIO_TOOLKITS, ...seenToolkits])].map((t) => composioCapability(t, p));
  return [...staticCapabilities(p), ...repos, ...toolkits];
}

// Toolkits somebody asked about (request_setup / check) join the listing.
const seenToolkits = new Set<string>();

/** Resolve one id (dynamic ids are built on demand). null = not a valid id. */
export function getCapability(id: string, probes: Partial<CapabilityProbes> = {}): Capability | null {
  if (!isCapabilityId(id)) return null;
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  if (id.startsWith('repo:')) return repoCapability(id.slice(5), p);
  if (id.startsWith('composio:')) {
    seenToolkits.add(id.slice(9).toLowerCase());
    return composioCapability(id.slice(9), p);
  }
  return staticCapabilities(p).find((c) => c.id === id) ?? null;
}

// AUTO_CAPABLE — the ids the agent may connect itself once an identity exists.
export const AUTO_CAPABLE = (id: string): boolean => !!getCapability(id)?.autoCapable;

/** Effective default `mode` for a request_setup right now. */
export function defaultMode(cap: Capability, probes: Partial<CapabilityProbes> = {}): 'auto' | 'manual' {
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  return cap.autoCapable && !!p.identity() ? 'auto' : 'manual';
}

export async function statusOf(cap: Capability, probes: Partial<CapabilityProbes> = {}): Promise<CapabilityStatus> {
  let r: CheckResult;
  try {
    r = await cap.check();
  } catch (e) {
    r = { ok: false, detail: `check failed: ${(e as Error).message}` };
  }
  return {
    id: cap.id,
    title: cap.title,
    group: cap.group,
    ok: r.ok,
    detail: r.detail,
    ...(r.data ? { data: r.data } : {}),
    manual: cap.manual,
    autoCapable: cap.autoCapable,
    ...(cap.playbook ? { playbook: cap.playbook } : {}),
    events: cap.events,
    defaultMode: defaultMode(cap, probes),
  };
}

/** GET /__api/setup/capabilities payload. */
export async function capabilitiesStatus(probes: Partial<CapabilityProbes> = {}): Promise<{ identity: Identity | null; capabilities: CapabilityStatus[] }> {
  const p: CapabilityProbes = { ...defaultProbes, ...probes };
  const caps = listCapabilities(probes);
  const capabilities = await Promise.all(caps.map((c) => statusOf(c, probes)));
  return { identity: p.identity(), capabilities };
}

/** `{ok:true}` or the needs_setup shape — the one helper every wrapper uses. */
export async function ensure(id: string, why: string, probes: Partial<CapabilityProbes> = {}): Promise<{ ok: true; detail: string } | NeedsSetup> {
  const cap = getCapability(id, probes);
  if (!cap) return needsSetup(id, why, `unknown capability ${id} — use one of the registry ids`);
  try {
    const r = await cap.check();
    if (r.ok) return { ok: true, detail: r.detail };
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
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
