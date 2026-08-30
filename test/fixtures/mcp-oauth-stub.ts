// A local, fully self-contained "remote MCP server with OAuth" — the stand-in
// for mcp.linear.app & friends in tests and in the M1 spike.
//
// It speaks exactly the handshake Claude Code's `claude mcp login` drives:
//   401 + WWW-Authenticate  →  /.well-known/oauth-protected-resource
//   →  /.well-known/oauth-authorization-server  →  DCR /register
//   →  /authorize (302 straight back to the loopback callback with a code)
//   →  /token  →  Bearer token on every later /mcp call.
// Streamable-HTTP MCP is implemented just far enough to answer `initialize` and
// `tools/list`, which is all a health check ("✓ Connected") needs.
//
// Every request is recorded (method, path, whether an Authorization header was
// present and which token) so a test can assert WHICH grant a server name used.
import { serve } from 'bun';

export interface StubLog {
  method: string;
  path: string;
  auth: string | null; // the bearer token as sent, or null
}

export interface Stub {
  url: string; // http://127.0.0.1:<port>/mcp
  origin: string;
  port: number;
  log: StubLog[];
  /** Tokens this stub has ever issued, oldest first. */
  issued: string[];
  /** Bearer tokens seen on /mcp calls (deduped, in order). */
  seenTokens: () => string[];
  stop: () => void;
}

export function startStub(opts: { port?: number; requireAuth?: boolean } = {}): Stub {
  const requireAuth = opts.requireAuth !== false;
  const log: StubLog[] = [];
  const issued: string[] = [];
  const codes = new Map<string, { redirectUri: string; clientId: string }>();
  let n = 0;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const server = serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      const origin = `http://127.0.0.1:${server.port}`;
      const auth = req.headers.get('authorization');
      log.push({ method: req.method, path: u.pathname, auth: auth ? auth.replace(/^Bearer\s+/i, '') : null });

      // --- discovery ---------------------------------------------------------
      // Both the plain and the path-suffixed form (RFC 9728 §3.1) — Claude Code
      // probes the suffixed one first for a resource with a path.
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read', 'write'] });
      }
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server') || u.pathname.startsWith('/.well-known/openid-configuration')) {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
          scopes_supported: ['read', 'write'],
        });
      }
      // --- dynamic client registration --------------------------------------
      if (u.pathname === '/register' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as any;
        return json({ client_id: `stub-client-${++n}`, client_id_issued_at: Math.floor(Date.now() / 1e3), redirect_uris: body?.redirect_uris || [], token_endpoint_auth_method: 'none' }, 201);
      }
      // --- consent: no human needed, bounce straight back to the loopback ----
      if (u.pathname === '/authorize') {
        const redirectUri = u.searchParams.get('redirect_uri') || '';
        const state = u.searchParams.get('state') || '';
        const code = `code-${++n}`;
        codes.set(code, { redirectUri, clientId: u.searchParams.get('client_id') || '' });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        if (state) back.searchParams.set('state', state);
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      // --- token ------------------------------------------------------------
      if (u.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await req.text());
        const gt = form.get('grant_type');
        if (gt === 'authorization_code' && !codes.has(form.get('code') || '')) {
          return json({ error: 'invalid_grant' }, 400);
        }
        codes.delete(form.get('code') || '');
        const token = `stub-access-${++n}`;
        issued.push(token);
        return json({ access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: `stub-refresh-${n}`, scope: 'read write' });
      }
      // --- the MCP endpoint itself ------------------------------------------
      if (u.pathname === '/mcp') {
        if (requireAuth && !auth) {
          return new Response('unauthorized', {
            status: 401,
            headers: { 'www-authenticate': `Bearer realm="stub", resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
          });
        }
        if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
        const rpc = (await req.json().catch(() => ({}))) as any;
        const id = rpc?.id;
        if (id === undefined || id === null) return new Response(null, { status: 202 }); // notification
        const result =
          rpc?.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.0.1' } }
            : rpc?.method === 'tools/list'
              ? { tools: [{ name: 'ping', description: 'stub tool', inputSchema: { type: 'object', properties: {} } }] }
              : rpc?.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'pong' }] }
                : {};
        return json({ jsonrpc: '2.0', id, result }, 200, { 'mcp-session-id': 'stub-session' });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    origin: `http://127.0.0.1:${server.port}`,
    port: server.port,
    log,
    issued,
    seenTokens: () => [...new Set(log.filter((l) => l.path === '/mcp' && l.auth).map((l) => l.auth as string))],
    stop: () => server.stop(true),
  };
}

// `bun test/fixtures/mcp-oauth-stub.ts [port]` — run it standalone (the spike).
if (import.meta.main) {
  const s = startStub({ port: Number(process.argv[2]) || 0 });
  console.log(JSON.stringify({ url: s.url, origin: s.origin, port: s.port }));
  setInterval(() => {
    // Dump the log so a spike script can watch which token each name presents.
    if (process.env.STUB_LOG) Bun.write(process.env.STUB_LOG, JSON.stringify(s.log, null, 2));
  }, 500);
}
