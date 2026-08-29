// Server-side MCP client for Linear (https://mcp.linear.app/mcp).
//
// Why this exists: the launcher's ticket list needs LIVE Linear data + working
// filters. Rather than a personal API key, we connect to Linear's official
// remote MCP over OAuth (DCR + PKCE, public client). The host runs its own
// HTTP server, so the OAuth redirect lands back on us at
// /__api/linear/oauth/callback.
//
// Isolation guarantee: this token is arigami's OWN independent OAuth grant,
// stored ONLY in ~/.arigami/linear-oauth.json (mode 600). It never touches
// Claude Code's Keychain credentials. Disconnect = delete that one file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { cfg } from './state.js';

const SERVER_URL = 'https://mcp.linear.app/mcp';
const STORE = path.join(
  cfg.configDir!,
  'linear-oauth.json'
);

interface Store {
  clientInformation?: OAuthClientInformationMixed;
  // The origin clientInformation.redirect_uris was registered for — Linear
  // rejects an authorize request whose redirect_uri wasn't in that set, so a
  // change of origin (e.g. localhost → tailnet) must re-register, not reuse.
  registeredOrigin?: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return {};
  }
}
function save(s: Store): void {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[linear-mcp] could not persist store:', (e as Error).message);
  }
}

// ---- OAuth provider (file-backed, redirect captured for the UI) ------------
let pendingAuthUrl: string | null = null;

// The origin (scheme://host[:port]) the browser used to reach the cockpit for
// THIS auth attempt — set by startAuth() from the request that kicked it off.
// Linear's OAuth callback must land back on whatever origin actually reached
// us, not a fixed localhost: over Tailscale/LAN that's a different device
// than the one running this server, so a hardcoded localhost redirect just
// dead-ends there. Falls back to localhost for CLI/non-request callers.
// Redirect URIs must be absolute — the only legitimate absolute-URL site.
const fallbackOrigin = () => cfg.publicUrl || `http://localhost:${cfg.port}`;
let currentOrigin = fallbackOrigin();

const provider: OAuthClientProvider = {
  get redirectUrl() {
    return `${currentOrigin}/__api/linear/oauth/callback`;
  },
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Arigami',
      redirect_uris: [this.redirectUrl as string],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read',
    };
  },
  state() {
    const s = load();
    if (!s.state) {
      s.state = crypto.randomBytes(16).toString('hex');
      save(s);
    }
    return s.state;
  },
  clientInformation() {
    return load().clientInformation;
  },
  saveClientInformation(info) {
    const s = load();
    s.clientInformation = info;
    s.registeredOrigin = currentOrigin;
    save(s);
  },
  tokens() {
    return load().tokens;
  },
  saveTokens(tokens) {
    const s = load();
    s.tokens = tokens;
    save(s);
  },
  redirectToAuthorization(url) {
    pendingAuthUrl = url.toString();
  },
  saveCodeVerifier(verifier) {
    const s = load();
    s.codeVerifier = verifier;
    save(s);
  },
  codeVerifier() {
    const v = load().codeVerifier;
    if (!v) throw new Error('no PKCE code verifier saved');
    return v;
  },
  invalidateCredentials(scope) {
    const s = load();
    if (scope === 'all') {
      save({});
    } else {
      if (scope === 'tokens' || scope === 'client') delete s.tokens;
      if (scope === 'client') delete s.clientInformation;
      if (scope === 'verifier') delete s.codeVerifier;
      save(s);
    }
  },
};

// ---- connection management -------------------------------------------------
const NEEDS_AUTH = 'LINEAR_NEEDS_AUTH';

let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let connecting: Promise<Client> | null = null;

function newTransport(): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
}

// Connect using stored tokens. If none/expired and refresh fails, the provider
// captures an authorization URL and we throw NEEDS_AUTH (the caller surfaces it).
async function connect(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    pendingAuthUrl = null;
    const c = new Client({ name: 'arigami', version: '0.1.0' }, { capabilities: {} });
    const t = newTransport();
    try {
      await c.connect(t);
      client = c;
      transport = t;
      return c;
    } catch (e) {
      transport = t; // keep it for finishAuth()
      if (pendingAuthUrl) throw new Error(NEEDS_AUTH);
      throw e;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

// ---- public API ------------------------------------------------------------
export function status(): { connected: boolean; needsAuth: boolean; authUrl: string | null } {
  return { connected: !!load().tokens, needsAuth: false, authUrl: null };
}

// Kick off (or confirm) the OAuth flow. `origin` is the scheme://host[:port]
// the browser used to reach the cockpit for this attempt — the OAuth redirect
// must land back there, not on a fixed localhost (see `currentOrigin` above).
// Returns an authUrl when consent is needed, or { connected: true } when
// tokens already work.
export async function startAuth(
  origin?: string
): Promise<{ connected: boolean; authUrl?: string }> {
  currentOrigin = origin || fallbackOrigin();
  // The previously-DCR'd client was registered with a different origin's
  // redirect_uri — Linear will reject an authorize request quoting a
  // redirect_uri outside that set, so force fresh registration instead of
  // reusing it. Also covers clients registered before `registeredOrigin`
  // existed (undefined !== currentOrigin) — those were always localhost-only.
  const s = load();
  if (s.clientInformation && s.registeredOrigin !== currentOrigin) {
    provider.invalidateCredentials?.('client');
  }
  try {
    await connect();
    return { connected: true };
  } catch (e) {
    if ((e as Error).message === NEEDS_AUTH && pendingAuthUrl) {
      return { connected: false, authUrl: pendingAuthUrl };
    }
    throw e;
  }
}

// OAuth redirect handler: exchange the code for tokens, then connect for real.
export async function finishAuth(code: string, returnedState?: string): Promise<void> {
  if (returnedState && provider.state) {
    const expected = await provider.state();
    if (expected && returnedState !== expected) throw new Error('OAuth state mismatch');
  }
  const t = transport || newTransport();
  await t.finishAuth(code);
  // reset and reconnect with the freshly stored tokens
  client = null;
  transport = null;
  await connect();
}

export function disconnect(): void {
  try {
    fs.rmSync(STORE, { force: true });
  } catch {}
  client = null;
  transport = null;
}

// Extract a usable array/object payload from an MCP tool result.
function parseToolResult(res: any): any {
  if (res?.structuredContent !== undefined) return res.structuredContent;
  const text = (res?.content || [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Pull an array out of whatever shape a list tool returned.
function arrayFrom(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  for (const k of ['issues', 'labels', 'nodes', 'data', 'results', 'teams', 'states', 'statuses', 'workflowStates']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  // Generic fallback: first array-valued property (covers tools that wrap their
  // list under a name we didn't enumerate).
  if (payload && typeof payload === 'object') {
    for (const v of Object.values(payload)) if (Array.isArray(v)) return v as any[];
  }
  return [];
}

export interface Facets {
  assignee?: string; // 'me' | 'any'
  state?: string;
  label?: string; // single label (legacy; still honoured)
  labels?: string[]; // multi-select labels
  labelOp?: 'and' | 'or'; // how to combine `labels` (default 'or')
  priority?: string | number;
  query?: string;
  orderBy?: string;
  limit?: number;
}

// Build the list_issues arguments from composable facets (empties dropped).
function buildArgs(f: Facets): Record<string, any> {
  const a: Record<string, any> = {};
  if (f.assignee === 'me') a.assignee = 'me';
  if (f.state) a.state = f.state;
  if (f.label) a.label = f.label;
  if (f.query) a.query = f.query;
  if (f.priority !== '' && f.priority != null) a.priority = Number(f.priority);
  a.orderBy = f.orderBy === 'createdAt' ? 'createdAt' : 'updatedAt';
  a.limit = f.limit || 50;
  return a;
}

export async function listIssues(facets: Facets = {}): Promise<any[]> {
  const c = await connect();
  const res = await c.callTool({ name: 'list_issues', arguments: buildArgs(facets) });
  return arrayFrom(parseToolResult(res));
}

function issueId(it: any): string {
  return String(it?.identifier || it?.id || it?.key || '');
}

function issueLabelNames(it: any): string[] {
  const raw = Array.isArray(it?.labels) ? it.labels : it?.labels?.nodes || [];
  return raw.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

// Linear's list_issues takes a SINGLE `label` string — no array, no operator.
// This wraps listIssues to express multi-label filters the API can't:
//   0–1 labels → one call (unchanged)
//   OR + N     → N calls, union + dedup by id
//   AND + N    → 1 call on the first label, then intersection-filter on labels
// Shared by the launcher's ticket picker and the trigger poll runner so "what
// matches" is defined in exactly one place.
export async function listIssuesByFacets(facets: Facets = {}): Promise<any[]> {
  const labels =
    facets.labels && facets.labels.length
      ? facets.labels
      : facets.label
        ? [facets.label]
        : [];
  const op = facets.labelOp === 'and' ? 'and' : 'or';

  if (labels.length <= 1) {
    return listIssues({ ...facets, label: labels[0], labels: undefined });
  }

  if (op === 'or') {
    const results = await Promise.all(
      labels.map((l) => listIssues({ ...facets, label: l, labels: undefined }))
    );
    const byId = new Map<string, any>();
    for (const list of results) {
      for (const it of list) {
        const id = issueId(it);
        if (id && !byId.has(id)) byId.set(id, it);
      }
    }
    return Array.from(byId.values());
  }

  // AND: narrow on the first label, then keep only issues carrying the rest.
  const [first, ...rest] = labels;
  const list = await listIssues({ ...facets, label: first, labels: undefined });
  return list.filter((it) => {
    const names = new Set(issueLabelNames(it));
    return rest.every((l) => names.has(l));
  });
}

// Team name/ID keys — labels and statuses are both team-scoped, so we enumerate
// teams and fan out per team (plus the workspace level) to get the full set.
async function teamKeys(c: Client): Promise<string[]> {
  try {
    const res = await c.callTool({ name: 'list_teams', arguments: { limit: 100 } });
    return arrayFrom(parseToolResult(res))
      .map((t: any) => t?.id || t?.key || t?.name)
      .filter(Boolean)
      .map(String);
  } catch {
    return [];
  }
}

// All label names — workspace-level PLUS each team's labels (Linear labels can be
// team-scoped, so the bare call misses most of them).
export async function listLabels(): Promise<string[]> {
  const c = await connect();
  const names = new Set<string>();
  const add = (payload: any) => {
    for (const l of arrayFrom(payload)) {
      const n = typeof l === 'string' ? l : l?.name;
      if (n) names.add(n);
    }
  };
  try {
    add(parseToolResult(await c.callTool({ name: 'list_issue_labels', arguments: { limit: 250 } })));
  } catch {}
  for (const team of await teamKeys(c)) {
    try {
      add(parseToolResult(await c.callTool({ name: 'list_issue_labels', arguments: { team, limit: 250 } })));
    } catch {}
  }
  return [...names].sort();
}

// Linear workflow statuses are per-team, so we enumerate teams and union their
// statuses by name. Returns [{ name, type }] sorted by Linear's lifecycle order
// then name. `state` on list_issues accepts a status NAME, so the name is the
// value the filter sends.
const STATE_TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

export async function listStatuses(): Promise<{ name: string; type: string }[]> {
  const c = await connect();
  const byName = new Map<string, string>(); // name -> type
  for (const team of await teamKeys(c)) {
    try {
      const res = await c.callTool({ name: 'list_issue_statuses', arguments: { team } });
      for (const s of arrayFrom(parseToolResult(res))) {
        const name = typeof s === 'string' ? s : s?.name;
        const type = typeof s === 'object' ? s?.type || '' : '';
        if (name && !byName.has(name)) byName.set(name, type);
      }
    } catch {
      /* skip a team we can't read */
    }
  }
  return [...byName.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => {
      const ia = STATE_TYPE_ORDER.indexOf(a.type);
      const ib = STATE_TYPE_ORDER.indexOf(b.type);
      if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.name.localeCompare(b.name);
    });
}

export async function getIssue(id: string): Promise<any> {
  const c = await connect();
  const res = await c.callTool({ name: 'get_issue', arguments: { id } });
  return parseToolResult(res);
}

// Comments for an issue (newest last) — used by the linear-issue listener poll.
// Accepts the ENG-XXXX identifier or the UUID.
export async function listComments(issueId: string): Promise<any[]> {
  const c = await connect();
  const res = await c.callTool({ name: 'list_comments', arguments: { issueId } });
  return arrayFrom(parseToolResult(res));
}

// The connected OAuth user's id — the "self" whose comments the listener ignores
// (parallels github-pr's PR author). Cached: the viewer never changes within a
// connection, and the poll runs every ~30s. `get_user` resolves the viewer from
// the query "me" (there is no dedicated viewer tool on Linear's MCP surface).
let viewerIdCache: string | null = null;
export async function viewerId(): Promise<string | null> {
  if (viewerIdCache) return viewerIdCache;
  const c = await connect();
  const res = await c.callTool({ name: 'get_user', arguments: { query: 'me' } });
  const user = parseToolResult(res);
  const id = (Array.isArray(user) ? user[0]?.id : user?.id) || null;
  if (id) viewerIdCache = id;
  return id;
}

// Diagnostics: the tool list + schemas (used to tune arg mapping post-auth).
export async function listTools(): Promise<any> {
  const c = await connect();
  return c.listTools();
}

export const NEEDS_AUTH_MSG = NEEDS_AUTH;
