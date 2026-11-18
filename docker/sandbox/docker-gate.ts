// The docker gate — for a host that itself runs in a container (docs/SANDBOX.md § Host in a container).
//   bun docker-gate.ts <gate.json>
//
// The host needs docker to start its restricted sessions' containers, but the raw docker socket in its container
// would make every session on it (Full ones included) root on the machine. The gate is a unix socket that speaks the
// docker API and forwards ONLY what the sandbox needs, ONLY for this instance's objects:
//
//   - ping / version; inspect of the sandbox image;
//   - networks named <prefix>-int (must be --internal) / <prefix>-out, labelled with the instance tag; connecting one
//     of this instance's containers to its internal network;
//   - containers named <prefix>-…, labelled with the instance tag, from the sandbox image, as a non-root user, with
//     every capability dropped and no-new-privileges, on this instance's networks only, no privileged / host
//     namespaces / devices / published ports / volumes, and bind mounts ONLY under the configured prefixes;
//   - attach / start / wait / kill / remove / inspect / list (label-filtered) — of this instance's containers only.
//
// Everything else (exec, build, pull, volumes, other containers, the daemon's info) is 403. The gate runs OUTSIDE the
// host's container, as a user that may use docker; its config names the instance, not any session.
import fs from 'node:fs';
import net from 'node:net';

export interface GateConfig {
  /** Where the gate listens (mount its directory into the host container). */
  socket: string;
  /** The real daemon. Default /var/run/docker.sock. */
  upstream?: string;
  /** The instance tag and name prefix (server/lib/sandbox.ts instanceTag() / prefix()). */
  tag: string;
  prefix: string;
  image: string;
  /** An existing network the egress container may join as its way out (cfg.sandbox.outsideNetwork). */
  outsideNetwork?: string;
  /** Bind-mount sources must be under one of these (daemon-side paths). */
  bindPrefixes: string[];
}

const API = /^\/v\d+\.\d+(?=\/)/;
const under = (p: string, dirs: string[]) => dirs.some((d) => p === d || p.startsWith(d.replace(/\/+$/, '') + '/'));

export type Verdict = { ok: true; own?: string } | { ok: false; why: string };

/** The route decision before any body is read. `own` = a container id/name whose ownership must be checked. */
export function route(method: string, rawPath: string, c: GateConfig): Verdict & { body?: 'container' | 'network' | 'connect' } {
  const u = new URL(rawPath, 'http://d');
  const p = u.pathname.replace(API, '');
  const m = method.toUpperCase();
  if ((m === 'GET' || m === 'HEAD') && (p === '/_ping' || p === '/version')) return { ok: true };
  let x: RegExpExecArray | null;
  if (m === 'GET' && (x = /^\/images\/(.+)\/json$/.exec(p))) return decodeURIComponent(x[1]) === c.image ? { ok: true } : { ok: false, why: 'only the sandbox image' };
  if (m === 'GET' && (x = /^\/networks\/([^/]+)$/.exec(p))) {
    const n = decodeURIComponent(x[1]);
    return n.startsWith(c.prefix + '-') || n === c.outsideNetwork ? { ok: true } : { ok: false, why: 'not this instance\'s network' };
  }
  if (m === 'POST' && p === '/networks/create') return { ok: true, body: 'network' };
  if (m === 'POST' && (x = /^\/networks\/([^/]+)\/connect$/.exec(p))) {
    const n = decodeURIComponent(x[1]);
    return n === `${c.prefix}-int` ? { ok: true, body: 'connect' } : { ok: false, why: 'only the internal network' };
  }
  if (m === 'GET' && p === '/containers/json') {
    const f = u.searchParams.get('filters') || '';
    return f.includes(`arigami.sandbox.instance=${c.tag}`) ? { ok: true } : { ok: false, why: 'list only with this instance\'s label filter' };
  }
  if (m === 'POST' && p === '/containers/create') {
    const name = u.searchParams.get('name') || '';
    return name.startsWith(c.prefix + '-') ? { ok: true, body: 'container' } : { ok: false, why: `container name must start with ${c.prefix}-` };
  }
  if ((x = /^\/containers\/([^/]+)(?:\/(json|attach|start|wait|kill|stop|resize))?$/.exec(p))) {
    const id = decodeURIComponent(x[1]);
    const op = x[2] || '';
    const allowed = (m === 'GET' && op === 'json') || (m === 'POST' && ['attach', 'start', 'wait', 'kill', 'stop', 'resize'].includes(op)) || (m === 'DELETE' && op === '');
    return allowed ? { ok: true, own: id } : { ok: false, why: `${m} ${op || 'container'} is not allowed` };
  }
  return { ok: false, why: `${m} ${p} is not allowed` };
}

const lc = (o: Record<string, unknown> | null | undefined) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));

/** A container create body: the sandbox's shape and nothing more. */
export function checkContainer(body: any, c: GateConfig): string | null {
  if (!body || typeof body !== 'object') return 'no body';
  if (body.Image !== c.image) return `image must be ${c.image}`;
  if (body.Labels?.['arigami.sandbox.instance'] !== c.tag) return 'missing the instance label';
  const user = String(body.User || '');
  if (!user || /^(0|root)(:|$)/.test(user)) return 'must run as a non-root user';
  const h = body.HostConfig || {};
  if (h.Privileged) return 'privileged';
  if ((h.CapAdd || []).length) return 'CapAdd';
  if (!(h.CapDrop || []).some((x: string) => /^(CAP_)?ALL$/i.test(x))) return 'must drop ALL capabilities';
  const sec: string[] = h.SecurityOpt || [];
  if (!sec.some((s) => /^no-new-privileges(=true|:true)?$/.test(s))) return 'must set no-new-privileges';
  if (sec.some((s) => /unconfined|^label[:=]disable/i.test(s))) return 'unconfined security option';
  for (const k of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode', 'Runtime', 'CgroupParent']) {
    const v = String(h[k] || '');
    if (v && !(k === 'IpcMode' && (v === 'private' || v === 'none' || v === 'shareable')) && !(k === 'CgroupnsMode' && v === 'private')) return `${k}=${v}`;
  }
  if ((h.Devices || []).length || (h.DeviceRequests || []).length || (h.DeviceCgroupRules || []).length) return 'devices';
  if (Object.keys(h.PortBindings || {}).length || h.PublishAllPorts) return 'published ports';
  if ((h.VolumesFrom || []).length || (h.Links || []).length || (h.ExtraHosts || []).length || (h.GroupAdd || []).length) return 'VolumesFrom/Links/ExtraHosts/GroupAdd';
  if (Object.keys(h.Sysctls || {}).length) return 'sysctls';
  if (h.MaskedPaths != null || h.ReadonlyPaths != null) return 'custom masked/readonly /proc paths';
  if (Object.keys(body.Volumes || {}).length) return 'anonymous volumes';
  const nets = [c.prefix + '-int', c.prefix + '-out', ...(c.outsideNetwork ? [c.outsideNetwork] : [])];
  if (!nets.includes(String(h.NetworkMode || ''))) return `network must be one of ${nets.join(', ')}`;
  for (const n of Object.keys(body.NetworkingConfig?.EndpointsConfig || {})) if (!nets.includes(n)) return `network ${n}`;
  for (const b of h.Binds || []) {
    const src = String(b).split(':')[0];
    if (!src.startsWith('/') || !under(src, c.bindPrefixes)) return `bind ${src} is outside the allowed prefixes`;
  }
  for (const mt of h.Mounts || []) {
    const t = String(mt.Type || '').toLowerCase();
    if (t === 'tmpfs') continue;
    if (t !== 'bind') return `mount type ${t}`;
    const src = String(mt.Source || '');
    if (!src.startsWith('/') || !under(src, c.bindPrefixes)) return `bind ${src} is outside the allowed prefixes`;
    if (mt.BindOptions?.Propagation && !/^r?private$/.test(mt.BindOptions.Propagation)) return 'bind propagation';
  }
  return null;
}

export function checkNetwork(body: any, c: GateConfig): string | null {
  const name = String(body?.Name || '');
  if (name !== `${c.prefix}-int` && name !== `${c.prefix}-out`) return `network name must be ${c.prefix}-int or -out`;
  if (lc(body.Labels)['arigami.sandbox.instance'] !== c.tag) return 'missing the instance label';
  if (name.endsWith('-int') && body.Internal !== true) return 'the internal network must be --internal';
  if ((body.Driver || 'bridge') !== 'bridge') return 'bridge only';
  if (Object.keys(body.Options || {}).length) return 'driver options';
  return null;
}

// ---- the proxy ------------------------------------------------------------------------------------------------------

interface Head { method: string; path: string; headers: [string, string][]; rest: Buffer; raw: string }
function parseHead(buf: Buffer): Head | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const raw = buf.subarray(0, end).toString('latin1');
  const [line, ...hs] = raw.split('\r\n');
  const [method, path] = line.split(' ');
  const headers = hs.map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()] as [string, string]; });
  return { method, path, headers, rest: buf.subarray(end + 4), raw };
}

function upstreamJson(sock: string, path: string): Promise<any> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    let data = '';
    s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => (data += d.toString('utf8')));
    s.on('error', () => resolve(null));
    s.on('end', () => {
      const i = data.indexOf('\r\n\r\n');
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(data)?.[1]);
      let body = data.slice(i + 4);
      if (/transfer-encoding:\s*chunked/i.test(data.slice(0, i))) body = body.replace(/(^|\r\n)[0-9a-f]+\r\n/gi, '');
      try { resolve(status === 200 ? JSON.parse(body.trim().replace(/\r\n0\s*$/, '')) : null); } catch { resolve(null); }
    });
  });
}

function refuse(sock: net.Socket, why: string): void {
  const body = JSON.stringify({ message: `arigami docker gate: ${why}` });
  try { sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } catch {}
  process.stderr.write(`[docker-gate] refused: ${why}\n`);
}

export function serve(c: GateConfig): net.Server {
  const up = c.upstream || '/var/run/docker.sock';
  try { fs.rmSync(c.socket, { force: true }); } catch {}
  // Half-open on both legs: the docker CLI closes its write side of an attach stream as soon as it has no stdin to
  // send, and the container's output must still flow back on the other side.
  const srv = net.createServer({ allowHalfOpen: true }, (client) => {
    let buf = Buffer.alloc(0);
    const onData = async (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const h = parseHead(buf);
      if (!h) { if (buf.length > 64 * 1024) refuse(client, 'header too large'); return; }
      const get = (n: string) => h.headers.find(([k]) => k.toLowerCase() === n)?.[1];
      const len = Number(get('content-length') || 0);
      if (get('transfer-encoding')) return refuse(client, 'chunked request bodies are not supported');
      if (h.rest.length < len) return; // wait for the whole body
      client.off('data', onData);
      client.pause();
      const v = route(h.method, h.path, c);
      if (process.env.ARIGAMI_GATE_DEBUG) process.stderr.write(`[docker-gate] ${h.method} ${h.path} ${v.ok ? 'ok' : 'refused'}${get('upgrade') ? ' (upgrade)' : ''}\n`);
      if (!v.ok) return refuse(client, v.why);
      const body = h.rest.subarray(0, len);
      const extra = h.rest.subarray(len);
      if (extra.length && !get('upgrade')) return refuse(client, 'pipelined requests are not supported');
      if (v.body) {
        let j: any = null;
        try { j = JSON.parse(body.toString('utf8') || 'null'); } catch { return refuse(client, 'unreadable body'); }
        const why = v.body === 'container' ? checkContainer(j, c) : v.body === 'network' ? checkNetwork(j, c) : null;
        if (why) return refuse(client, why);
        if (v.body === 'connect') {
          const info = await upstreamJson(up, `/containers/${encodeURIComponent(String(j?.Container || ''))}/json`);
          if (info?.Config?.Labels?.['arigami.sandbox.instance'] !== c.tag) return refuse(client, 'not this instance\'s container');
        }
      }
      if (v.own) {
        const info = await upstreamJson(up, `/containers/${encodeURIComponent(v.own)}/json`);
        if (info && info.Config?.Labels?.['arigami.sandbox.instance'] !== c.tag) return refuse(client, 'not this instance\'s container');
        // (info null = no such container: the daemon answers 404 itself)
      }
      const upgrade = !!get('upgrade');
      const headers = h.headers.filter(([k]) => upgrade || k.toLowerCase() !== 'connection');
      const head = `${h.raw.split('\r\n')[0]}\r\n${headers.map(([k, val]) => `${k}: ${val}`).join('\r\n')}${upgrade ? '' : '\r\nConnection: close'}\r\n\r\n`;
      const u = net.connect({ path: up, allowHalfOpen: true });
      const end = () => { client.destroy(); u.destroy(); };
      u.on('error', end);
      client.on('error', end);
      u.on('connect', () => {
        u.write(head);
        if (body.length) u.write(body);
        if (extra.length) u.write(extra);
        u.pipe(client);
        // Only a hijacked stream (attach) carries client bytes after the request; on a plain request anything more
        // would be a second, unchecked request — the connection ends instead.
        if (upgrade) client.pipe(u);
        else client.on('data', () => end());
        client.resume();
      });
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
  });
  srv.listen(c.socket, () => {
    try { fs.chmodSync(c.socket, 0o660); } catch {}
    process.stderr.write(`[docker-gate] ${c.socket} → ${up} (instance ${c.tag}, prefix ${c.prefix})\n`);
  });
  return srv;
}

if (import.meta.main) {
  const f = process.argv[2];
  if (!f) { process.stderr.write('usage: bun docker-gate.ts <gate.json>\n'); process.exit(2); }
  serve(JSON.parse(fs.readFileSync(f, 'utf8')) as GateConfig);
}
