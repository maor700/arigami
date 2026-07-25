// Self-driven OAuth login for adding a Claude account — replaces the fragile
// `claude setup-token` TUI-scraping path. We run the whole PKCE flow ourselves:
// generate the verifier/challenge, send the user to Anthropic's consent page,
// take the authorization code they paste back, and exchange it for a token via a
// plain HTTPS POST. The token arrives as clean JSON — impossible to corrupt the
// way scraping a redrawn terminal was (the oat01→at01 mangling).
//
// The exchange returns a SHORT-LIVED access token (~8h) + a refresh token, so we
// store both and auto-renew before expiry (startTokenRefresher) — the account
// then behaves like a durable login without depending on setup-token's 1-year
// token or clobbering the macOS keychain.
//
// Endpoints/params are the public Claude Code OAuth client (same client_id the
// CLI uses). redirect_uri is Anthropic's hosted callback that DISPLAYS the code
// for the user to paste — reliable across the loopback-redirect restrictions.
import crypto from 'node:crypto';
import {
  addTokenAccount,
  resolveRefreshToken,
  updateOAuthTokens,
  oauthAccountsToRefresh,
  listAccounts,
} from './accounts.js';
import { broadcast } from './bus.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// Request the same scope set the real `claude` login flow uses (verified against
// the CLI bundle: its env-var hint names "user:profile user:inference
// user:sessions:claude_code user:mcp_servers"). user:profile is what unlocks the
// /api/oauth/usage + /api/oauth/profile endpoints — inference-only tokens get a
// 403 there, which is why added accounts showed no usage. The earlier failure
// ("Invalid request format") came from %20-encoding the spaces: the CLI builds
// the URL with URLSearchParams, which encodes spaces as '+', so we do the same.
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** @type {Map<string, any>} */
const flows = new Map();

const publicView = (f) => ({
  id: f.id,
  state: f.state, // 'awaiting-code' | 'exchanging' | 'done' | 'error'
  url: f.url || null,
  error: f.error || null,
  account: f.account || null,
});

const emit = (f) => broadcast({ type: 'account-auth', flow: publicView(f) });

// Step 1: mint PKCE + state, build the consent URL. The client opens `url`; the
// user approves and Anthropic shows a code (formatted "CODE#STATE") to paste.
export function startLogin({ label } = {}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  // 32 bytes → 43-char base64url, matching the real `claude setup-token` state
  // exactly. A shorter (16-byte) state made the authorize endpoint reject the
  // request with "Invalid request format" after clicking Authorize.
  const state = b64url(crypto.randomBytes(32));
  const id = 'oauth_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  // Build with URLSearchParams so the multi-scope value encodes spaces as '+',
  // exactly like the CLI — %20 encoding gets rejected ("Invalid request format").
  const q = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const url = `${AUTHORIZE_URL}?${q.toString()}`;
  // NOTE: `f.state` is the flow's UI state ('awaiting-code' | …). The OAuth CSRF
  // state (the random value that rode into the authorize URL) lives in its own
  // field `oauthState` — do NOT reuse `f.state` for it, or it gets overwritten
  // and the token exchange sends the literal string 'awaiting-code'.
  const f = { id, verifier, oauthState: state, url, label: (label || '').trim(), state: 'awaiting-code', account: null, error: null };
  flows.set(id, f);
  // Auto-expire an abandoned flow so the map doesn't grow unbounded.
  const t = setTimeout(() => flows.delete(id), 15 * 60_000);
  if (t.unref) t.unref();
  return publicView(f);
}

export function loginStatus(id) {
  const f = flows.get(id);
  return f ? publicView(f) : { id, state: 'error', url: null, error: 'unknown login flow', account: null };
}

// Step 2: exchange the pasted code for tokens and create the account.
export async function submitCode(id, codeInput) {
  const f = flows.get(id);
  if (!f) return { ok: false, error: 'unknown login flow' };
  if (f.state === 'done' && f.account) return { ok: true, account: f.account };
  // The pasted value is "CODE#STATE" (Anthropic's callback page shows it joined
  // by '#'); accept a bare code too. Trust the state that rode with the code.
  const raw = String(codeInput || '').trim();
  const [code, stateFromCode] = raw.split('#');
  if (!code) {
    f.state = 'error';
    f.error = 'no code — paste the value shown on the Anthropic page after approving';
    emit(f);
    return { ok: false, error: f.error };
  }
  // CSRF check: if the pasted value carried a state, it must match the one we
  // minted. (A bare code with no '#STATE' is accepted — Anthropic's callback
  // page sometimes shows the code alone — and we fall back to our own state.)
  if (stateFromCode && stateFromCode !== f.oauthState) {
    f.state = 'error';
    f.error = 'state mismatch — the pasted code is from a different login attempt; start over';
    emit(f);
    return { ok: false, error: f.error };
  }
  f.state = 'exchanging';
  emit(f);
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: f.verifier,
      state: stateFromCode || f.oauthState,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      f.state = 'error';
      f.error = `token exchange failed (${res.status}). ${t.slice(0, 160)}`.trim();
      emit(f);
      return { ok: false, error: f.error };
    }
    const tok = await res.json();
    const access = tok.access_token;
    if (!access) {
      f.state = 'error';
      f.error = 'exchange returned no access_token';
      emit(f);
      return { ok: false, error: f.error };
    }
    const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
    f.account = addTokenAccount({
      label: f.label || tok.account?.email_address || tok.account?.email || 'Account',
      token: access,
      trusted: true,
      refreshToken: tok.refresh_token || null,
      expiresAt,
      email: tok.account?.email_address || tok.account?.email || null,
      org: tok.organization?.name || null,
    });
    f.state = 'done';
    emit(f);
    // Fill usage right away so the new account isn't blank.
    import('./usage.js').then((m) => m.refreshAccount(f.account.id)).catch(() => {});
    return { ok: true, account: f.account };
  } catch (e) {
    f.state = 'error';
    f.error = e?.name === 'TimeoutError' ? 'token exchange timed out' : e?.message || String(e);
    emit(f);
    return { ok: false, error: f.error };
  }
}

export function cancelLogin(id) {
  flows.delete(id);
  return { ok: true };
}

// ---- token refresh ----------------------------------------------------------
// Renew one oauth-login account's access token from its refresh token.
export async function refreshOne(id) {
  const refresh = resolveRefreshToken(id);
  if (!refresh) return false;
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`[oauth] refresh failed for ${id}: ${res.status}`);
      return false;
    }
    const tok = await res.json();
    if (!tok.access_token) return false;
    const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
    updateOAuthTokens(id, { access: tok.access_token, refresh: tok.refresh_token || null, expiresAt });
    return true;
  } catch (e) {
    console.error(`[oauth] refresh error for ${id}: ${e.message}`);
    return false;
  }
}

// Renew every oauth-login account whose access token is within `withinMs` of
// expiry. Returns how many were refreshed.
export async function refreshExpiring(withinMs) {
  const due = oauthAccountsToRefresh(withinMs);
  let n = 0;
  for (const a of due) if (await refreshOne(a.id)) n++;
  if (n) broadcast({ type: 'accounts-updated', accounts: listAccounts() });
  return n;
}

// Boot: renew anything already expired/expiring, then poll. 8h tokens checked
// every 10 min with a 1h-ahead window are always renewed well before they die.
export function startTokenRefresher() {
  refreshExpiring(60 * 60_000).catch(() => {});
  const t = setInterval(() => refreshExpiring(60 * 60_000).catch(() => {}), 10 * 60_000);
  if (t.unref) t.unref();
  return t;
}
