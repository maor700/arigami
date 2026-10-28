// RESUME — the session wire's second diet, and the reconnect cursor.
//
// A phone that comes back from the background reconnects the WebSocket and
// used to pull EVERY session twice (the `state` replay + a REST list, ~570KB
// each on a host with ~90 sessions, uncompressed). Two things fix that, both
// opt-in per client (`?wire=2`) so an old cockpit against a new host — and a new
// cockpit against an old host — keeps working on the old, full form:
//
// 1. slimHeavy(): the fields the rail never renders leave the list/broadcast
//    form (on top of toWireSession's caps/summary diet):
//      claude.capabilities.skills / .mcpServers → counts.skills / counts.mcpServers
//        (the Capabilities panel + Skills view fetch the full caps on demand)
//      claude.mcp.servers   → {sig, count}: McpAuth only uses it as a "re-read
//        the rows" key — the rows come from GET /sessions/:id/mcp
//      claude.mcpLoaded     → {at, count}: same, `at` is the key
//      changesExplanations  → changesExplained {mode: generatedAt}: the Changes
//        tab fetches the open session's explanations by that stamp
//    GET /__api/sessions/:id keeps returning the full session.
//
// 2. RevTracker: a monotonic revision over the session broadcasts. Every
//    broadcast that names a session bumps it and records "this session changed
//    at rev N" (a delete leaves a tombstone). A client that reconnects with the
//    last rev it saw (and the host's boot id — a restarted host starts over)
//    gets only the sessions that changed since, plus the ids that went away;
//    an unknown or too-old cursor gets the full snapshot, as before.

type AnyObj = Record<string, any>;

export const WIRE_V2 = 2;

function hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** A short signature of the MCP health map — changes whenever a row's status/time does. */
export function mcpSig(servers: AnyObj | undefined): string {
  if (!servers || typeof servers !== 'object') return '';
  const rows = Object.keys(servers)
    .sort()
    .map((k) => [k, servers[k]?.status ?? null, servers[k]?.at ?? null]);
  return hash(JSON.stringify(rows));
}

/** v2 list form of a (toWireSession'd) session. Identity when there is nothing to drop. */
export function slimHeavy<T extends AnyObj>(s: T): T {
  if (!s || typeof s !== 'object') return s;
  let out: AnyObj = s;
  const c = s.claude;
  if (c && typeof c === 'object') {
    let claude: AnyObj = c;
    const caps = c.capabilities;
    if (caps && typeof caps === 'object' && (Array.isArray(caps.skills) || Array.isArray(caps.mcpServers))) {
      const { skills, mcpServers, ...rest } = caps;
      const counts = { ...(caps.counts || {}) };
      if (Array.isArray(skills)) counts.skills = skills.length;
      if (Array.isArray(mcpServers)) counts.mcpServers = mcpServers.length;
      claude = { ...claude, capabilities: { ...rest, slim: true, counts } };
    }
    if (c.mcp && typeof c.mcp === 'object' && c.mcp.servers && typeof c.mcp.servers === 'object') {
      const { servers, ...rest } = c.mcp;
      claude = { ...claude, mcp: { ...rest, slim: true, sig: mcpSig(servers), count: Object.keys(servers).length } };
    }
    if (c.mcpLoaded && typeof c.mcpLoaded === 'object' && Array.isArray(c.mcpLoaded.servers)) {
      claude = { ...claude, mcpLoaded: { at: c.mcpLoaded.at, count: c.mcpLoaded.servers.length, slim: true } };
    }
    if (claude !== c) out = { ...out, claude };
  }
  if (s.changesExplanations && typeof s.changesExplanations === 'object') {
    const { changesExplanations, ...rest } = out;
    const stamps: Record<string, string> = {};
    for (const [mode, e] of Object.entries(changesExplanations as AnyObj)) if (e) stamps[mode] = String((e as AnyObj).generatedAt || '?');
    out = { ...rest, changesExplained: stamps };
  }
  return out as T;
}

/** v2 form of a bus message: an embedded session gets the diet; everything else is untouched. */
export function slimMessage(msg: AnyObj): AnyObj {
  if (!msg || typeof msg !== 'object') return msg;
  if (msg.session && typeof msg.session === 'object' && msg.session.id) {
    const session = slimHeavy(msg.session);
    return session === msg.session ? msg : { ...msg, session };
  }
  return msg;
}

/** The session a bus message is about (null for host-wide events). */
export function sessionIdOf(msg: AnyObj): string | null {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  const colon = msg.type.indexOf(':');
  if (colon > -1 && msg.type.length > colon + 1) return msg.type.slice(colon + 1);
  const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
  const id =
    msg.sessionId ?? msg.session_id ?? msg.session?.id ?? p?.sessionId ?? p?.session_id ?? p?.session?.id ??
    (msg.type === 'session-deleted' ? msg.id ?? (typeof msg.payload === 'string' ? msg.payload : p?.id) : null);
  return typeof id === 'string' && id ? id : null;
}

export type Since = { full: true } | { full: false; changed: string[]; deleted: string[] };

export class RevTracker {
  rev = 0;
  readonly boot: string;
  private changed = new Map<string, number>(); // sessionId → rev of its latest change
  private gone = new Map<string, number>(); // deleted sessionId → rev of the delete
  private floor = 0; // tombstones at or below this rev were forgotten
  constructor(boot?: string, private maxTombstones = 2000) {
    this.boot = boot || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Record a broadcast. Returns the rev it was stamped with, or null (not about a session). */
  note(msg: AnyObj): number | null {
    const id = sessionIdOf(msg);
    if (!id) return null;
    const rev = ++this.rev;
    if (msg.type === 'session-deleted') {
      this.changed.delete(id);
      this.gone.set(id, rev);
      if (this.gone.size > this.maxTombstones) {
        const [oldest, at] = this.gone.entries().next().value as [string, number];
        this.gone.delete(oldest);
        this.floor = Math.max(this.floor, at);
      }
    } else {
      this.gone.delete(id);
      this.changed.set(id, rev);
    }
    return rev;
  }

  /** What a client that last saw `rev` on host boot `boot` is missing. */
  since(rev: unknown, boot: unknown): Since {
    const r = typeof rev === 'string' ? Number(rev) : rev;
    if (boot !== this.boot || typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > this.rev || r < this.floor)
      return { full: true };
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const [id, at] of this.changed) if (at > r) changed.push(id);
    for (const [id, at] of this.gone) if (at > r) deleted.push(id);
    return { full: false, changed, deleted };
  }
}
