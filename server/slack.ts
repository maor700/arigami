// Server-side Slack access for the slack listener — a user OAuth token the host
// polls the Slack Web API with. Deterministic HTTP (conversations.history /
// .replies); no MCP, no model in the loop.
//
// Isolation guarantee, mirroring linear-mcp.ts: the token lives ONLY in
// ~/.arigami/slack-token.json (mode 600). It never touches Claude Code's
// Keychain or the Slack plugin's own OAuth. Disconnect = delete that one file.
//
// Why a user token (xoxp) and not a bot token: Slack's OAuth requires a
// registered app either way, and a user token reads the DMs/channels the
// authorizing user is already in — a bot can't read a human-to-human DM.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './state.js';

const API = 'https://slack.com/api';
const STORE = path.join(
  cfg.configDir!,
  'slack-token.json'
);

interface Store {
  token?: string;
  userId?: string; // the token's own user — the "self" the listener ignores
  teamId?: string;
  teamName?: string;
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
    console.error('[slack] could not persist token:', (e as Error).message);
  }
}

export function getToken(): string | null {
  return load().token || null;
}

// ---- Web API ----------------------------------------------------------------

export interface SlackApiResult {
  ok: boolean;
  status: number;
  data?: any;
  error?: string; // Slack's { ok:false, error } string, or a transport message
}

// Call a Slack Web API method with the stored (or supplied) user token. Slack
// reports domain failures as HTTP 200 + { ok:false, error }, so success means
// HTTP-ok AND body.ok.
export async function slackApi(
  method: string,
  params: Record<string, string | number | undefined> = {},
  token = getToken()
): Promise<SlackApiResult> {
  if (!token) return { ok: false, status: 401, error: 'not_authed' };
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) return { ok: false, status: 429, error: 'ratelimited' };
    const data: any = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}`, data };
    if (!data?.ok) return { ok: false, status: 200, error: data?.error || 'unknown_error', data };
    return { ok: true, status: 200, data };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || 'network_error' };
  }
}

// ---- token lifecycle --------------------------------------------------------

// Validate + store a user token. auth.test both proves the token works and
// resolves the self user id (cached for the listener's ignore filter).
export async function setToken(token: string): Promise<{ userId: string; team?: string }> {
  const t = (token || '').trim();
  if (!/^xox[pboa]-/.test(t)) throw new Error('that does not look like a Slack token (expected xoxp-… user token)');
  const res = await slackApi('auth.test', {}, t);
  if (!res.ok) throw new Error(`Slack rejected the token: ${res.error}`);
  const store: Store = {
    token: t,
    userId: res.data?.user_id,
    teamId: res.data?.team_id,
    teamName: res.data?.team,
  };
  save(store);
  viewerIdCache = store.userId || null;
  return { userId: store.userId || '', team: store.teamName };
}

export function status(): { connected: boolean; userId?: string; team?: string } {
  const s = load();
  return { connected: !!s.token, userId: s.userId, team: s.teamName };
}

export function disconnect(): void {
  try {
    fs.rmSync(STORE, { force: true });
  } catch {}
  viewerIdCache = null;
}

// The token's own user id — the "self" whose messages the listener ignores
// (parallels github-pr's ignoreLogin / linear's viewerId). Stored at setToken;
// falls back to a live auth.test.
let viewerIdCache: string | null = null;
export async function viewerId(): Promise<string | null> {
  if (viewerIdCache) return viewerIdCache;
  const stored = load().userId;
  if (stored) return (viewerIdCache = stored);
  const res = await slackApi('auth.test');
  if (res.ok && res.data?.user_id) return (viewerIdCache = res.data.user_id);
  return null;
}

// ---- reads used by the listener poll ----------------------------------------

// Channel metadata for the label/summary (name + whether it's a DM). Best-effort.
export async function conversationInfo(
  channel: string
): Promise<{ name?: string; isDm?: boolean } | null> {
  const res = await slackApi('conversations.info', { channel });
  if (!res.ok) return null;
  const c = res.data?.channel || {};
  return { name: c.name ? `#${c.name}` : undefined, isDm: !!c.is_im };
}

// Newest messages in a channel/DM since `oldest` (exclusive-ish; we re-dedup in
// the pure diff). Returns raw Slack message objects.
export async function conversationsHistory(
  channel: string,
  oldest?: string,
  limit = 30
): Promise<SlackApiResult> {
  return slackApi('conversations.history', { channel, oldest, limit, inclusive: 'true' });
}

// Replies within a single thread — used when the listener watches a thread_ts.
export async function conversationsReplies(
  channel: string,
  ts: string,
  oldest?: string,
  limit = 30
): Promise<SlackApiResult> {
  return slackApi('conversations.replies', { channel, ts, oldest, limit, inclusive: 'true' });
}
