// Subscription usage — the same numbers Claude Code's `/usage` shows (5-hour
// "session" window, 7-day "week", per-model breakdowns). Sourced live from the
// OAuth usage endpoint.
//
// Account-aware: usage is fetched per account from the accounts store, so the
// UI reflects the account a session ACTUALLY runs on — not just the macOS
// keychain login. The generic `usage-updated` broadcast carries the ACTIVE
// account (what the header widget shows); `account-usage` carries each pooled
// account (for the Accounts view). Cached per account + polled so it stays
// cheap.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME } from './lib/platform.js';
import { broadcast } from './bus.js';
import { resolveToken, getActiveId, listAccounts, patchAccount, getAccount, codexHomeOfAccount } from './accounts.js';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TTL_MS = 60_000;

// accountId -> { data, at }
const caches = new Map();
let polling = null;

// Back-compat: the local Claude Code access token (voice.js still uses this for
// the Anthropic voice router). macOS reads the login keychain; everywhere else
// the same blob lives in ~/.claude/.credentials.json. Returns null on failure.
export function readToken() {
  try {
    if (process.platform !== 'darwin') {
      const raw = fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8');
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
    }
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

const pick = (o) =>
  o && typeof o.utilization === 'number'
    ? { pct: Math.round(o.utilization), resetsAt: o.resets_at || null }
    : null;

function normalize(j) {
  const extra = j.extra_usage && j.extra_usage.is_enabled
    ? {
        pct: Math.round(j.extra_usage.utilization || 0),
        used: j.extra_usage.used_credits,
        limit: j.extra_usage.monthly_limit,
        currency: j.extra_usage.currency || 'USD',
      }
    : null;
  return {
    available: true,
    session: pick(j.five_hour),          // rolling 5-hour window ("Current session")
    week: pick(j.seven_day),             // 7-day, all models ("Current week")
    weekSonnet: pick(j.seven_day_sonnet),
    weekOpus: pick(j.seven_day_opus),
    extra,                               // monthly extra-usage credits (if enabled)
    fetchedAt: Date.now(),
  };
}

// One live fetch for an account's token. Never throws. A 429 is itself a signal
// the account is maxed — surface it as session:100% so callers (and auto-switch)
// can treat the account as exhausted.
async function fetchUsage(accountId) {
  // Per provider: a codex account's quota comes from its own CLI's app-server
  // (server/codex-account.ts), in the same {session, week} shape.
  if (getAccount(accountId)?.provider === 'codex') {
    try {
      const m = await import('./codex-account.js');
      return await m.codexUsage(accountId);
    } catch {
      return { available: false, reason: 'fetch-failed' };
    }
  }
  const token = resolveToken(accountId);
  if (!token) return { available: false, reason: 'no-credentials' };
  try {
    const res = await fetch(ENDPOINT, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    // A 429 here is the usage ENDPOINT throttling frequent checks — NOT the
    // account's plan limit. Don't fabricate a maxed state; keep last-good (via
    // getUsage) so the UI doesn't flip to "rate-limited" on a polling hiccup.
    // A genuinely exhausted account shows up as session.pct≈100 on a 200, or via
    // the claude stream limit-error (Phase 3).
    if (res.status === 429) return { available: false, reason: 'usage-throttled' };
    if (!res.ok) return { available: false, reason: `http-${res.status}` };
    return normalize(await res.json());
  } catch {
    return { available: false, reason: 'fetch-failed' };
  }
}

// Usage for an account (defaults to the active one), cached for TTL_MS. Keeps the
// last good data when a refresh fails. Never throws.
export async function getUsage(accountId, force = false) {
  const id = accountId || getActiveId();
  if (!id) return { available: false, reason: 'no-account' };
  const c = caches.get(id);
  if (!force && c && Date.now() - c.at < TTL_MS) return c.data;
  const fresh = await fetchUsage(id);
  const data = !fresh.available && c?.data?.available ? c.data : fresh;
  caches.set(id, { data, at: Date.now() });
  return data;
}

// Best-effort account identity. Only the full macOS-login token carries
// user:profile scope, so this returns email/org/plan for keychain accounts;
// setup-token accounts (user:inference only) get a 403 and yield nothing.
export async function fetchIdentity(token) {
  if (!token) return {};
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const d = await res.json();
    const a = d.account || {};
    const o = d.organization || {};
    return {
      email: a.email_address || a.email || d.email || null,
      org: o.name || null,
      plan: o.organization_type || o.billing_type || null,
    };
  } catch {
    return {};
  }
}

// Identity by provider: claude → the OAuth profile endpoint; codex → the CLI's
// app-server `account/read` (email + plan for ChatGPT logins; an API key has
// no identity to expose). Never throws.
async function identityOf(accountId) {
  const a = getAccount(accountId);
  if (!a) return {};
  if (a.provider === 'codex') {
    if (a.type === 'api-key') return {};
    try {
      const m = await import('./codex-account.js');
      const ident = await m.codexIdentity(codexHomeOfAccount(a));
      return { email: ident.email, plan: ident.plan };
    } catch {
      return {};
    }
  }
  return fetchIdentity(resolveToken(a));
}

// Is this token actually usable for running a session? We test it the exact way
// Claude Code does — a minimal /v1/messages inference call — because that's the
// only authoritative signal (setup-tokens have user:inference scope, so /profile
// is unreliable: it may 401/403 a token that runs sessions perfectly). We only
// declare 'invalid' on a real AUTHENTICATION error; a rate-limit, overload, or
// any other 4xx/5xx means the token authenticated fine → 'valid'. Network/timeout
// → 'unknown' (never punish an account for a transient blip). max_tokens:1 keeps
// the cost negligible; this runs once per capture, not per session.
export async function validateToken(token) {
  if (!token) return 'invalid';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return 'valid';
    let type = '';
    try { type = (await res.json())?.error?.type || ''; } catch {}
    // 401 authentication_error = dead token. Everything else (rate_limit_error,
    // overloaded_error, invalid_request_error, 5xx) = the token authenticated.
    if (res.status === 401 || type === 'authentication_error') return 'invalid';
    return 'valid';
  } catch {
    return 'unknown';
  }
}

// Force a fresh usage read for one account and broadcast it, plus a one-shot
// identity fill. Used right after a token is minted and when the active account
// changes, so the UI reflects the right account immediately (no poll lag).
export async function refreshAccount(id) {
  if (!id) return null;
  const data = await getUsage(id, true);
  const { activeId } = listAccounts();
  patchAccount(id, { lastUsage: compact(data) });
  broadcast({ type: 'account-usage', accountId: id, active: id === activeId, usage: data });
  if (id === activeId) broadcast({ type: 'usage-updated', usage: data });
  const ident = await identityOf(id);
  const patch = {};
  for (const k of ['email', 'org', 'plan']) if (ident[k]) patch[k] = ident[k];
  if (Object.keys(patch).length) patchAccount(id, patch);
  return data;
}

// The per-account snapshot kept in accounts.json (what the cockpit shows before
// the first live broadcast). Window lengths ride along because codex's windows
// are a property of the plan, and the card labels them by length.
const compact = (d) =>
  d.available
    ? {
        session: d.session?.pct ?? null,
        week: d.week?.pct ?? null,
        ...(d.session?.windowMins ? { sessionMins: d.session.windowMins } : {}),
        ...(d.week?.windowMins ? { weekMins: d.week.windowMins } : {}),
        at: d.fetchedAt || Date.now(),
      }
    : { reason: d.reason || 'unavailable', at: Date.now() };

// Poll the active + pooled accounts and broadcast changes. The active account
// also drives the generic `usage-updated` event the header widget listens to.
// Accounts we've already tried to resolve identity for (so a scope-limited
// setup-token isn't re-probed every minute).
const identTried = new Set();

export function startUsagePolling() {
  if (polling) return;
  const tick = async () => {
    const { accounts, activeId } = listAccounts();
    // Poll EVERY account (there are few): non-pooled accounts used to keep a
    // stale add-time reading forever ("checking usage…" in the Accounts view).
    const targets = accounts;
    for (const a of targets) {
      // Isolate each account: an account removed mid-tick makes patchAccount
      // throw 'no such account', which would reject the whole tick (an
      // unhandled rejection) and skip every remaining account. Never let one
      // account's failure abort the poll.
      try {
        const prev = JSON.stringify(caches.get(a.id)?.data);
        const data = await getUsage(a.id, true);
        if (JSON.stringify(data) !== prev) {
          patchAccount(a.id, { lastUsage: compact(data) });
          broadcast({ type: 'account-usage', accountId: a.id, active: a.id === activeId, usage: data });
          if (a.id === activeId) broadcast({ type: 'usage-updated', usage: data });
        }
        // One-shot identity fill (keychain accounts resolve; setup-tokens don't).
        if (!a.email && !identTried.has(a.id)) {
          identTried.add(a.id);
          const ident = await identityOf(a.id);
          const patch = {};
          for (const k of ['email', 'org', 'plan']) if (ident[k]) patch[k] = ident[k];
          if (Object.keys(patch).length) patchAccount(a.id, patch);
        }
      } catch (e) {
        console.error(`[usage] tick failed for ${a.id}:`, e?.message || e);
      }
    }
  };
  const safeTick = () => tick().catch((e) => console.error('[usage] tick error:', e?.message || e));
  safeTick();
  polling = setInterval(safeTick, TTL_MS);
  if (polling.unref) polling.unref();
}
