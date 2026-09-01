// A minimal but REAL OIDC identity provider for the k3d pilot proof — enough
// spec-compliance that `openid-client` v6 (the exact library src/auth.ts
// uses, with full discovery/signature/nonce validation ON) accepts it:
// discovery doc, RS256-signed id_tokens, JWKS, PKCE S256 verification.
// This closes K8S-2's honest gap ("the OIDC round-trip has no live-IdP
// coverage") without ever touching a real account: the "user" who signs in
// is whatever email/sub the caller appends to the authorize URL
// (&email=…&sub=…) — i.e. the login screen is a query string.
//
// TEST FIXTURE ONLY: no client authentication, no consent, http — never
// deploy anything like this.
//
//   bun test/fixtures/mock-idp.ts [port]        # default 18091
import crypto from 'node:crypto';

const port = Number(process.argv[2] || process.env.MOCK_IDP_PORT || 18091);
const issuer = process.env.MOCK_IDP_ISSUER || `http://127.0.0.1:${port}`;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'mock-idp-k1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey);
  return `${header}.${body}.${b64url(sig)}`;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  email: string;
  sub: string;
}
const codes = new Map<string, PendingCode>();
const accessTokens = new Map<string, { email: string; sub: string }>();

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        scopes_supported: ['openid', 'email', 'profile'],
      });

    if (url.pathname === '/jwks') return json({ keys: [jwk] });

    // "Login screen": the caller says who they are via &email=&sub= on the
    // authorize URL. Everything else is the standard code flow.
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const email = q.get('email') || 'user@fake-org.test';
      const sub = q.get('sub') || `sub-${email}`;
      const redirectUri = q.get('redirect_uri') || '';
      if (q.get('response_type') !== 'code' || !redirectUri) return json({ error: 'invalid_request' }, 400);
      const code = crypto.randomBytes(24).toString('base64url');
      codes.set(code, {
        clientId: q.get('client_id') || '',
        redirectUri,
        nonce: q.get('nonce') || '',
        codeChallenge: q.get('code_challenge') || '',
        email,
        sub,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (q.get('state')) back.searchParams.set('state', q.get('state')!);
      return new Response(null, { status: 302, headers: { location: back.href } });
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await req.text());
      const c = codes.get(form.get('code') || '');
      if (!c) return json({ error: 'invalid_grant' }, 400);
      codes.delete(form.get('code')!);
      // PKCE S256 — verified for real, so a broken verifier in src/auth.ts
      // would fail here the way it would against a real IdP.
      const verifier = form.get('code_verifier') || '';
      if (c.codeChallenge && b64url(crypto.createHash('sha256').update(verifier).digest()) !== c.codeChallenge)
        return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const at = crypto.randomBytes(16).toString('base64url');
      accessTokens.set(at, { email: c.email, sub: c.sub });
      return json({
        access_token: at,
        token_type: 'bearer',
        expires_in: 3600,
        id_token: signIdToken({ iss: issuer, sub: c.sub, aud: c.clientId, exp: now + 3600, iat: now, nonce: c.nonce || undefined, email: c.email }),
      });
    }

    if (url.pathname === '/userinfo') {
      const at = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const u = accessTokens.get(at);
      return u ? json({ sub: u.sub, email: u.email }) : json({ error: 'invalid_token' }, 401);
    }

    return json({ error: 'not_found' }, 404);
  },
});

console.log(`[mock-idp] up at ${issuer} (discovery: ${issuer}/.well-known/openid-configuration)`);
