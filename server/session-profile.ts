// Session profiles — the opt-in "restricted" run mode (docs/SECURITY.md § Restricted sessions).
//
// A session WITHOUT a profile is a "Full" session and behaves exactly as before: nothing in this module touches it
// (every entry point returns early on `!s.profile`). A session WITH one carries an EFFECTIVE profile on the session
// record (`session.profile`, a host-owned field no PATCH can write) that the host enforces on every request:
//
//   - tools      an allowlist in the A3 vocabulary (families, host tools, built-ins, mcp__ patterns) — enforced by the
//                same four layers as an agent allowlist (--disallowedTools, the PreToolUse hook, the host MCP's hidden
//                set, the gateway), for claude and codex alike (agent-policy.ts);
//   - desktop    none | own (its own display + Chrome, never the owner's) | shared (the owner's desktop, but only
//                after a person allows it on a card);
//   - talkTo     parent / children — whom it may message (send_message, task_session, report_to_master);
//   - maySpawn   whether it may create sessions (always its own children, always inheriting this profile);
//   - triggers   whether it may create cron triggers and listeners;
//   - hostRoutes the host route groups it may reach besides its own session (memory, setup, agents…);
//   - grants     actions an extension performs FOR the session (`<ext>:<action>`, e.g. a gatekeeper's
//                `gatekeeper:github.push`). The host only stores and narrows them; the extension reads them from the
//                caller facts the MCP gateway attaches to each call and enforces them in its own code.
//
// The narrowing rule: a child's profile is its parent's profile narrowed by whatever else applies (folder, agent,
// trigger, an explicit pick) — never wider. Tool allowlists are kept as LAYERS (every layer must allow a tool), so
// narrowing is a structural append and needs no glob intersection; everything else is a min / intersection.
//
// Where a profile comes from (resolveForNewSession): the parent session's (metadata.master, or the creating session),
// the project folder's, the agent's, the trigger's, and an explicit `profile` on the create call. Bindings live in
// $ARIGAMI_DIR/session-profiles.json next to the named profiles (admin-only REST: /__api/session-profiles).
//
// Enforcement is the host's alone (the auth gate + the route handlers + the spawn), outside the agent process, and
// the same for every engine. A restricted session needs auth ON: with auth off any local caller without a token is
// the admin, so the host refuses to create one (and the gate still scopes a restricted session's own token).
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import { FAMILIES, expandTools, policyFor, type Policy } from './agent-policy.js';

export type DesktopMode = 'none' | 'own' | 'shared';
export type TalkTo = 'parent' | 'children';

export const DESKTOP_MODES: readonly DesktopMode[] = ['none', 'own', 'shared'];
export const TALK_TO: readonly TalkTo[] = ['parent', 'children'];
const DESKTOP_RANK: Record<DesktopMode, number> = { none: 0, own: 1, shared: 2 };

/** Host route groups a profile may open, beyond its own session's routes. Each maps to the host tools it serves. */
export const HOST_ROUTE_GROUPS: Record<string, string[]> = {
  memory: ['memory_write', 'memory_search', 'memory_get'],
  skills: ['skill_propose'],
  setup: ['request_setup', 'report_setup', 'check_setup'],
  agents: ['list_agents'],
  'host-resources': ['host_resources'],
};

/** What a person defines (a named profile) or what narrows one. Absent fields: see normalizeSpec. */
export interface ProfileSpec {
  name?: string;
  /** Allowlist in the A3 vocabulary; null/absent = this layer adds no tool restriction. */
  tools?: string[] | null;
  /** Host MCP tools (short or mcp__arigami__ names) — merged into the same allowlist layer as `tools`. */
  hostTools?: string[] | null;
  /** open_tab / WebFetch / browser_* domain allowlist (A3 semantics); null/absent = none from this layer. */
  domains?: string[] | null;
  desktop?: DesktopMode;
  talkTo?: TalkTo[];
  maySpawn?: boolean;
  triggers?: boolean;
  hostRoutes?: string[];
  /** Extension action grants (`<ext>:<action>`); absent = none. Narrowing intersects them. */
  grants?: string[];
}

export interface ProfileLayer {
  name: string;
  tools: string[] | null;
  domains: string[] | null;
}

/** The profile a session RUNS under — stored on the session, enforced by the host. */
export interface SessionProfile {
  name: string;
  layers: ProfileLayer[];
  desktop: DesktopMode;
  talkTo: TalkTo[];
  maySpawn: boolean;
  triggers: boolean;
  hostRoutes: string[];
  /** Extension action grants (see ProfileSpec.grants). Absent on profiles stored before grants existed = none. */
  grants?: string[];
  /** The host-recorded parent (set at creation, never changed by the session). */
  parent: string | null;
}

/** `<ext>:<action>` — an extension name, then a dotted action (no wildcards: narrowing is a plain intersection). */
export const GRANT_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]{0,63}$/;
const grantsOf = (p: { grants?: string[] } | null | undefined): string[] => (Array.isArray(p?.grants) ? p!.grants! : []);

/** The shipped profile: the narrowest useful one — read/write files and run commands, report up, nothing else. */
export const BUILTIN_PROFILES: Record<string, ProfileSpec> = {
  restricted: {
    name: 'Restricted',
    tools: ['git'],
    desktop: 'none',
    talkTo: ['parent', 'children'],
    maySpawn: false,
    triggers: false,
    hostRoutes: [],
  },
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const list = (v: unknown): string[] | null =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))] : null;

/** A spec with every field filled: absent = the restrictive default (a top-level profile starts closed). */
export function normalizeSpec(spec: ProfileSpec, fallbackName = 'restricted'): Required<Omit<ProfileSpec, 'hostTools'>> & { tools: string[] | null } {
  const tools = list(spec.tools);
  const host = list(spec.hostTools);
  const merged = tools || host ? [...(tools || []), ...(host || [])] : null;
  const desktop = DESKTOP_MODES.includes(spec.desktop as DesktopMode) ? (spec.desktop as DesktopMode) : 'none';
  const talkTo = (list(spec.talkTo) || ['parent', 'children']).filter((t): t is TalkTo => (TALK_TO as readonly string[]).includes(t));
  const hostRoutes = (list(spec.hostRoutes) || []).filter((g) => g in HOST_ROUTE_GROUPS);
  const domains = list(spec.domains);
  const grants = (list(spec.grants) || []).filter((g) => GRANT_RE.test(g));
  return {
    name: String(spec.name || fallbackName).slice(0, 80),
    tools: merged,
    domains: domains ? domains.map((d) => d.toLowerCase()) : null,
    desktop,
    talkTo,
    maySpawn: spec.maySpawn === true,
    triggers: spec.triggers === true,
    hostRoutes,
    grants,
  };
}

const layerOf = (n: { name: string; tools: string[] | null; domains: string[] | null }): ProfileLayer | null =>
  n.tools === null && n.domains === null ? null : { name: n.name, tools: n.tools ? expandTools(n.tools) : null, domains: n.domains };

/** A top-level profile from a spec (no parent). */
export function fromSpec(spec: ProfileSpec, parent: string | null = null): SessionProfile {
  const n = normalizeSpec(spec);
  const layer = layerOf(n);
  return { name: n.name, layers: layer ? [layer] : [], desktop: n.desktop, talkTo: n.talkTo, maySpawn: n.maySpawn, triggers: n.triggers, hostRoutes: n.hostRoutes, grants: n.grants, parent };
}

/**
 * `base` narrowed by `by` (a spec or another effective profile). Never wider than either: layers append, desktop is
 * the lower mode, talkTo / hostRoutes intersect, flags AND. A null side is "Full" — the other side wins as-is.
 */
export function narrow(base: SessionProfile | null, by: SessionProfile | ProfileSpec | null, parent: string | null = base?.parent ?? null): SessionProfile | null {
  if (!by) return base ? { ...base, parent } : null;
  const other: SessionProfile = 'layers' in by ? (by as SessionProfile) : fromSpec(by as ProfileSpec);
  if (!base) return { ...other, parent };
  const keep = new Set(base.layers.map((l) => JSON.stringify(l)));
  return {
    name: other.name || base.name,
    layers: [...base.layers, ...other.layers.filter((l) => !keep.has(JSON.stringify(l)))],
    desktop: DESKTOP_RANK[other.desktop] < DESKTOP_RANK[base.desktop] ? other.desktop : base.desktop,
    talkTo: base.talkTo.filter((t) => other.talkTo.includes(t)),
    maySpawn: base.maySpawn && other.maySpawn,
    triggers: base.triggers && other.triggers,
    hostRoutes: base.hostRoutes.filter((g) => other.hostRoutes.includes(g)),
    grants: grantsOf(base).filter((g) => grantsOf(other).includes(g)),
    parent,
  };
}

/** Is `child` within `parent` on every axis? (null = Full: everything is within Full; nothing but Full is Full.) */
export function isWithin(child: SessionProfile | null, parent: SessionProfile | null): boolean {
  if (!parent) return true;
  if (!child) return false;
  const prefix = parent.layers.every((l) => child.layers.some((c) => JSON.stringify(c) === JSON.stringify(l)));
  return (
    prefix &&
    DESKTOP_RANK[child.desktop] <= DESKTOP_RANK[parent.desktop] &&
    child.talkTo.every((t) => parent.talkTo.includes(t)) &&
    (!child.maySpawn || parent.maySpawn) &&
    (!child.triggers || parent.triggers) &&
    child.hostRoutes.every((g) => parent.hostRoutes.includes(g)) &&
    grantsOf(child).every((g) => grantsOf(parent).includes(g))
  );
}

// ---- the store: named profiles + where they are attached ------------------------------------------------------

export interface ProfileStore {
  profiles: Record<string, ProfileSpec>;
  /** `folder:<id>` | `agent:<slug>` | `trigger:<id>` → a profile id, or an effective snapshot. */
  attach: Record<string, string | SessionProfile>;
}

const STORE_FILE = () => path.join(ARIGAMI_DIR, 'session-profiles.json');
let cache: { mtime: number; store: ProfileStore } | null = null;

export function readStore(): ProfileStore {
  const f = STORE_FILE();
  let mtime = -1;
  try {
    mtime = fs.statSync(f).mtimeMs;
  } catch {
    /* no file = no profiles beyond the built-in */
  }
  if (cache && cache.mtime === mtime) return cache.store;
  let store: ProfileStore = { profiles: {}, attach: {} };
  if (mtime >= 0) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
      store = { profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}, attach: raw.attach && typeof raw.attach === 'object' ? raw.attach : {} };
    } catch (e) {
      console.error('[profiles] unreadable session-profiles.json:', (e as Error).message);
    }
  }
  cache = { mtime, store };
  return store;
}

export function writeStore(next: ProfileStore): ProfileStore {
  const clean: ProfileStore = { profiles: {}, attach: {} };
  for (const [id, spec] of Object.entries(next.profiles || {})) {
    if (!ID_RE.test(id) || !spec || typeof spec !== 'object') throw Object.assign(new Error(`invalid profile id: ${id}`), { status: 400 });
    const n = normalizeSpec(spec, id);
    clean.profiles[id] = { name: n.name, tools: n.tools, domains: n.domains, desktop: n.desktop, talkTo: n.talkTo, maySpawn: n.maySpawn, triggers: n.triggers, hostRoutes: n.hostRoutes, ...(n.grants.length ? { grants: n.grants } : {}) };
  }
  for (const [key, v] of Object.entries(next.attach || {})) {
    if (!/^(folder|agent|trigger):[A-Za-z0-9_-]{1,80}$/.test(key)) throw Object.assign(new Error(`invalid attach key: ${key}`), { status: 400 });
    if (typeof v === 'string') {
      if (v === 'full') continue; // Full = no binding
      if (!clean.profiles[v] && !BUILTIN_PROFILES[v]) throw Object.assign(new Error(`unknown profile: ${v}`), { status: 400 });
      clean.attach[key] = v;
    } else if (v && typeof v === 'object' && Array.isArray((v as SessionProfile).layers)) clean.attach[key] = v as SessionProfile;
  }
  const f = STORE_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  cache = null;
  return readStore();
}

/** Attach (or detach with null) one binding — used for snapshots the host takes itself (a restricted trigger). */
export function setAttachment(key: string, v: string | SessionProfile | null): void {
  const s = readStore();
  const attach = { ...s.attach };
  if (v === null) delete attach[key];
  else attach[key] = v;
  writeStore({ profiles: s.profiles, attach });
}

/** A named profile (store first, then built-in) as an effective profile; 'full' / unknown → null. */
export function namedProfile(id: string | null | undefined): SessionProfile | null {
  if (!id || id === 'full') return null;
  const spec = readStore().profiles[id] || BUILTIN_PROFILES[id];
  return spec ? fromSpec({ name: id, ...spec }) : null;
}

export const attachedProfile = (key: string): SessionProfile | null => attached(key);
const attached = (key: string): SessionProfile | null => {
  const v = readStore().attach[key];
  if (!v) return null;
  return typeof v === 'string' ? namedProfile(v) : (v as SessionProfile);
};

/** An explicit pick ('<id>' | 'full' | an inline spec | an effective profile) as an effective profile. */
export function asProfile(x: unknown): SessionProfile | null {
  if (!x) return null;
  if (typeof x === 'string') return namedProfile(x);
  if (typeof x === 'object' && Array.isArray((x as SessionProfile).layers)) return x as SessionProfile;
  return typeof x === 'object' ? fromSpec(x as ProfileSpec) : null;
}

/** Is `id` a profile the host knows ('full' included)? */
export const knownProfile = (id: string): boolean => id === 'full' || !!readStore().profiles[id] || !!BUILTIN_PROFILES[id];

// ---- which profile a new session gets ---------------------------------------------------------------------------

type SessionLike = { id: string; profile?: SessionProfile | null; metadata?: Record<string, unknown> | null; folderId?: string | null };

export interface NewSessionInputs {
  /** The parent session (metadata.master, or the restricted session creating it). */
  parent?: SessionLike | null;
  folderId?: string | null;
  agent?: string | null;
  triggerId?: string | null;
  /** An explicit pick on the create call: a profile id ('full' = none of its own) or an inline spec. */
  explicit?: string | ProfileSpec | SessionProfile | null;
}

/** Fold every source that applies — each can only narrow. null = a Full session (no source applies). */
export function resolveForNewSession(i: NewSessionInputs): SessionProfile | null {
  // A cron run has no parent session; a trigger a restricted session created carries its creator as the parent.
  const trig = i.triggerId ? attached(`trigger:${i.triggerId}`) : null;
  const parentId = i.parent?.id ?? trig?.parent ?? null;
  let p: SessionProfile | null = i.parent?.profile ? { ...i.parent.profile, parent: parentId } : null;
  if (i.folderId) p = narrow(p, attached(`folder:${i.folderId}`), parentId);
  if (i.agent) p = narrow(p, attached(`agent:${i.agent}`), parentId);
  if (trig) p = narrow(p, trig, parentId);
  if (i.explicit) p = narrow(p, asProfile(i.explicit), parentId);
  return p ? { ...p, parent: parentId } : null;
}

// ---- the policy the A3 layers enforce for a session --------------------------------------------------------------

const SCREEN_TOOLS = ['capture_screen', 'request_screen', 'desktop_screenshot', 'desktop_pointer', 'desktop_keyboard', 'desktop_launch', 'desktop_quit'];
/** Everything that reaches the OWNER's desktop / Chrome / vault — the sign-in ladder and the shared lease. */
export const SHARED_TOOLS = [
  'shared_desktop_acquire', 'shared_desktop_release', 'sign_in', 'vault_fields', 'vault_collect', 'vault_fill',
  'browser_logins', 'request_login', 'sso_login', 'sso_look', 'sso_click', 'sso_navigate', 'sso_done', 'request_credentials',
  'save_login', 'save_browser_logins',
];
/** Never for a restricted session: they change the host, an agent, or another session's standing. */
export const NEVER_TOOLS = ['host_restart', 'create_agent', 'update_agent', 'permission_prompt_answer'];

/** The tools a profile's flags take away, whatever its allowlist says (they beat CORE_TOOLS too). */
export function deniedByFlags(p: SessionProfile): string[] {
  const out = new Set<string>(NEVER_TOOLS);
  if (p.desktop === 'none') for (const t of [...SCREEN_TOOLS, ...SHARED_TOOLS, ...FAMILIES.browser]) out.add(t);
  if (p.desktop === 'own') for (const t of SHARED_TOOLS) out.add(t);
  if (!p.maySpawn) out.add('create_session');
  if (!p.triggers) for (const t of FAMILIES.triggers) if (t !== 'list_listeners' && t !== 'cancel_listener') out.add(t);
  for (const [g, tools] of Object.entries(HOST_ROUTE_GROUPS)) if (!p.hostRoutes.includes(g)) for (const t of tools) out.add(t);
  return [...out];
}

/**
 * Tools a profile FLAG decides (desktop mode, maySpawn, triggers, host route groups): the flags layer alone allows or
 * denies them, so an allowlist layer does not have to repeat them (desktop:'own' means the screen tools, whatever
 * `tools` lists).
 */
export const FLAG_TOOLS = [...new Set([...SCREEN_TOOLS, ...SHARED_TOOLS, ...FAMILIES.browser, 'create_session', ...FAMILIES.triggers, ...Object.values(HOST_ROUTE_GROUPS).flat()])];

/** The profile as A3 policy layers (every one must allow). */
export function profilePolicies(p: SessionProfile): Policy[] {
  const flags: Policy = { slug: `profile:${p.name}`, tools: null, domains: null, autoApprove: [], deny: deniedByFlags(p) };
  return [flags, ...p.layers.map((l) => ({ slug: `profile:${l.name}`, tools: l.tools ? [...l.tools, ...FLAG_TOOLS] : null, domains: l.domains, autoApprove: [] }))];
}

/**
 * THE policy for a session: its agent's (A3, unchanged) plus its profile's layers. A Full session without an agent
 * → null, exactly as policyFor(null) always was; an agent session without a profile → policyFor(slug) as-is.
 */
export function policyForSession(s: { metadata?: Record<string, unknown> | null; profile?: SessionProfile | null } | null | undefined): Policy | null {
  const slug = typeof s?.metadata?.agent === 'string' && s.metadata.agent ? (s.metadata.agent as string) : null;
  const agentPolicy = policyFor(slug);
  if (!s?.profile) return agentPolicy;
  const layers = profilePolicies(s.profile);
  if (!agentPolicy) {
    const [head, ...rest] = layers;
    return { ...head, and: rest };
  }
  return { ...agentPolicy, and: [...(agentPolicy.and || []), ...layers] };
}

// ---- per-session API scope ---------------------------------------------------------------------------------------

type Lookup = (id: string) => (SessionLike & { profile?: SessionProfile | null }) | null;
type ToolCheck = (tool: string) => boolean;

/** Own-session sub-routes → the host tool each one serves ('*' = plumbing every session keeps). */
const OWN_ROUTES: [RegExp, string | ((m: string, sub: string) => string | null)][] = [
  [/^$/, (m) => (m === 'GET' || m === 'PATCH' ? '*' : null)],
  [/^(policy|policy\/check|mods\/tool-post|mods\/notice)$/, '*'],
  [/^report$/, 'report_to_master'],
  [/^restart$/, 'restart_session'],
  [/^allocate-port$/, 'allocate_port'],
  [/^tabs$/, 'open_tab'],
  [/^tabs\/[^/]+$/, (m) => (m === 'DELETE' ? 'close_tab' : 'update_tab')],
  [/^activate-tab$/, 'activate_tab'],
  [/^artifacts$/, 'publish_artifact'],
  [/^artifacts\/[^/]+\/share$/, (m) => (m === 'DELETE' ? 'unshare_artifact' : 'share_artifact')],
  [/^ui$/, 'render_ui'],
  [/^action$/, 'request_action'],
  [/^summary\/result$/, 'set_status_summary'],
  [/^changes\/explanation$/, 'set_changes_explanation'],
  [/^listeners$/, (m) => (m === 'POST' ? 'register_listener' : 'list_listeners')],
  [/^listeners\/[^/]+$/, 'cancel_listener'],
  [/^screenshot$/, 'capture_screen'],
  [/^(screen\/allocate|screens)$/, 'capture_screen'],
  [/^desktop\/screenshot$/, 'desktop_screenshot'],
  [/^desktop\/act$/, 'desktop_pointer'],
  [/^desktop\/(type|clipboard|selection)$/, 'desktop_keyboard'],
  [/^desktop\/launch$/, 'desktop_launch'],
  [/^desktop\/quit$/, 'desktop_quit'],
  [/^shared-desktop\/acquire$/, 'shared_desktop_acquire'],
  [/^shared-desktop\/release$/, 'shared_desktop_release'],
  [/^sign-in$/, 'sign_in'],
  [/^vault\/(fields|collect|fill)$/, (_m, sub) => `vault_${sub.slice(6)}`],
  [/^logins$/, 'browser_logins'],
  [/^login-request$/, 'request_login'],
  [/^credentials\/request$/, 'request_credentials'],
  [/^sso-request$/, 'sso_login'],
  [/^sso\/(look|click|navigate|done)$/, (_m, sub) => `sso_${sub.slice(4)}`],
  [/^login-save$/, 'save_login'],
  [/^browser\/sync-logins$/, 'save_browser_logins'],
  [/^browser\/(open|navigate|snapshot|click|type|scroll|close)$/, (_m, sub) => `browser_${sub.slice(8)}`],
];

/** Lifecycle routes a parent keeps on its own children. Messaging (task/send) is judged by talkTo. */
const CHILD_ROUTES = /^(|restart|merge|merge\/status|orchestration)$/;

/** Host routes outside /__api/sessions/<id> → the tool each serves ('*' = always). */
function hostRouteTool(method: string, p: string): string | null {
  if (p === '/__api/listener-types' && method === 'GET') return '*';
  if (p === '/__mcp/wait' || p === '/__mcp/permission') return '*';
  if (p === '/__api/sessions') return method === 'POST' ? 'create_session' : method === 'GET' ? '*' : null; // the list is filtered to the family
  if (p === '/__api/triggers' || p.startsWith('/__api/triggers/')) return 'cronjob';
  if (p === '/__api/memory/write' && method === 'POST') return 'memory_write';
  if (p === '/__api/memory/search' && method === 'GET') return 'memory_search';
  if (p === '/__api/memory/get' && method === 'GET') return 'memory_get';
  if (p === '/__api/skill-proposals' && method === 'POST') return 'skill_propose';
  if (p === '/__api/agents' && method === 'GET') return 'list_agents';
  if (p.startsWith('/__api/setup/capabilities/') && method === 'GET') return 'check_setup';
  if (p === '/__mcp/setup-request') return 'request_setup';
  if (p === '/__mcp/setup-report') return 'report_setup';
  if (p === '/__mcp/screen-request') return 'request_screen';
  if (p === '/__api/host/resources' && method === 'GET') return 'host_resources';
  if (p === '/__api/whatsapp/tool' && method === 'POST') return 'whatsapp';
  if (p === '/__api/voice/call' && method === 'POST') return 'call_contact';
  if (p === '/__api/voice/sms' && method === 'POST') return 'send_sms';
  return null;
}

/**
 * Why a request from restricted session `callerId` must be refused (403), or null. Called by the auth gate for every
 * request whose bearer is a session token. A Full caller (no profile) → null, always: today's behaviour exactly.
 */
export function scopeRefusal(callerId: string, method: string, pathname: string, deps: { getSession: Lookup; toolAllowed: (caller: SessionLike, tool: string) => boolean; upgrade?: boolean }): string | null {
  const me = deps.getSession(callerId);
  if (!me?.profile) return null;
  const prof = me.profile;
  const no = (what: string) => `restricted session (profile "${prof.name}"): ${what}`;
  if (deps.upgrade) return no('no WebSocket / desktop stream access');
  const allowed: ToolCheck = (t) => t === '*' || deps.toolAllowed(me, t);
  const m = String(method || 'GET').toUpperCase();

  // The MCP gateway: the host server always; other servers are judged in the gateway against the same policy.
  if (pathname.startsWith('/__mcp/s/')) return null;

  const sm = /^\/__api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (sm && sm[1] !== 'reorder') {
    const target = sm[1];
    const sub = sm[2] || '';
    if (target === callerId) {
      for (const [re, tool] of OWN_ROUTES) {
        if (!re.test(sub)) continue;
        const t = typeof tool === 'function' ? tool(m, sub) : tool;
        if (t && allowed(t)) return null;
        return no(`${m} ${sub || '(session)'} is not in its profile`);
      }
      return no(`${m} ${sub} on its own session is not allowed`);
    }
    const other = deps.getSession(target);
    if (!other) return null; // the route answers 404 itself
    const isChild = other.profile?.parent === callerId;
    const isParent = prof.parent === target;
    if (isChild && CHILD_ROUTES.test(sub) && (sub !== '' || m === 'GET' || m === 'DELETE')) return null;
    if (isChild && (sub === 'task' || sub === 'send') && m === 'POST' && prof.talkTo.includes('children')) return null;
    if (isParent && sub === 'send' && m === 'POST' && prof.talkTo.includes('parent')) return null;
    return no(isChild || isParent ? `${m} ${sub || '(session)'} on ${isChild ? 'its child' : 'its parent'} is not in its profile` : `it may only reach its own session, its parent and its children`);
  }

  const t = hostRouteTool(m, pathname);
  if (t && allowed(t)) return null;
  return no(`${m} ${pathname} is not in its profile`);
}

/** May restricted `from` deliver a message to `to`? (send_message / task_session / a cron 'existing:' target) */
export function mayMessage(from: SessionLike, to: SessionLike): boolean {
  const p = from.profile;
  if (!p) return true;
  if (to.id === from.id) return true;
  if (p.parent === to.id) return p.talkTo.includes('parent');
  if (to.profile?.parent === from.id) return p.talkTo.includes('children');
  return false;
}

/** The sessions a restricted caller may see in a list: itself, its parent, its children. */
export function inFamily(me: SessionLike, s: SessionLike): boolean {
  return s.id === me.id || s.id === me.profile?.parent || s.profile?.parent === me.id;
}

/**
 * A restricted session's PATCH of its own record: cockpit fields only, and none of the metadata keys the host reads
 * as identity or authority (agent → its A3 policy, master → whom it reports to, cron/role pointers …).
 */
export const PROTECTED_METADATA = ['screen', 'agent', 'adoptedFrom', 'master', 'role', 'kind', 'subtask', 'agentHome', 'cronTriggerId', 'fromCronTrigger', 'cronDeliver', 'worktree', 'branch', 'base', 'repo', 'cleanup', 'review', 'prompts', 'profile', 'origin'];
const OWN_PATCHABLE = ['title', 'color', 'status', 'progress', 'metadata'];

export function sanitizeOwnPatch(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of OWN_PATCHABLE) if (k in body) out[k] = body[k];
  if (out.metadata && typeof out.metadata === 'object') {
    const md = { ...(out.metadata as Record<string, unknown>) };
    for (const k of PROTECTED_METADATA) delete md[k];
    out.metadata = md;
  }
  return out;
}

/** The short, wire-safe description of a session's profile (cockpit badge, /policy). */
export const describe = (p: SessionProfile | null | undefined) =>
  p ? { name: p.name, desktop: p.desktop, talkTo: p.talkTo, maySpawn: p.maySpawn, triggers: p.triggers, hostRoutes: p.hostRoutes, grants: grantsOf(p), parent: p.parent, layers: p.layers.map((l) => l.name) } : null;

// ---- shared desktop by approval -----------------------------------------------------------------------------------

/** Live grants: a person allowed restricted session <id> onto the shared desktop until <ms>. */
const sharedGrants = new Map<string, number>();
export const SHARED_GRANT_MS = 30 * 60_000;
export const grantShared = (sessionId: string, now = Date.now()) => sharedGrants.set(sessionId, now + SHARED_GRANT_MS);
export const revokeShared = (sessionId: string) => sharedGrants.delete(sessionId);
export const hasSharedGrant = (sessionId: string, now = Date.now()) => (sharedGrants.get(sessionId) || 0) > now;

// ---- the environment a restricted session is spawned with: server/lib/session-env.ts (no imports, so the spawn
// helpers — oneshot, desktops — can use it without an import cycle through agent-policy). Re-exported here.
export { ENV_ALLOW, ENGINE_CREDENTIALS, restrictedEnv, spawnEnvFor } from './lib/session-env.js';
