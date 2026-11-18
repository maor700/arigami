// The sandbox egress proxy (docs/SANDBOX.md) — the ONLY way out of the internal network the session containers sit on.
//   bun egress-proxy.ts <dir>      (dir: config.json, key, policies/<session>.json, proxy.log)
//
// :3128  forward proxy. CONNECT host:port (HTTPS, any TLS protocol — never intercepted) and absolute-form plain HTTP.
//        The caller proves which session it is with Proxy-Authorization (user = session id, password = HMAC(key, id),
//        handed to that session's container only). Its allowlist is policies/<id>.json (the model API + whatever its
//        profile's `egress` names). A destination that resolves to a private / loopback / link-local address is refused
//        whatever the name (no metadata server, no LAN, no host ports). Every decision is one JSON line in proxy.log;
//        refusals carry "decision":"DENIED".
// :8080  host relay: a plain TCP pipe to config.hostTarget (the host's sandbox listener, which itself takes only a
//        sandboxed session's own token). Nothing else is reachable through it.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.argv[2] || '/egress';
const LOG = path.join(DIR, 'proxy.log');
const MAX_LOG = 20 * 1024 * 1024;

interface Config { hostTarget?: string; proxyPort?: number; relayPort?: number; allowPrivate?: string[] }
const cache = new Map<string, { mtime: number; v: unknown }>();
function readJson<T>(f: string): T | null {
  try {
    const m = fs.statSync(f).mtimeMs;
    const c = cache.get(f);
    if (c && c.mtime === m) return c.v as T;
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache.set(f, { mtime: m, v });
    return v as T;
  } catch {
    return null;
  }
}
const config = (): Config => readJson<Config>(path.join(DIR, 'config.json')) || {};
let key = '';
const keyOf = () => (key ||= fs.readFileSync(path.join(DIR, 'key'), 'utf8').trim());

function log(entry: Record<string, unknown>): void {
  try {
    if (fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, LOG + '.1');
  } catch {}
  try {
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

/** Private, loopback, link-local (metadata), CGNAT, multicast, unspecified — v4 and v6. */
export function isPrivateAddress(a: string): boolean {
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127) || x >= 224;
  }
  const v = a.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** The session a request speaks for, or null (no / wrong credentials). */
export function sessionOf(header: string | undefined, k: string): string | null {
  const m = /^Basic\s+(.+)$/i.exec(String(header || '').trim());
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const sid = decodeURIComponent(raw.slice(0, i));
  const pass = raw.slice(i + 1);
  const want = crypto.createHmac('sha256', k).update(sid).digest('base64url').slice(0, 32);
  if (pass.length !== want.length || !crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(want))) return null;
  return /^[A-Za-z0-9_-]{1,80}$/.test(sid) ? sid : null;
}

function deny(sock: net.Socket, status: string, why: string): void {
  try {
    sock.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nX-Arigami-Egress: denied\r\nProxy-Authenticate: Basic realm="arigami-egress"\r\nConnection: close\r\n\r\negress denied by the Arigami sandbox: ${why}\n`);
  } catch {}
}

interface Head { method: string; target: string; version: string; headers: [string, string][]; rest: Buffer }
function parseHead(buf: Buffer): Head | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const text = buf.subarray(0, end).toString('latin1');
  const [line, ...hs] = text.split('\r\n');
  const [method, target, version] = line.split(' ');
  if (!method || !target) return null;
  const headers = hs.map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()] as [string, string]; }).filter(([k]) => k);
  return { method: method.toUpperCase(), target, version: version || 'HTTP/1.1', headers, rest: buf.subarray(end + 4) };
}

async function resolveSafe(host: string, allowPrivate: string[]): Promise<{ addr?: string; why?: string }> {
  if (net.isIP(host)) return isPrivateAddress(host) && !allowPrivate.includes(host) ? { why: `private address ${host}` } : { addr: host };
  try {
    const all = await dns.lookup(host, { all: true });
    if (!all.length) return { why: `${host} does not resolve` };
    if (!allowPrivate.includes(host.toLowerCase())) {
      const bad = all.find((a) => isPrivateAddress(a.address));
      if (bad) return { why: `${host} resolves to a private address (${bad.address})` };
    }
    return { addr: all[0].address };
  } catch (e) {
    return { why: `${host} does not resolve (${(e as Error).message})` };
  }
}

function handleProxy(sock: net.Socket): void {
  let buf = Buffer.alloc(0);
  sock.setTimeout(30_000, () => sock.destroy());
  const onData = async (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 64 * 1024) return deny(sock, '431 Request Header Fields Too Large', 'header too large');
    const h = parseHead(buf);
    if (!h) return;
    sock.off('data', onData);
    sock.pause();
    sock.setTimeout(0);
    const get = (n: string) => h.headers.find(([k]) => k.toLowerCase() === n)?.[1];
    let host = '', port = 0, origin = '';
    if (h.method === 'CONNECT') {
      const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(h.target);
      if (!m) return deny(sock, '400 Bad Request', 'bad CONNECT target');
      host = m[1]; port = Number(m[2]);
    } else {
      let u: URL;
      try { u = new URL(h.target); } catch { return deny(sock, '400 Bad Request', 'not a proxy request (absolute URL expected)'); }
      if (u.protocol !== 'http:') return deny(sock, '400 Bad Request', `scheme ${u.protocol} (use CONNECT)`);
      host = u.hostname.replace(/^\[|\]$/g, ''); port = Number(u.port) || 80; origin = (u.pathname || '/') + u.search;
    }
    const target = `${host}:${port}`;
    let sid: string | null = null;
    try { sid = sessionOf(get('proxy-authorization'), keyOf()); } catch {}
    const base = { sid, method: h.method, target, ...(h.method === 'CONNECT' ? {} : { path: origin.slice(0, 200) }) };
    if (!sid) {
      log({ ...base, decision: 'DENIED', reason: 'no or wrong proxy credentials' });
      return deny(sock, '407 Proxy Authentication Required', 'no session credentials');
    }
    const pol = readJson<{ allow?: string[] }>(path.join(DIR, 'policies', `${sid}.json`));
    const allow = Array.isArray(pol?.allow) ? pol!.allow! : [];
    if (!hostAllowed(host, allow)) {
      log({ ...base, decision: 'DENIED', reason: 'not in the allowlist' });
      return deny(sock, '403 Forbidden', `${target} is not in this session's allowlist`);
    }
    const r = await resolveSafe(host, config().allowPrivate || []);
    if (!r.addr) {
      log({ ...base, decision: 'DENIED', reason: r.why });
      return deny(sock, '403 Forbidden', r.why || 'unresolvable');
    }
    const up = net.connect(port, r.addr);
    const end = () => { sock.destroy(); up.destroy(); };
    up.setTimeout(15_000, () => { if (up.connecting) { log({ ...base, decision: 'FAILED', reason: 'connect timeout' }); deny(sock, '504 Gateway Timeout', 'connect timeout'); up.destroy(); } });
    up.on('error', (e) => { if (!sock.destroyed) deny(sock, '502 Bad Gateway', e.message); end(); });
    sock.on('error', end);
    up.once('connect', () => {
      up.setTimeout(0);
      log({ ...base, decision: 'ALLOWED' });
      if (h.method === 'CONNECT') {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (h.rest.length) up.write(h.rest);
      } else {
        const keep = h.headers.filter(([k]) => !/^(proxy-authorization|proxy-connection|connection|keep-alive)$/i.test(k));
        up.write(`${h.method} ${origin} ${h.version}\r\n${keep.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\nConnection: close\r\n\r\n`);
        if (h.rest.length) up.write(h.rest);
      }
      sock.pipe(up);
      up.pipe(sock);
      sock.resume();
    });
  };
  sock.on('data', onData);
  sock.on('error', () => sock.destroy());
}

function handleRelay(sock: net.Socket): void {
  const t = String(config().hostTarget || '');
  const m = /^(.+):(\d+)$/.exec(t);
  if (!m) return void sock.destroy();
  const up = net.connect(Number(m[2]), m[1].replace(/^\[|\]$/g, ''));
  const end = () => { sock.destroy(); up.destroy(); };
  sock.on('error', end);
  up.on('error', end);
  sock.pipe(up);
  up.pipe(sock);
}

if (import.meta.main) {
  const c = config();
  net.createServer(handleProxy).listen(c.proxyPort || 3128, '0.0.0.0', () => process.stderr.write(`[egress] proxy on :${c.proxyPort || 3128}\n`));
  net.createServer(handleRelay).listen(c.relayPort || 8080, '0.0.0.0', () => process.stderr.write(`[egress] host relay on :${c.relayPort || 8080}\n`));
  log({ decision: 'START', note: 'egress proxy up' });
}
