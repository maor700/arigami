// Read one site's login state out of a running Chrome and write it into
// another — cookies, IndexedDB, localStorage — over the DevTools protocol.
//
// Why not copy profile files: Chrome's Cookies/Local Storage/IndexedDB are
// whole-profile databases. Copying them moves EVERY site at once, and copying
// one over another replaces what was there (that is how two logins used to
// overwrite each other). Going through Chrome itself moves exactly one site and
// merges into whatever the target already holds.
//
// The page-side scripts run in a document OF the site's origin (storage is
// per-origin), opened on a cheap URL (/robots.txt) so the site's own app code
// never runs. Values are sent as tagged JSON — IndexedDB holds Dates,
// ArrayBuffers, Blobs and CryptoKeys that plain JSON would flatten.
//
// A CryptoKey created non-extractable cannot leave the browser by design; the
// export throws DEVICE_BOUND on meeting one. That is the generic, site-agnostic
// signal that a session is tied to this browser and must not be copied.

/** A multiplexed connection to a Chrome's browser-level DevTools endpoint. */
export class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('cdp socket error'));
    });
    this.ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const p = msg.id != null ? this.pending.get(msg.id) : null;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp error'));
      else p.resolve(msg.result);
    };
    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('cdp socket closed'));
      this.pending.clear();
    };
  }

  static async connect(port: number): Promise<Cdp> {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const v = (await r.json()) as { webSocketDebuggerUrl: string };
    const c = new Cdp(v.webSocketDebuggerUrl);
    await c.ready;
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  session?: boolean;
  priority?: string;
  sameParty?: boolean;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
}

export interface OriginState {
  origin: string;
  /** Tagged-JSON dump from DUMP_JS; null when the origin had nothing. */
  idb: any[];
  local: Record<string, string>;
}

export interface SiteState {
  cookies: CdpCookie[];
  origins: OriginState[];
}

// ---- page scripts -------------------------------------------------------------

const B64 = `
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
`;

/**
 * Runs in a page of the origin. `filter` = IndexedDB names to include (null =
 * all). Resolves to a JSON string {idb, local}; rejects with DEVICE_BOUND on a
 * non-extractable CryptoKey and TOO_LARGE past the cap.
 */
export function dumpScript(filter: string[] | null, capBytes: number): string {
  return `(async () => {
${B64}
const FILTER = ${JSON.stringify(filter)};
const enc = async (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return { __t: 'date', v: v.toISOString() };
  if (v instanceof ArrayBuffer) return { __t: 'ab', v: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { __t: 'ta', c: v.constructor.name, v: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { __t: 'blob', type: v.type, v: b64(new Uint8Array(await v.arrayBuffer())) };
  if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) {
    if (!v.extractable) throw new Error('DEVICE_BOUND');
    return { __t: 'ck', alg: v.algorithm, usages: v.usages, type: v.type, jwk: await crypto.subtle.exportKey('jwk', v) };
  }
  if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await enc(x)); return a; }
  if (v instanceof Map) { const a = []; for (const [k, x] of v) a.push([await enc(k), await enc(x)]); return { __t: 'map', v: a }; }
  if (v instanceof Set) { const a = []; for (const x of v) a.push(await enc(x)); return { __t: 'set', v: a }; }
  const o = {}; for (const k of Object.keys(v)) o[k] = await enc(v[k]); return o;
};
const out = { idb: [], local: {} };
const dbs = indexedDB.databases ? await indexedDB.databases() : [];
for (const { name } of dbs) {
  if (!name || (FILTER && !FILTER.includes(name))) continue;
  const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); });
  const stores = [];
  for (const sn of Array.from(db.objectStoreNames)) {
    const st = db.transaction(sn, 'readonly').objectStore(sn);
    const indexes = Array.from(st.indexNames).map((n) => { const i = st.index(n); return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; });
    const keys = await req(st.getAllKeys());
    const vals = await req(db.transaction(sn, 'readonly').objectStore(sn).getAll());
    stores.push({ name: sn, keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes, keys: await enc(keys), values: await enc(vals) });
  }
  out.idb.push({ name, version: db.version, stores });
  db.close();
}
for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local[k] = localStorage.getItem(k); }
const s = JSON.stringify(out);
if (s.length > ${capBytes}) throw new Error('TOO_LARGE');
return s;
})()`;
}

/** Runs in a page of the origin; writes a dump back. Existing databases of the same name are replaced. */
export function restoreScript(dumpJson: string): string {
  return `(async () => {
${B64}
const D = ${dumpJson};
const dec = async (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await dec(x)); return a; }
  switch (v.__t) {
    case 'date': return new Date(v.v);
    case 'ab': return unb64(v.v).buffer;
    case 'ta': { const u = unb64(v.v); const C = globalThis[v.c] || Uint8Array; return new C(u.buffer, 0, u.byteLength / (C.BYTES_PER_ELEMENT || 1)); }
    case 'blob': return new Blob([unb64(v.v)], { type: v.type });
    case 'ck': return crypto.subtle.importKey('jwk', v.jwk, v.alg, true, v.usages);
    case 'map': { const m = new Map(); for (const [k, x] of v.v) m.set(await dec(k), await dec(x)); return m; }
    case 'set': { const s = new Set(); for (const x of v.v) s.add(await dec(x)); return s; }
  }
  const o = {}; for (const k of Object.keys(v)) o[k] = await dec(v[k]); return o;
};
let rows = 0;
for (const db of D.idb) {
  await new Promise((res) => { const r = indexedDB.deleteDatabase(db.name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  const h = await new Promise((res, rej) => {
    const r = indexedDB.open(db.name, db.version);
    r.onupgradeneeded = () => {
      for (const s of db.stores) {
        const st = r.result.createObjectStore(s.name, { keyPath: s.keyPath === null ? undefined : s.keyPath, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) st.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  for (const s of db.stores) {
    const keys = await dec(s.keys), vals = await dec(s.values);
    const st = h.transaction(s.name, 'readwrite').objectStore(s.name);
    await Promise.all(vals.map((v, i) => req(s.keyPath === null ? st.put(v, keys[i]) : st.put(v))));
    rows += vals.length;
  }
  h.close();
}
for (const [k, v] of Object.entries(D.local)) localStorage.setItem(k, v);
return JSON.stringify({ dbs: D.idb.length, rows, local: Object.keys(D.local).length });
})()`;
}

// ---- browser-side operations ------------------------------------------------

/** Open a tab on `url`, run `fn` with a flat session attached to it, close it. */
async function withPage<T>(cdp: Cdp, url: string, fn: (sid: string) => Promise<T>): Promise<T> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 80; i++) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState + "|" + location.origin', returnByValue: true }, sessionId).catch(() => null);
      const [st, origin] = String(r?.result?.value || '').split('|');
      if ((st === 'complete' || st === 'interactive') && origin && origin !== 'null') break;
      await new Promise((r2) => setTimeout(r2, 150));
    }
    return await fn(sessionId);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function evalIn(cdp: Cdp, sid: string, expression: string, timeoutMs = 60_000): Promise<any> {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid, timeoutMs);
  if (r?.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page script failed';
    throw new Error(String(msg).split('\n')[0].replace(/^Error:\s*/, ''));
  }
  return r?.result?.value;
}

export const STATE_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Everything one site needs, read from a running Chrome.
 * `cookieFilter` picks the site's cookies; `origins` the storage to read.
 */
export async function exportSite(
  cdp: Cdp,
  cookieFilter: (domain: string) => boolean,
  origins: string[],
  authDbs: string[] | null
): Promise<SiteState> {
  const { cookies } = await cdp.send('Storage.getCookies', {});
  const mine = (cookies as CdpCookie[]).filter((c) => cookieFilter(c.domain));
  const out: SiteState = { cookies: mine, origins: [] };
  for (const origin of origins) {
    const json = await withPage(cdp, `${origin}/robots.txt`, (sid) => evalIn(cdp, sid, dumpScript(authDbs, STATE_CAP_BYTES)));
    const d = JSON.parse(json);
    if (d.idb.length || Object.keys(d.local).length) out.origins.push({ origin, idb: d.idb, local: d.local });
  }
  return out;
}

/** Write a site's state into a running Chrome. Merges: other sites are untouched. */
export async function importSite(cdp: Cdp, st: SiteState): Promise<{ cookies: number; dbs: number; rows: number; local: number }> {
  if (st.cookies.length) {
    // Storage.setCookies wants CookieParam: drop the read-only fields.
    const params = st.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.session || !(c.expires > 0) ? {} : { expires: c.expires }),
      ...(c.priority ? { priority: c.priority } : {}),
      ...(c.sourceScheme ? { sourceScheme: c.sourceScheme } : {}),
      // Chrome binds a cookie to the port it came from. A cookie whose source
      // port was never recorded (-1, the legacy value) is re-set by CDP with a
      // port Chrome guesses from the scheme: 80 for a non-Secure cookie, and a
      // cookie bound to port 80 is not sent to https on 443. Measured by diffing
      // the stored rows: Google's SID came back with port 80. Logins are https,
      // so an unrecorded port becomes 443. (That alone did not make Google
      // accept a copied session — see login-sites.ts.)
      sourcePort: typeof c.sourcePort === 'number' && c.sourcePort > 0 ? c.sourcePort : 443,
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    }));
    await cdp.send('Storage.setCookies', { cookies: params });
  }
  let dbs = 0;
  let rows = 0;
  let local = 0;
  for (const o of st.origins) {
    const r = JSON.parse(await withPage(cdp, `${o.origin}/robots.txt`, (sid) => evalIn(cdp, sid, restoreScript(JSON.stringify({ idb: o.idb, local: o.local })))));
    dbs += r.dbs;
    rows += r.rows;
    local += r.local;
  }
  return { cookies: st.cookies.length, dbs, rows, local };
}

/**
 * Load `url` and report where it settled. A login wall is recognized by the
 * final URL — the one signal that works the same for every site.
 */
export async function landing(cdp: Cdp, url: string, siteLoggedOut?: RegExp): Promise<{ url: string; loggedOut: boolean }> {
  return withPage(cdp, url, async (sid) => {
    await new Promise((r) => setTimeout(r, 4000)); // let client-side redirects run
    const r = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sid);
    const final = String(r?.result?.value || url);
    return { url: final, loggedOut: isLoggedOutUrl(final, siteLoggedOut) };
  });
}

export const LOGIN_WALL = /(\/login|\/signin|\/sign-in|\/sign_in|\/auth\/|\/accounts\/login|accountchooser|ServiceLogin|\/checkpoint\/|[?&](next|continue|redirect)=)/i;

/**
 * Did a check land on a signed-out page? The generic login-wall shapes, plus a
 * site's own signed-out page when it has one that looks like nothing of the
 * kind (Google's is /account/about — a marketing page, which the generic match
 * missed, so a copy that had signed the owner out went unreported).
 */
export function isLoggedOutUrl(url: string, siteLoggedOut?: RegExp): boolean {
  return LOGIN_WALL.test(url) || !!siteLoggedOut?.test(url);
}
