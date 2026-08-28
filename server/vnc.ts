// Screen-share bridge (/__vnc): terminates the browser's WebSocket connection
// and pipes its binary frames to/from a raw TCP connection to the VNC server
// configured in cfg.screen — the same role `websockify` plays for noVNC, done
// in-process with the `ws` package already used by bus.js (no new server
// dependency). Global (not per-session): one shared desktop, reachable
// regardless of which session tab is open. See docs on cfg.screen for the
// trust model — the VNC server itself is loopback-only; this bridge is the
// only path to it, gated the same way the rest of the host is (VPN).
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { cfg } from './state.js';

// noVNC's RFB class opens the socket with `new WebSocket(url, ['binary'])`
// and expects the server to select that subprotocol back — without it some
// noVNC versions refuse the connection.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols: Set<string>) => (protocols.has('binary') ? 'binary' : false),
});

wss.on('connection', (ws: WebSocket) => {
  const { vncHost, vncPort } = cfg.screen;
  const tcp = net.connect(vncPort, vncHost);

  tcp.on('connect', () => {
    ws.on('message', (data: Buffer) => {
      try { tcp.write(data); } catch {}
    });
  });
  tcp.on('data', (chunk) => {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(chunk); } catch {}
    }
  });
  tcp.on('error', () => { try { ws.close(); } catch {} });
  tcp.on('close', () => { try { ws.close(); } catch {} });
  ws.on('close', () => { try { tcp.destroy(); } catch {} });
  ws.on('error', () => { try { tcp.destroy(); } catch {} });
});

export function handleUpgrade(req: any, socket: any, head: Buffer): void {
  if (!cfg.screen?.enabled) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => wss.emit('connection', ws, req));
}

// ---- Frame capture (T3 screenshots) -----------------------------------------
//
// A throwaway RFB 3.8 client that connects to the same VNC server the bridge
// above proxies, negotiates None/VNC-auth, asks for one full framebuffer
// update in Raw encoding at 32bpp, and returns the pixels. One short-lived
// TCP connection per capture (x11vnc runs -shared, so this coexists with the
// live noVNC viewer). Encodes to PNG in server/lib/png.ts — no image deps.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePng } from './lib/png.js';

export interface Frame {
  width: number;
  height: number;
  rgba: Buffer; // width*height*4, alpha byte unspecified
}

// VNC-auth: DES-encrypt the 16-byte challenge with the password (≤8 chars,
// each byte bit-reversed — the RFB quirk), ECB, no padding.
function vncAuthResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  const pw = Buffer.from(password.slice(0, 8), 'latin1');
  for (let i = 0; i < pw.length; i++) {
    let b = pw[i], r = 0;
    for (let k = 0; k < 8; k++) { r = (r << 1) | (b & 1); b >>= 1; }
    key[i] = r;
  }
  const c = crypto.createCipheriv('des-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(challenge), c.final()]);
}

// Byte-stream reader over a socket: `take(n)` resolves once n bytes are buffered.
function reader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  const pump = () => {
    if (waiter && buf.length >= waiter.n) {
      const out = buf.subarray(0, waiter.n);
      buf = buf.subarray(waiter.n);
      const w = waiter; waiter = null;
      w.resolve(out);
    }
  };
  sock.on('data', (d: Buffer) => { buf = Buffer.concat([buf, d]); pump(); });
  const fail = (e: Error) => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('vnc: connection closed')));
  return (n: number) =>
    new Promise<Buffer>((resolve, reject) => {
      if (waiter) return reject(new Error('vnc: concurrent read'));
      waiter = { n, resolve, reject };
      pump();
    });
}

export function captureFrame(timeoutMs = 8000): Promise<Frame> {
  const { vncHost, vncPort, vncPassword } = cfg.screen;
  return new Promise<Frame>((resolve, reject) => {
    const sock = net.connect(vncPort, vncHost);
    const timer = setTimeout(() => { fail(new Error('vnc: capture timed out')); }, timeoutMs);
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} fn(); };
    const fail = (e: Error) => finish(() => reject(e));
    const take = reader(sock);
    sock.on('error', (e) => fail(e));
    sock.on('connect', async () => {
      try {
        // --- handshake ---
        const ver = (await take(12)).toString('ascii'); // "RFB 003.008\n"
        if (!/^RFB \d{3}\.\d{3}\n$/.test(ver)) throw new Error(`vnc: bad server version ${JSON.stringify(ver)}`);
        sock.write('RFB 003.008\n');
        const nTypes = (await take(1))[0];
        if (nTypes === 0) {
          const len = (await take(4)).readUInt32BE(0);
          throw new Error('vnc: ' + (await take(len)).toString());
        }
        const types = Array.from(await take(nTypes));
        let sec: number;
        if (types.includes(1)) sec = 1;
        else if (types.includes(2)) sec = 2;
        else throw new Error(`vnc: unsupported security types ${types.join(',')}`);
        sock.write(Buffer.from([sec]));
        if (sec === 2) {
          const challenge = await take(16);
          sock.write(vncAuthResponse(vncPassword || '', challenge));
        }
        const secResult = (await take(4)).readUInt32BE(0);
        if (secResult !== 0) {
          let why = 'authentication failed';
          try { const len = (await take(4)).readUInt32BE(0); why = (await take(len)).toString(); } catch {}
          throw new Error('vnc: ' + why);
        }
        // --- init ---
        sock.write(Buffer.from([1])); // ClientInit: shared
        const si = await take(24);
        const width = si.readUInt16BE(0);
        const height = si.readUInt16BE(2);
        const nameLen = si.readUInt32BE(20);
        await take(nameLen);
        // SetPixelFormat: 32bpp, depth 24, little-endian, true colour,
        // max 255 each, shifts R=16 G=8 B=0 → bytes on the wire are B,G,R,X.
        const pf = Buffer.alloc(20);
        pf[0] = 0; // msg type
        pf[4] = 32; pf[5] = 24; pf[6] = 0; pf[7] = 1;
        pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12);
        pf[14] = 16; pf[15] = 8; pf[16] = 0;
        sock.write(pf);
        // SetEncodings: Raw only
        const se = Buffer.alloc(8);
        se[0] = 2; se.writeUInt16BE(1, 2); se.writeInt32BE(0, 4);
        sock.write(se);
        // FramebufferUpdateRequest: full, non-incremental
        const fr = Buffer.alloc(10);
        fr[0] = 3; fr[1] = 0;
        fr.writeUInt16BE(0, 2); fr.writeUInt16BE(0, 4); fr.writeUInt16BE(width, 6); fr.writeUInt16BE(height, 8);
        sock.write(fr);
        // --- read server messages until one FramebufferUpdate arrives ---
        const rgba = Buffer.alloc(width * height * 4);
        for (;;) {
          const type = (await take(1))[0];
          if (type === 0) { // FramebufferUpdate
            await take(1);
            const nRects = (await take(2)).readUInt16BE(0);
            for (let r = 0; r < nRects; r++) {
              const h = await take(12);
              const x = h.readUInt16BE(0), y = h.readUInt16BE(2), w = h.readUInt16BE(4), hh = h.readUInt16BE(6);
              const enc = h.readInt32BE(8);
              if (enc !== 0) throw new Error(`vnc: unexpected encoding ${enc}`);
              const px = await take(w * hh * 4);
              for (let row = 0; row < hh; row++) {
                const src = row * w * 4;
                const dst = ((y + row) * width + x) * 4;
                for (let i = 0; i < w; i++) {
                  const s = src + i * 4, d = dst + i * 4;
                  rgba[d] = px[s + 2]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s]; rgba[d + 3] = 0xff;
                }
              }
            }
            return finish(() => resolve({ width, height, rgba }));
          } else if (type === 1) { // SetColourMapEntries
            await take(3);
            const n = (await take(2)).readUInt16BE(0);
            await take(n * 6);
          } else if (type === 2) { // Bell
          } else if (type === 3) { // ServerCutText
            await take(3);
            const len = (await take(4)).readUInt32BE(0);
            await take(len);
          } else {
            throw new Error(`vnc: unknown server message ${type}`);
          }
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

// Fallback when the RFB path fails (server refuses raw 32bpp, auth mismatch,
// bridge-only setups): shell out to scrot / ImageMagick `import` against the
// configured X display. Returns null if no tool or display is available.
export function captureWithX11Tool(display: string | undefined): Buffer | null {
  if (!display) return null;
  const tmp = path.join(os.tmpdir(), `arigami-shot-${process.pid}-${Date.now()}.png`);
  const attempts: [string, string[]][] = [
    ['scrot', ['-o', tmp]],
    ['import', ['-window', 'root', tmp]],
  ];
  for (const [bin, args] of attempts) {
    try {
      const r = spawnSync(bin, args, { env: { ...process.env, DISPLAY: display }, timeout: 8000 });
      if (r.status === 0 && fs.existsSync(tmp)) {
        const png = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        if (png.length > 8) return png;
      }
    } catch {}
  }
  try { fs.unlinkSync(tmp); } catch {}
  return null;
}

export interface Capture {
  png: Buffer;
  width?: number;
  height?: number;
  frame?: Frame; // present when captured over RFB (lets callers hash/downscale)
  via: 'rfb' | 'x11';
}

// RFB first, x11 tool second. Throws if neither works.
export async function captureScreen(): Promise<Capture> {
  if (!cfg.screen?.enabled) throw new Error('screen share disabled');
  let rfbErr: Error | null = null;
  try {
    const frame = await captureFrame();
    return { png: encodePng(frame.rgba, frame.width, frame.height), width: frame.width, height: frame.height, frame, via: 'rfb' };
  } catch (e) {
    rfbErr = e instanceof Error ? e : new Error(String(e));
  }
  const png = captureWithX11Tool(cfg.screen.display);
  if (png) return { png, via: 'x11' };
  throw rfbErr;
}
