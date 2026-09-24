// What MCP servers a session REALLY has, and how each one is doing — the one
// answer the session's /mcp panel renders.
//
// Before, the panel merged three sources that each answer a different
// question: the daemon's `claude mcp list` (the CLI's own servers under the
// daemon's login), a per-session probe (the same CLI, under the session's
// account), and the engine's init snapshot. Since the host serves most servers
// itself (the MCP gateway) that gave wrong answers both ways: a Linear the host
// holds read "Needs authentication" because the CLI's stale twin did, and a
// Codex session listed Sentry and Figma as connected because CLAUDE had them —
// Codex never loaded them at all.
//
// Now the truth is what the engine was spawned with (recordSpawn, called by
// claude.js / codex.ts with the exact server set they passed), and each row's
// status comes from the thing that actually serves it:
//
//   via 'gateway'      the host itself: arigami and extensions are up with the
//                      host; Composio needs its key; a remote grant is live
//                      when the host holds a usable token (mcp-grants.ts)
//   via 'cli'          a server Claude Code loads from its own config: the
//                      engine's init report, the probe, live tool traffic
//   via 'codex-grant'  a grant Codex holds (`codex mcp login`)
//   via 'stdio'        a hand-installed server the engine starts itself
//
// A failed live tool call (source 'traffic') overrides any of these: it is the
// strongest evidence there is that a server is down right now.
import { getSession, setClaude } from '../state.js';

export type Via = 'gateway' | 'cli' | 'codex-grant' | 'stdio';
export type Kind = 'arigami' | 'extension' | 'composio' | 'grant' | 'server';

export interface Loaded {
  name: string;
  via: Via;
  kind: Kind;
}

export interface Row {
  name: string;
  via: Via;
  kind: Kind;
  status: 'connected' | 'needs-auth' | 'needs-reconnect' | 'pending' | 'degraded' | 'failed' | 'unknown';
  statusText: string;
  /** What a person can do from the panel. `host` = the host's own sign-in / disconnect. */
  login?: 'host' | 'cli';
  logout?: 'host' | 'cli';
}

/** Classify one spawn entry (a --mcp-config / config.toml server). */
export function classify(name: string, sv: any, gatewayPrefix = '/__mcp/s/'): Loaded {
  const url = typeof sv?.url === 'string' ? sv.url : '';
  const kind: Kind = name === 'arigami' ? 'arigami' : name.startsWith('ext-') ? 'extension' : name === 'composio-mcp' ? 'composio' : url ? 'grant' : 'server';
  if (url.includes(gatewayPrefix)) return { name, via: 'gateway', kind };
  if (url) return { name, via: sv?.codexGrant ? 'codex-grant' : 'cli', kind: 'grant' };
  return { name, via: 'stdio', kind };
}

/** The engine was spawned with exactly these servers. */
export function recordSpawn(sessionId: string, servers: Loaded[]): void {
  if (!getSession(sessionId)) return;
  setClaude(sessionId, { mcpLoaded: { at: Date.now(), servers } } as any);
}

export interface Facts {
  engine: 'claude' | 'codex';
  loaded: Loaded[] | null;
  /** session.claude.mcp.servers — init / probe / traffic / engine verdicts */
  health: Record<string, { status?: string; statusText?: string; source?: string; at?: number }>;
  /** the engine's own init report (claude: name, status, source user|project|local|dynamic|claudeai…) */
  snapshot: Array<{ name: string; status?: string; source?: string }>;
  hostGrant: (name: string) => { live: boolean } | null;
  composioKey: boolean;
  extensionLoaded: (name: string) => boolean;
  codexGrantLive: (name: string) => boolean;
  /** a catalog service the host can sign in to itself (gateway on) */
  hostCanLogin: (name: string) => boolean;
  /** Claude Code's own config still registers this name (it blocks the host's entry) */
  cliTwin?: (name: string) => boolean;
}

const statusOf = (s: string | undefined): Row['status'] => {
  const v = String(s || '').toLowerCase();
  if (v === 'connected' || v === 'ready') return 'connected';
  if (v === 'needs-auth' || v === 'needs_auth' || v === 'authenticationrequired') return 'needs-auth';
  if (v === 'needs-reconnect') return 'needs-reconnect';
  if (v === 'pending' || v === 'starting') return 'pending';
  if (v === 'degraded') return 'degraded';
  if (v === 'failed' || v === 'error' || v === 'cancelled') return 'failed';
  return 'unknown';
};

/** Pure: the rows for one session. */
export function rows(f: Facts): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  const traffic = (name: string) => {
    const h = f.health[name];
    return h?.source === 'traffic' && h.status === 'degraded' ? h : null;
  };
  const push = (r: Row) => {
    const t = traffic(r.name);
    if (t && r.status === 'connected') {
      r.status = 'degraded';
      r.statusText = t.statusText || 'a tool call just failed';
    }
    out.push(r);
    seen.add(r.name);
  };

  // The engine's own word on a server it was handed: a gateway entry the engine
  // reports as not connected is NOT available to this session, whatever the
  // host's side says — unless a live tool call has since proved otherwise.
  const engineRefused = (name: string): string | null => {
    const h = f.health[name];
    if (h?.source === 'traffic' && h.status === 'connected') return null;
    const snap = f.snapshot.find((x) => x.name === name);
    const v = h && (h.source === 'init' || h.source === 'engine') ? h.status : snap?.status;
    const st = statusOf(v);
    return st === 'needs-auth' || st === 'failed' ? st : null;
  };

  for (const l of f.loaded || []) {
    const h = f.health[l.name];
    if (l.via === 'gateway' && engineRefused(l.name)) {
      const who = f.engine === 'codex' ? 'Codex' : 'Claude';
      push({
        ...l,
        status: 'needs-reconnect',
        statusText: f.cliTwin?.(l.name)
          ? `${who} did not connect it: a server of the same name in ${who} Code's own config blocks it — reconnect after it is removed`
          : `${who} did not connect it — reconnect this session`,
      });
      continue;
    }
    if (l.via === 'gateway') {
      if (l.kind === 'arigami') push({ ...l, status: 'connected', statusText: 'served by Arigami' });
      else if (l.kind === 'extension') {
        const ext = l.name.slice('ext-'.length);
        push(f.extensionLoaded(ext) ? { ...l, status: 'connected', statusText: 'extension, served by Arigami' } : { ...l, status: 'failed', statusText: 'extension is not loaded' });
      } else if (l.kind === 'composio') push(f.composioKey ? { ...l, status: 'connected', statusText: 'Composio, via Arigami' } : { ...l, status: 'needs-auth', statusText: 'sign in to Composio (Settings › Connections)' });
      else {
        const g = f.hostGrant(l.name);
        if (g?.live) push({ ...l, status: 'connected', statusText: 'connected via Arigami', logout: 'host' });
        else if (g) push({ ...l, status: 'needs-auth', statusText: 'sign in again', login: 'host' });
        else push({ ...l, status: 'needs-reconnect', statusText: 'disconnected since this session started', ...(f.hostCanLogin(l.name) ? { login: 'host' as const } : {}) });
      }
      continue;
    }
    if (l.via === 'codex-grant') {
      const live = f.codexGrantLive(l.name);
      const eng = h?.source === 'engine' ? h : null;
      const status = eng ? statusOf(eng.status) : live ? 'connected' : 'needs-auth';
      push({ ...l, status, statusText: eng?.statusText || (live ? 'Codex grant' : 'Codex has no grant'), ...(status === 'needs-auth' && f.hostCanLogin(l.name) ? { login: 'host' as const } : {}) });
      continue;
    }
    // cli / stdio started by the engine itself: only the engine and traffic know
    push(cliRow(l, h, f));
  }

  // Claude also loads its OWN configured servers (user/project/local scope) and
  // claude.ai connectors — the init report is the only witness. A spawn entry of
  // the same name replaced them (measured), so those are skipped. Codex loads
  // nothing but its config.toml, so it gets none of these.
  if (f.engine === 'claude') {
    const extra = new Map<string, { status?: string; source?: string }>();
    for (const sv of f.snapshot) if (sv?.name && sv.source !== 'dynamic') extra.set(sv.name, sv);
    // before the first init report, the probe's view of the CLI config stands in
    if (!f.snapshot.length) for (const [name, h] of Object.entries(f.health)) if (h.source === 'probe') extra.set(name, { status: h.status });
    for (const [name, sv] of extra) {
      if (seen.has(name)) continue;
      const r = cliRow({ name, via: 'cli', kind: 'server' }, f.health[name] || { status: sv?.status, source: 'init' }, f);
      // claude.ai connectors belong to the Claude account and plugin servers to
      // their plugin: `claude mcp login/logout` cannot touch either.
      const src = sv?.source || (name.startsWith('claude.ai ') ? 'claudeai' : name.startsWith('plugin:') ? 'plugin' : '');
      if (src === 'claudeai' || src === 'plugin') {
        delete r.login;
        delete r.logout;
        r.statusText = `${r.statusText}${r.statusText ? ' · ' : ''}${src === 'claudeai' ? 'managed in your claude.ai account' : 'from a Claude Code plugin'}`;
      }
      push(r);
    }
  }
  return out;
}

function cliRow(l: Loaded, h: Facts['health'][string] | undefined, f: Facts): Row {
  const status = statusOf(h?.status);
  const r: Row = { ...l, status, statusText: h?.statusText || h?.status || '' };
  if (status === 'needs-auth') {
    // A catalog service is better signed in once, by the host, for every engine;
    // the running session picks it up on its next start.
    if (f.hostCanLogin(l.name)) r.login = 'host';
    else if (f.engine === 'claude') r.login = 'cli';
  } else if (status === 'connected' && f.engine === 'claude' && l.via === 'cli') r.logout = 'cli';
  // The host now holds this name: the NEXT spawn uses the host's grant.
  const g = f.hostGrant(l.name);
  if (g?.live && l.via !== 'gateway') {
    r.status = 'needs-reconnect';
    r.statusText = 'connected via Arigami — reconnect this session to use it';
    delete r.login;
    delete r.logout;
  }
  return r;
}
