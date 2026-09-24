// Remote MCP grants held by the HOST, not by an engine.
//
// Before: connecting Linear meant `claude mcp login linear` — the token lived in
// Claude Code's own credentials for that account, and Codex needed a second
// `codex mcp login`. Each engine (and each Claude account) held its own grant,
// and the calls went straight from the engine to the vendor, past the host.
//
// Now the host runs the OAuth itself (MCP SDK `auth()`: discovery, dynamic
// client registration, PKCE, refresh) and keeps ONE grant per name here. Every
// session of every engine reaches the vendor through the MCP gateway
// (/__mcp/s/<name>), which holds the only live client for that grant — so a
// login serves Claude and Codex alike, survives an account switch, and every
// call passes the host (where the outbound gate lives).
//
// The file is $ARIGAMI_DIR/mcp-grants.json, 0600, and machine-local: tokens,
// the registered client, the PKCE verifier while a login is open. Nothing here
// is ever returned by an API — callers get names, states and authorize URLs.
//
// Names are the grant names the catalog already uses (`linear`,
// `linear--<agent>`), so tools stay `mcp__linear__*`; a gateway entry of the
// same name in --mcp-config replaces a CLI-configured one (measured on Claude
// Code: the dynamic server wins and the user-scope one is never contacted).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ARIGAMI_DIR } from './instance.js';

export interface Grant {
  name: string;
  slug: string;
  owner: string;
  url: string;
  auth: 'oauth' | 'bearer';
  at: string;
  /** OAuth: the redirect the client was registered with. */
  redirect?: string;
  client?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  verifier?: string;
  discovery?: Record<string, unknown>;
  /** bearer: the header the vendor wants. */
  header?: { name: string; value: string };
  /** The vendor refused the refresh — a person has to sign in again. */
  needsLogin?: boolean;
}

export const grantsFile = (): string => path.join(ARIGAMI_DIR, 'mcp-grants.json');

function readAll(): Record<string, Grant> {
  try {
    const j = JSON.parse(fs.readFileSync(grantsFile(), 'utf8'));
    return j && typeof j.grants === 'object' ? j.grants : {};
  } catch {
    return {};
  }
}
function writeAll(grants: Record<string, Grant>): void {
  const file = grantsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, grants }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function patch(name: string, fn: (g: Grant) => Grant | null): void {
  const all = readAll();
  const next = all[name] ? fn(all[name]) : null;
  if (next) all[name] = next;
  else delete all[name];
  writeAll(all);
}

export const getGrant = (name: string): Grant | null => readAll()[name] ?? null;
export const listGrants = (): Grant[] => Object.values(readAll());

/** A grant the host can call with right now. */
export function isLive(name: string): boolean {
  const g = getGrant(name);
  if (!g || g.needsLogin) return false;
  if (g.auth === 'bearer') return !!g.header?.value;
  return !!(g.tokens && (g.tokens.access_token || g.tokens.refresh_token));
}

/** Is this name held by the host (live or not)? Then no engine should hold it. */
export const isHostHeld = (name: string): boolean => !!getGrant(name);

/** Grants a session acting as `owner` may use: its own, then the shared ones. */
export function grantsFor(owner: string): Grant[] {
  const all = listGrants().filter((g) => isLive(g.name));
  const bySlug = new Map<string, Grant>();
  for (const g of all) if (g.owner === 'global') bySlug.set(g.slug, g);
  if (owner !== 'global') for (const g of all) if (g.owner === owner) bySlug.set(g.slug, g);
  return [...bySlug.values()];
}

export function remove(name: string): boolean {
  const had = !!getGrant(name);
  patch(name, () => null);
  dropClient(name);
  return had;
}

/** bearer: store the header the vendor wants (GitHub: `Authorization: Bearer <token>`). */
export function saveBearer(g: { name: string; slug: string; owner: string; url: string }, header: { name: string; value: string }): void {
  const all = readAll();
  all[g.name] = { ...g, auth: 'bearer', at: new Date().toISOString(), header };
  writeAll(all);
  dropClient(g.name);
}

// ---- OAuth -----------------------------------------------------------------------

/** One open sign-in, keyed by its `state` (the only thing the callback carries). */
interface Flow {
  name: string;
  state: string;
  status: 'awaiting' | 'done' | 'error';
  url: string | null;
  error: string | null;
  at: number;
}
const flows = new Map<string, Flow>(); // by state
const FLOW_MS = 15 * 60_000;
const flowOf = (name: string): Flow | null => {
  let best: Flow | null = null;
  for (const f of flows.values()) if (f.name === name && (!best || f.at > best.at)) best = f;
  return best;
};
function sweepFlows(): void {
  for (const [k, f] of flows) if (Date.now() - f.at > FLOW_MS) flows.delete(k);
}

class HostProvider {
  constructor(
    private name: string,
    private redirect: string,
    private flow: Flow | null = null
  ) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata() {
    return {
      client_name: 'Arigami',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as any;
  }
  state() {
    return this.flow?.state || randomBytes(16).toString('hex');
  }
  clientInformation() {
    const g = getGrant(this.name);
    return g?.client && g.redirect === this.redirect ? (g.client as any) : undefined;
  }
  saveClientInformation(info: any) {
    patch(this.name, (g) => ({ ...g, client: info, redirect: this.redirect }));
  }
  tokens() {
    return getGrant(this.name)?.tokens as any;
  }
  saveTokens(tokens: any) {
    patch(this.name, (g) => ({ ...g, tokens, needsLogin: false, verifier: undefined, at: new Date().toISOString() }));
  }
  redirectToAuthorization(url: URL) {
    if (this.flow) this.flow.url = url.toString();
    // Outside a sign-in (a live client whose refresh was refused) this means a
    // person has to sign in again; the call fails and says so.
    else patch(this.name, (g) => ({ ...g, needsLogin: true }));
  }
  saveCodeVerifier(v: string) {
    patch(this.name, (g) => ({ ...g, verifier: v }));
  }
  codeVerifier() {
    const v = getGrant(this.name)?.verifier;
    if (!v) throw new Error('no sign-in in progress');
    return v;
  }
  saveDiscoveryState(d: any) {
    patch(this.name, (g) => ({ ...g, discovery: d }));
  }
  discoveryState() {
    return getGrant(this.name)?.discovery as any;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    patch(this.name, (g) => {
      const n = { ...g };
      if (scope === 'all' || scope === 'client') delete n.client;
      if (scope === 'all' || scope === 'tokens') delete n.tokens;
      if (scope === 'all' || scope === 'verifier') delete n.verifier;
      if (scope === 'all' || scope === 'discovery') delete n.discovery;
      return n;
    });
  }
}

export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Start a sign-in. Returns the vendor's authorize URL for a person to open;
 * `status:'done'` when the grant was still good and nothing had to be asked.
 */
export async function startLogin(
  g: { name: string; slug: string; owner: string; url: string },
  redirect: string,
  opts: { fetchFn?: FetchFn } = {}
): Promise<{ status: Flow['status']; url: string | null; error: string | null }> {
  sweepFlows();
  const all = readAll();
  const prev = all[g.name];
  // A new sign-in starts from no tokens; a client registered for this same
  // redirect is kept (re-registering on every login would litter the vendor).
  all[g.name] = { ...g, auth: 'oauth', at: new Date().toISOString(), ...(prev?.redirect === redirect && prev?.client ? { client: prev.client, redirect } : {}) };
  writeAll(all);
  dropClient(g.name);
  for (const [k, f] of flows) if (f.name === g.name) flows.delete(k);
  const flow: Flow = { name: g.name, state: randomBytes(24).toString('hex'), status: 'awaiting', url: null, error: null, at: Date.now() };
  flows.set(flow.state, flow);
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
  try {
    const r = await auth(new HostProvider(g.name, redirect, flow) as any, { serverUrl: g.url, ...(opts.fetchFn ? { fetchFn: opts.fetchFn as any } : {}) });
    if (r === 'AUTHORIZED') flow.status = 'done';
  } catch (e) {
    flow.status = 'error';
    flow.error = (e as Error).message;
  }
  return { status: flow.status, url: flow.url, error: flow.error };
}

/** The vendor redirected back: exchange the code. Unknown or stale state → refused. */
export async function finishLogin(state: string, code: string, opts: { fetchFn?: FetchFn } = {}): Promise<{ ok: boolean; name: string | null; error?: string }> {
  sweepFlows();
  const flow = flows.get(state);
  if (!flow) return { ok: false, name: null, error: 'this sign-in is unknown or expired — start it again' };
  if (flow.status === 'done') return { ok: true, name: flow.name };
  const g = getGrant(flow.name);
  if (!g?.redirect) return { ok: false, name: flow.name, error: 'no sign-in in progress' };
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
  try {
    const r = await auth(new HostProvider(flow.name, g.redirect, flow) as any, { serverUrl: g.url, authorizationCode: code, ...(opts.fetchFn ? { fetchFn: opts.fetchFn as any } : {}) });
    if (r !== 'AUTHORIZED') throw new Error('the vendor did not issue a token');
    flow.status = 'done';
    dropClient(flow.name);
    return { ok: true, name: flow.name };
  } catch (e) {
    flow.status = 'error';
    flow.error = (e as Error).message;
    return { ok: false, name: flow.name, error: flow.error };
  }
}

/** A person pasted the URL their browser landed on (the redirect could not reach the host). */
export async function finishFromPaste(name: string, pasted: string, opts: { fetchFn?: FetchFn } = {}): Promise<{ ok: boolean; error?: string }> {
  let code = '';
  let state = '';
  try {
    const u = new URL(pasted.trim());
    code = u.searchParams.get('code') || '';
    state = u.searchParams.get('state') || '';
  } catch {
    return { ok: false, error: 'paste the whole address the browser ended on (it contains ?code=…&state=…)' };
  }
  const flow = flows.get(state);
  if (!code || !flow || flow.name !== name) return { ok: false, error: 'that address does not belong to this sign-in — start it again' };
  const r = await finishLogin(state, code, opts);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export function loginStatus(name: string): { status: Flow['status'] | 'none'; url: string | null; error: string | null } {
  if (isLive(name) && (!flowOf(name) || flowOf(name)!.status !== 'error')) return { status: 'done', url: null, error: null };
  const f = flowOf(name);
  return f ? { status: f.status, url: f.url, error: f.error } : { status: 'none', url: null, error: null };
}

export function cancelLogin(name: string): void {
  for (const [k, f] of flows) if (f.name === name) flows.delete(k);
}

// ---- the one live client per grant ----------------------------------------------

type McpClient = import('@modelcontextprotocol/sdk/client/index.js').Client;
const clients = new Map<string, Promise<McpClient>>();

export function dropClient(name: string): void {
  const p = clients.get(name);
  clients.delete(name);
  p?.then((c) => c.close()).catch(() => {});
}

/** The host's client for this grant (refreshes its token as needed). */
export async function clientFor(name: string): Promise<McpClient> {
  const have = clients.get(name);
  if (have) return have;
  const g = getGrant(name);
  if (!g || !isLive(name)) throw new Error(`${name} is not connected — a person has to sign in again (Settings › Connections)`);
  const made = (async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(g.url), {
      ...(g.auth === 'oauth' ? { authProvider: new HostProvider(name, g.redirect || '') as any } : {}),
      ...(g.auth === 'bearer' && g.header ? { requestInit: { headers: { [g.header.name]: g.header.value } } } : {}),
    });
    const client = new Client({ name: 'arigami', version: '0.1.0' }, { capabilities: {} });
    transport.onclose = () => clients.delete(name);
    await client.connect(transport);
    return client;
  })();
  clients.set(name, made);
  made.catch(() => clients.delete(name));
  return made;
}

/** Call one tool through the host's client; a dropped connection is retried once. */
export async function callTool(name: string, tool: string, args: Record<string, unknown>): Promise<any> {
  try {
    return await (await clientFor(name)).callTool({ name: tool, arguments: args || {} });
  } catch (e) {
    if (getGrant(name)?.needsLogin) throw e;
    dropClient(name);
    return await (await clientFor(name)).callTool({ name: tool, arguments: args || {} });
  }
}

/** Close every client (host shutdown, tests). */
export async function closeAll(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => {})));
}
