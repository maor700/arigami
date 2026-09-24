// Composio as a gateway MCP server (/__mcp/s/composio-mcp), served by the host.
//
// Before: sessions reached Composio through a `composio-mcp` stdio server the
// user had to install by hand into ~/.claude.json — so a Composio sign-in in
// Settings reached no session at all where that server was missing, and each
// session that had it ran its own copy.
//
// Now the host holds the Composio key (Settings › Connections), and every
// session of every engine gets the same server over the gateway:
//
//   tools   the tools of the toolkits connected for THIS session's owner —
//           the agent's own connected account first, else the host's shared one
//           (A2's rule, the same one capabilities.ts reports). Another agent's
//           account is never used.
//   names   Composio's tool slugs, under the server name `composio-mcp` — the
//           `mcp__composio-mcp__GMAIL_*` names agent allowlists already use.
//   send    a tool that sends to a person (GMAIL_SEND_EMAIL, SLACK_SEND_MESSAGE,
//           a calendar invite…) files an outbound card; the host runs it with
//           the stored arguments only after the owner presses Send.
import { cfg } from '../state.js';
import { composioOwnerOf, GLOBAL_OWNER, type Owner } from '../capabilities.js';
import { isOutbound, type OutboundExec } from './outbound.js';

// ARIGAMI_COMPOSIO_BASE: tests point the host at a stub.
const BASE = process.env.ARIGAMI_COMPOSIO_BASE || 'https://backend.composio.dev/api/v3.1';

/**
 * Tools that reach a person without their name saying so. A calendar event
 * with attendees emails every attendee; a share notifies the grantee.
 */
export const COMPOSIO_SENDERS = [
  'GOOGLECALENDAR_CREATE_EVENT',
  'GOOGLECALENDAR_UPDATE_EVENT',
  'GOOGLECALENDAR_PATCH_EVENT',
  'GOOGLECALENDAR_QUICK_ADD',
  'GOOGLECALENDAR_REMOVE_ATTENDEE',
  'GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE',
];

export const composioKey = (): string => cfg.composioApiKey || process.env.COMPOSIO_API_KEY || '';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (input, init) => fetch(input, init);
/** Tests: route Composio's API to a stub. */
export function _setFetch(f: Fetch | null): void {
  fetchImpl = f || ((input, init) => fetch(input, init));
  accountsCache = null;
  toolsCache.clear();
}

async function api(p: string, init: RequestInit = {}): Promise<any> {
  const key = composioKey();
  if (!key) throw new Error('Composio is not connected — sign in under Settings › Connections');
  const r = await fetchImpl(BASE + p, {
    ...init,
    headers: { 'x-api-key': key, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(j?.error?.message || j?.message || `Composio ${r.status}`);
  return j;
}

// ---- connected accounts ----------------------------------------------------------

export interface Account {
  id: string;
  toolkit: string;
  userId: string;
  owner: Owner;
}

const ACCOUNTS_MS = 30_000;
let accountsCache: { at: number; list: Account[] } | null = null;

async function activeAccounts(): Promise<Account[]> {
  if (accountsCache && Date.now() - accountsCache.at < ACCOUNTS_MS) return accountsCache.list;
  const out: Account[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const j = await api(`/connected_accounts?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const c of j.items || []) {
      if (c.status && c.status !== 'ACTIVE') continue;
      const toolkit = String(c.toolkit?.slug || '').toLowerCase();
      if (!toolkit || !c.id) continue;
      out.push({ id: String(c.id), toolkit, userId: String(c.user_id ?? c.entity_id ?? 'default'), owner: composioOwnerOf(c) });
    }
    cursor = j.next_cursor || '';
    if (!cursor) break;
  }
  accountsCache = { at: Date.now(), list: out };
  return out;
}

/** toolkit → the account this owner acts through: its own first, else the shared one. */
export async function accountsFor(owner: Owner): Promise<Map<string, Account>> {
  const map = new Map<string, Account>();
  const all = await activeAccounts();
  for (const a of all) if (a.owner === GLOBAL_OWNER && !map.has(a.toolkit)) map.set(a.toolkit, a);
  if (owner !== GLOBAL_OWNER) for (const a of all) if (a.owner === owner) map.set(a.toolkit, a);
  return map;
}

// ---- tools -----------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS_MS = 30 * 60_000;
const toolsCache = new Map<string, { at: number; tools: ToolDef[] }>();

async function toolkitTools(toolkit: string): Promise<ToolDef[]> {
  const have = toolsCache.get(toolkit);
  if (have && Date.now() - have.at < TOOLS_MS) return have.tools;
  const tools: ToolDef[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const j = await api(`/tools?toolkit_slug=${encodeURIComponent(toolkit)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const t of j.items || []) {
      if (!t?.slug) continue;
      const schema = t.input_parameters && typeof t.input_parameters === 'object' ? t.input_parameters : {};
      tools.push({ name: String(t.slug), description: String(t.description || t.name || t.slug).slice(0, 1024), inputSchema: { type: 'object', ...schema } });
    }
    cursor = j.next_cursor || '';
    if (!cursor) break;
  }
  toolsCache.set(toolkit, { at: Date.now(), tools });
  return tools;
}

/** Every tool this owner can call, each with the account it runs under. */
export async function toolsFor(owner: Owner): Promise<{ tools: ToolDef[]; accountOf: Map<string, Account> }> {
  const accounts = await accountsFor(owner);
  const tools: ToolDef[] = [];
  const accountOf = new Map<string, Account>();
  for (const [toolkit, account] of accounts) {
    let list: ToolDef[] = [];
    try {
      list = await toolkitTools(toolkit);
    } catch {
      continue; // one toolkit's listing failing must not hide the others
    }
    for (const t of list) {
      tools.push(t);
      accountOf.set(t.name, account);
    }
  }
  return { tools, accountOf };
}

export const isComposioSender = (tool: string): boolean => isOutbound(tool, COMPOSIO_SENDERS);

/** Run one tool under one connected account. */
export async function execute(tool: string, args: Record<string, unknown>, account: { id: string; userId: string }): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const j = await api(`/tools/execute/${encodeURIComponent(tool)}`, {
      method: 'POST',
      body: JSON.stringify({ connected_account_id: account.id, user_id: account.userId, arguments: args || {} }),
    });
    if (j?.successful === false) return { ok: false, error: String(j?.error?.message || j?.error || 'Composio tool failed') };
    return { ok: true, result: j?.data ?? j };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- the MCP server --------------------------------------------------------------

export type FileOutbound = (sessionId: string, exec: OutboundExec, why?: string) => Promise<unknown>;

const reply = (v: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }], ...(isError ? { isError: true } : {}) });

/** The `composio-mcp` server for one session. */
export async function createComposioServer(session: { id: string }, owner: Owner, fileOutbound: FileOutbound) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const server = new Server({ name: 'composio-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!composioKey()) return { tools: [] };
    const { tools } = await toolsFor(owner);
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const tool = String(req.params?.name || '');
    const args = req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {};
    let accountOf: Map<string, Account>;
    try {
      ({ accountOf } = await toolsFor(owner));
    } catch (e) {
      return reply(`Composio: ${(e as Error).message}`, true);
    }
    const account = accountOf.get(tool);
    if (!account) return reply(`Composio: no connected account for ${tool}. Ask the owner to connect its toolkit (request_setup), then try again.`, true);
    if (isComposioSender(tool)) {
      const exec: OutboundExec = { via: 'composio', tool, args, account: account.id, user: account.userId };
      return reply(await fileOutbound(session.id, exec));
    }
    const r = await execute(tool, args, account);
    return r.ok ? reply(r.result) : reply(`Composio: ${r.error}`, true);
  });
  return server;
}
