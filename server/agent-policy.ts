// A3 — host-ENFORCED tool / domain allowlist per agent (PRD-ARIGAMI-AGENTS §3 A3).
//
// `agent.json.tools` is an allowlist. Entries may be:
//   - a FAMILY id (the A1 checkboxes: desktop, whatsapp, gmail, calendar, drive,
//     git, sessions, triggers, web) — expanded to concrete names below;
//   - a host MCP tool name (`open_tab`, `mcp__arigami__open_tab`);
//   - an external MCP pattern (`mcp__composio-mcp__*`, `mcp__composio-mcp__GMAIL_*`,
//     `mcp__whatsapp`);
//   - a Claude Code built-in (`Bash`, `Edit`, `WebFetch`, …).
// No `tools` (or an empty list) = unrestricted (A1 behaviour). With a list, the
// CORE cockpit tools and the read-only built-ins stay available always — an
// agent that cannot set its own title or read a file is not useful.
//
// Enforcement (all in the host, none in the prompt):
//   1. `--disallowedTools` at spawn (claude.js): restricted built-ins that are not
//      allowed + whole external MCP servers no pattern reaches. Real: the CLI
//      never offers them.
//   2. A PreToolUse hook (`--settings` → mcp/policy-hook.js) that asks
//      `POST /__api/sessions/:id/policy/check` before EVERY tool call — covers
//      partial external-server allowlists and the WebFetch domain allowlist.
//      Exit 2 blocks the call and the reason is fed back to the model.
//   3. The host MCP (mcp/host-mcp.js) hides disallowed arigami tools from
//      tools/list and refuses them on tools/call (`GET /__api/sessions/:id/policy`).
//   4. `open_tab` (POST /__api/sessions/:id/tabs) refuses URLs outside `domains`.
//
// What CANNOT be enforced by the host and is only documented: pages the agent
// reaches by driving Chrome on the desktop (xdotool), `curl` inside Bash, and
// tool calls made by MCP servers on their own behalf. `domains` therefore
// restricts open_tab + WebFetch; Bash/desktop stay under the agent's `tools`.
import { getAgent, type AgentView } from './agents.js';
import { appendActivity } from './agent-ledger.js';

export interface Policy {
  slug: string;
  /** null = unrestricted */
  tools: string[] | null;
  /** null = unrestricted */
  domains: string[] | null;
  autoApprove: string[];
}

export const HOST_SERVER = 'arigami';

/** A1 tool FAMILIES (the checkboxes) → concrete tool names / patterns. */
export const FAMILIES: Record<string, string[]> = {
  desktop: ['open_tab', 'update_tab', 'close_tab', 'activate_tab', 'capture_screen', 'request_screen', 'save_browser_logins'],
  whatsapp: ['whatsapp', 'mcp__whatsapp__*', 'mcp__composio-mcp__WHATSAPP_*'],
  gmail: ['mcp__composio-mcp__GMAIL_*'],
  calendar: ['mcp__composio-mcp__GOOGLECALENDAR_*'],
  drive: ['mcp__composio-mcp__GOOGLEDRIVE_*'],
  git: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'merge_session', 'set_changes_explanation'],
  sessions: ['create_session', 'task_session', 'delete_session', 'restart_session', 'list_sessions', 'merge_session', 'report_to_master', 'host_restart'],
  triggers: ['cronjob', 'register_listener', 'list_listeners', 'cancel_listener'],
  web: ['WebFetch', 'WebSearch'],
};
export const FAMILY_IDS = Object.keys(FAMILIES);

/** Built-ins an allowlist can take away. Everything else built-in (Read, Glob, Grep, …) is always on. */
export const RESTRICTED_BUILTINS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];

/** Host tools every session keeps regardless of the allowlist (cockpit plumbing + asking the human). */
export const CORE_TOOLS = [
  'set_title', 'set_color', 'set_status', 'set_metadata', 'set_progress', 'set_status_summary', 'allocate_port',
  'publish_artifact', 'share_artifact', 'unshare_artifact',
  'request_action', 'request_review', 'request_setup', 'report_setup', 'check_setup',
  'memory_write', 'memory_search', 'memory_get', 'skill_propose',
  'list_agents', 'permission_prompt', 'report_to_master',
];

const HOST_PREFIX = `mcp__${HOST_SERVER}__`;

/** `mcp__arigami__open_tab` → `open_tab`; anything else unchanged. */
export const shortHostName = (name: string): string => (name.startsWith(HOST_PREFIX) ? name.slice(HOST_PREFIX.length) : name);

// Claude Code built-ins are PascalCase (Bash, Read, WebFetch, Agent…); host tools
// are snake_case (open_tab, create_session) and external ones are mcp__… .
const isBuiltin = (name: string): boolean => /^[A-Z]/.test(name);
const serverOf = (name: string): string | null => {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  return i < 0 ? rest : rest.slice(0, i);
};

function globToRe(pat: string): RegExp {
  return new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

/** Expand families and normalise host names so matching is uniform. */
export function expandTools(list: string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (FAMILIES[t]) for (const x of FAMILIES[t]) out.add(x);
    else out.add(shortHostName(t));
  }
  return [...out];
}

export function policyFor(slug: string | null | undefined): Policy | null {
  if (!slug) return null;
  const a = getAgent(String(slug));
  if (!a) return null;
  return policyOf(a);
}

export function policyOf(a: AgentView): Policy {
  const tools = a.tools?.length ? expandTools(a.tools) : null;
  const domains = a.domains?.length ? a.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : null;
  return { slug: a.slug, tools, domains, autoApprove: a.autoApprove || [] };
}

/** Is this policy actually restricting anything? (no → skip the hook/flags) */
export const isRestrictive = (p: Policy | null): p is Policy => !!p && (p.tools !== null || p.domains !== null);

/** One pattern vs one (normalised) tool name. */
function matchTool(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.includes('*')) return globToRe(pattern).test(name);
  // `mcp__server` = the whole server
  if (pattern.startsWith('mcp__') && !pattern.slice(5).includes('__') && name.startsWith(pattern + '__')) return true;
  return false;
}

/** Tool allowed under the policy? Host tools may be given long or short; built-ins by name. */
export function toolAllowed(p: Policy | null, toolName: string): boolean {
  if (!p || p.tools === null) return true;
  const name = shortHostName(String(toolName || ''));
  if (!name) return true;
  if (CORE_TOOLS.includes(name)) return true;
  if (isBuiltin(name) && !RESTRICTED_BUILTINS.includes(name)) return true;
  return p.tools.some((pat) => matchTool(pat, name) || matchTool(pat, toolName));
}

/** Does any allowlist entry reach into `server` (so it must NOT be denied wholesale)? */
export function serverTouched(p: Policy, server: string): boolean {
  if (server === HOST_SERVER) return true;
  return p.tools!.some((pat) => serverOf(pat) === server || (pat.startsWith('mcp__') && pat.includes('*') && globToRe(pat).test(`mcp__${server}__x`)));
}

/**
 * The `--disallowedTools` list for a spawn: restricted built-ins the agent may not
 * use, plus whole external MCP servers (`mcp__<server>`) no allowlist entry touches.
 * `servers` = the MCP server names the session will see (from the last init /
 * `claude mcp list`); unknown servers are caught by the hook instead.
 */
export function disallowedToolsFor(p: Policy | null, servers: string[] = []): string[] {
  if (!p || p.tools === null) return [];
  const out: string[] = [];
  for (const b of RESTRICTED_BUILTINS) if (!toolAllowed(p, b)) out.push(b);
  for (const sv of new Set(servers)) if (sv && sv !== HOST_SERVER && !serverTouched(p, sv)) out.push(`mcp__${sv}`);
  return out;
}

// ---- domains ---------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/** Hostname of a URL-ish string, '' for relative paths / garbage. */
export function hostOf(url: string): string {
  const u = String(url || '').trim();
  if (!u || u.startsWith('/')) return '';
  try {
    return new URL(u.includes('://') ? u : `https://${u}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** `example.com` matches itself and any subdomain; `*.example.com` only subdomains; `*` everything. */
export function domainMatches(pattern: string, host: string): boolean {
  const p = String(pattern || '').trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host !== p.slice(2);
  return host === p || host.endsWith('.' + p);
}

/** Relative paths and loopback (dev servers, the cockpit's own routes) are always allowed. */
export function domainAllowed(p: Policy | null, url: string): boolean {
  if (!p || p.domains === null) return true;
  const host = hostOf(url);
  if (!host || LOCAL_HOSTS.has(host)) return true;
  return p.domains.some((d) => domainMatches(d, host));
}

// ---- the check every layer calls ------------------------------------------

export interface Verdict {
  allow: boolean;
  reason?: string;
}

const urlOf = (input: unknown): string => {
  const i = (input || {}) as Record<string, unknown>;
  return String(i.url || i.URL || '');
};

/**
 * One verdict for a tool call under an agent's policy. Domain checks apply to
 * WebFetch and open_tab (the URL-carrying tools the host can see). A denial is
 * written to the agent's activity ledger (kind 'policy') when `sessionId` is given.
 */
export function checkToolCall(p: Policy | null, toolName: string, input: unknown, sessionId?: string): Verdict {
  if (!p) return { allow: true };
  const name = shortHostName(String(toolName || ''));
  let reason: string | undefined;
  if (!toolAllowed(p, toolName)) {
    reason = `tool "${name}" is not in agent ${p.slug}'s allowlist (${(p.tools || []).join(', ')}) — ask the human (request_action) instead of working around it`;
  } else if ((name === 'WebFetch' || name === 'open_tab') && !domainAllowed(p, urlOf(input))) {
    reason = `domain "${hostOf(urlOf(input))}" is not in agent ${p.slug}'s allowed domains (${(p.domains || []).join(', ')})`;
  }
  if (!reason) return { allow: true };
  if (sessionId) appendActivity(p.slug, { kind: 'policy', sessionId, detail: `denied ${name}`, reason });
  return { allow: false, reason };
}

/** The `--settings` JSON that installs the PreToolUse hook (claude.js). */
export function hookSettings(hookCmd: string): string {
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, timeout: 20 }] }] },
  });
}
