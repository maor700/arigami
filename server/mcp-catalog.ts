// M1 — the catalog of NATIVE remote MCP servers (RESEARCH-ARIGAMI-NATIVE-MCP §2/§4.1).
//
// Data only: every row is a vendor-hosted MCP endpoint Claude Code can talk to
// directly, so the token lives in the host's own `.credentials.json` and the
// calls go to the vendor — no broker in the middle. Adding a service is a row
// here plus two i18n strings; there is no per-service code anywhere.
//
// `auth`:
//   oauth             OAuth 2.1 with DCR/CIMD — `claude mcp login <name>` and the
//                     vendor's own consent screen. No client registration needed.
//   bearer            a token the host already owns (GitHub: `gh auth token`) or
//                     the human pastes; added with `claude mcp add-json … headers`.
//   oauth-byo-client  OAuth without DCR — needs OUR OWN client id/secret
//                     (Asana, Slack's own server). Listed, not connectable yet.
//
// Grant naming (§4.3 option A, verified in the M1 spike): the SERVER NAME is the
// identity of an OAuth grant — same URL under a different name is a separate
// grant, and a `--mcp-config` injection only reuses a credential when the name
// matches. So an agent-owned connection is `<slug>--<agent>` and its tools are
// `mcp__<slug>--<agent>__*`.

export type McpAuth = 'oauth' | 'bearer' | 'oauth-byo-client';

export interface McpServerSpec {
  /** catalog slug — capability id is `mcp:<slug>`, grant name starts with it. No `--`. */
  slug: string;
  title: string;
  url: string;
  /** A read-only variant of the same server, when the vendor ships one. */
  readonlyUrl?: string;
  auth: McpAuth;
  /** Hosts the connect-mcp playbook may open (plus `localhost` for the callback). */
  domains: string[];
  docs: string;
  /** bearer: the host can mint the token itself instead of asking the human. */
  tokenFrom?: 'gh';
  /** bearer: how the token is sent (default `Authorization: Bearer <token>`). */
  headerName?: string;
  headerPrefix?: string;
  /** Short, factual caveat shown on the card (plan gating, preview status…). */
  note?: string;
}

/** No `--` in a slug: it is the separator between service and owning agent. */
export const MCP_SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,38}[a-z0-9]$/;

export const MCP_CATALOG: McpServerSpec[] = [
  {
    slug: 'linear',
    title: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    readonlyUrl: 'https://mcp.linear.app/mcp/readonly',
    auth: 'oauth',
    domains: ['linear.app', 'mcp.linear.app'],
    docs: 'https://linear.app/docs/mcp',
  },
  {
    slug: 'notion',
    title: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    domains: ['notion.com', 'notion.so', 'mcp.notion.com'],
    docs: 'https://developers.notion.com/docs/mcp',
  },
  {
    slug: 'sentry',
    title: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    domains: ['sentry.io', 'sentry.dev', 'mcp.sentry.dev'],
    docs: 'https://mcp.sentry.dev/',
  },
  {
    slug: 'vercel',
    title: 'Vercel',
    url: 'https://mcp.vercel.com',
    auth: 'oauth',
    domains: ['vercel.com', 'mcp.vercel.com'],
    docs: 'https://vercel.com/docs/agent-resources/vercel-mcp',
  },
  {
    slug: 'stripe',
    title: 'Stripe',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
    domains: ['stripe.com', 'mcp.stripe.com'],
    docs: 'https://docs.stripe.com/mcp',
  },
  {
    slug: 'figma',
    title: 'Figma',
    url: 'https://mcp.figma.com/mcp',
    auth: 'oauth',
    domains: ['figma.com', 'mcp.figma.com'],
    docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    note: 'read-tool quota per seat (Dev/Full: 200/day)',
  },
  {
    slug: 'cloudflare',
    title: 'Cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    auth: 'oauth',
    domains: ['cloudflare.com', 'mcp.cloudflare.com'],
    docs: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    note: 'some product servers need paid Workers',
  },
  {
    slug: 'supabase',
    title: 'Supabase',
    url: 'https://mcp.supabase.com/mcp',
    readonlyUrl: 'https://mcp.supabase.com/mcp?read_only=true',
    auth: 'oauth',
    domains: ['supabase.com', 'mcp.supabase.com'],
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    note: 'branching tools need a paid project',
  },
  {
    slug: 'atlassian',
    title: 'Atlassian (Jira / Confluence)',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    auth: 'oauth',
    domains: ['atlassian.com', 'mcp.atlassian.com', 'id.atlassian.com'],
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
  {
    slug: 'github',
    title: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    readonlyUrl: 'https://api.githubcopilot.com/mcp/readonly',
    auth: 'bearer',
    tokenFrom: 'gh',
    domains: ['github.com', 'api.githubcopilot.com'],
    docs: 'https://docs.github.com/en/copilot/how-tos/context/use-mcp/use-the-github-mcp-server',
    note: 'token-based: the host reuses `gh auth token` (the git capability)',
  },
  {
    slug: 'asana',
    title: 'Asana',
    url: 'https://mcp.asana.com/v2/mcp',
    auth: 'oauth-byo-client',
    domains: ['asana.com', 'mcp.asana.com', 'app.asana.com'],
    docs: 'https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server',
    note: 'no DCR — needs an Asana app client id/secret of your own',
  },
];

// EXT — the catalog is LAYERED, the same way skills.ts merges shipped ∪ user:
// core rows here, plus validated rows from $ARIGAMI_DIR/user/mcp-catalog.json.
// A user row can add a service (its capability id, its `domains` allowlist and
// its setup card) with no PR to the core; it can never SHADOW a core row, so a
// hand-edited file cannot silently repoint `linear` at another URL.
// Cached for a second and refreshed on an extensions reload — every consumer
// (mcpSpec, capabilities, the cockpit list) reads through here.
let userRows: McpServerSpec[] = [];
let userRowsAt = 0;
const USER_TTL_MS = 1_000;

function readUserRows(): McpServerSpec[] {
  if (Date.now() - userRowsAt < USER_TTL_MS) return userRows;
  userRowsAt = Date.now();
  try {
    const ext = require('./extensions.js') as typeof import('./extensions.js');
    const core = new Set(MCP_CATALOG.map((s) => s.slug));
    userRows = ext
      .readUserMcpCatalog()
      .filter((r) => !core.has(r.slug))
      .map((r) => ({ slug: r.slug, title: r.title, url: r.url, auth: r.auth, domains: r.domains, docs: r.docs || '', note: r.note }));
  } catch {
    userRows = [];
  }
  return userRows;
}

/** Drop the cache (called by the extensions loader after a reload). */
export function refreshUserCatalog(): void {
  userRowsAt = 0;
  readUserRows();
}

/** Core rows + the user's own rows. This is what every consumer should read. */
export const mcpCatalog = (): McpServerSpec[] => [...MCP_CATALOG, ...readUserRows()];

export const mcpSpec = (slug: string): McpServerSpec | null => {
  const s = String(slug || '').toLowerCase();
  return mcpCatalog().find((row) => row.slug === s) ?? null;
};
export const isMcpSlug = (slug: unknown): slug is string => typeof slug === 'string' && !!mcpSpec(slug);
/** Services a human can actually finish connecting from the cockpit today. */
export const connectableMcp = (): McpServerSpec[] => mcpCatalog().filter((s) => s.auth !== 'oauth-byo-client');

/**
 * The OAuth grant / MCP server name for a service and its owner.
 * 'global' → `linear`; 'agent:sales' → `linear--sales` (§4.3 option A).
 */
export function grantName(slug: string, owner: string = 'global'): string {
  const s = String(slug || '').toLowerCase();
  const agent = /^agent:([a-z0-9][a-z0-9-]{0,39})$/.exec(String(owner || 'global'))?.[1];
  return agent ? `${s}--${agent}` : s;
}

/** Inverse of grantName: `linear--sales` → {slug:'linear', agent:'sales'}. */
export function parseGrantName(name: string): { slug: string; agent: string | null } {
  const i = String(name || '').indexOf('--');
  return i < 0 ? { slug: String(name || ''), agent: null } : { slug: name.slice(0, i), agent: name.slice(i + 2) || null };
}

/** The tool-name pattern an A3 allowlist needs for this grant. */
export const grantToolPattern = (name: string): string => `mcp__${name}__*`;

/** The `--mcp-config` entry for a grant (the NAME must equal the grant name — spike §4.5). */
export function mcpConfigEntry(spec: McpServerSpec, url?: string): { type: 'http'; url: string } {
  return { type: 'http', url: url || spec.url };
}
