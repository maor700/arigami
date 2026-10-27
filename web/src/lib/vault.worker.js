// VAULT1 — the owner's credential vault, decrypted only here: a Web Worker of the cockpit tab
// (docs/INSTRUCTIONS-AND-VAULT.md, phase 3). The host stores the KDBX 4 file as ciphertext (GET/PUT
// /__api/vault/file) and never sees the master password or a value; the cockpit's own page script never holds the
// unlocked database either — it asks this worker for usernames and to fill one sign-in, and the worker posts the
// values straight to the host's fill route for that one pending request. Locks itself after the unlock window
// (1 hour from last use by default) and when the tab closes (the worker dies with it).
import * as kdbxweb from 'kdbxweb';
import { argon2id, argon2d } from 'hash-wasm';
import { totpSpec, totp } from './totp.js';

kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type) =>
  (type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d)({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory,
    iterations,
    hashLength: length,
    parallelism,
    outputType: 'binary',
  }).then((r) => r.buffer)
);

// Argon2id at 64 MiB × 3 passes: about a second in WASM — slow enough to make guessing a stolen file expensive.
const KDF = { memory: 64 * 1024 * 1024, iterations: 3 };
const ORIGIN_FIELD = 'Arigami origin';

let db = null;
let etag = null;
let lockTimer = null;
let windowMs = 60 * 60_000;
let lockAt = 0;

function lock() {
  db = null;
  etag = null;
  lockAt = 0;
  clearTimeout(lockTimer);
  self.postMessage({ type: 'status', status: { unlocked: false } });
}

function used() {
  clearTimeout(lockTimer);
  lockAt = Date.now() + windowMs;
  lockTimer = setTimeout(lock, windowMs);
}

const registrable = (host) => {
  const p = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const two = p.slice(-2).join('.');
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
};
const originOf = (url) => {
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).origin; } catch { return ''; }
};

function entries() {
  const out = [];
  if (!db) return out;
  const walk = (g) => {
    if (g.uuid.equals(db.meta.recycleBinUuid)) return;
    for (const e of g.entries) out.push(e);
    for (const c of g.groups) walk(c);
  };
  walk(db.getDefaultGroup());
  return out;
}
const text = (v) => (v instanceof kdbxweb.ProtectedValue ? v.getText() : String(v ?? ''));
const entryOrigin = (e) => text(e.fields.get(ORIGIN_FIELD)) || originOf(text(e.fields.get('URL')));
const describe = (e) => ({ id: e.uuid.id, title: text(e.fields.get('Title')), origin: entryOrigin(e), username: text(e.fields.get('UserName')) });

/** Entries for this origin: the exact origin first, then the same site on another host (login.x.com for x.com). */
function matches(origin) {
  const host = (() => { try { return new URL(origin).hostname; } catch { return ''; } })();
  const all = entries().map((e) => ({ e, o: entryOrigin(e) }));
  const exact = all.filter((x) => x.o === origin);
  const site = all.filter((x) => x.o !== origin && x.o.startsWith('https://') === origin.startsWith('https://') && registrable(new URL(x.o || 'https://x.invalid').hostname) === registrable(host));
  return [...exact.map((x) => ({ ...describe(x.e), exact: true })), ...site.map((x) => ({ ...describe(x.e), exact: false }))];
}

async function fetchFile() {
  const r = await fetch('/__api/vault/file', { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`could not read the vault (HTTP ${r.status})`);
  return { buf: await r.arrayBuffer(), etag: r.headers.get('ETag') };
}

async function put(buf, ifMatch) {
  return fetch('/__api/vault/file', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(ifMatch ? { 'If-Match': ifMatch } : {}) }, body: buf });
}

/** Re-encrypt and upload. Another cockpit saved meanwhile → load theirs, re-apply this change, try once more. */
async function save(change) {
  change(db);
  let r = await put(await db.save(), etag);
  if (r.status === 412) {
    const f = await fetchFile();
    if (!f) throw new Error('the vault was removed elsewhere');
    db = await kdbxweb.Kdbx.load(f.buf, db.credentials);
    etag = f.etag;
    change(db);
    r = await put(await db.save(), etag);
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `saving the vault failed (HTTP ${r.status})`);
  etag = r.headers.get('ETag') || (await r.json().catch(() => ({}))).etag || null;
}

function upsert(origin, username, password) {
  return (d) => {
    const found = entries().find((e) => entryOrigin(e) === origin && text(e.fields.get('UserName')) === username);
    const e = found || d.createEntry(d.getDefaultGroup());
    if (!found) {
      e.fields.set('Title', new URL(origin).hostname);
      e.fields.set('URL', origin);
      e.fields.set(ORIGIN_FIELD, origin);
      e.fields.set('UserName', username || '');
    } else e.pushHistory();
    e.fields.set('Password', kdbxweb.ProtectedValue.fromString(password));
    e.times.update();
  };
}

const ops = {
  async status() {
    if (db) return { exists: true, unlocked: true, count: entries().length, lockAt, windowMs };
    const r = await fetch('/__api/vault/file', { method: 'GET', cache: 'no-store' });
    return { exists: r.ok, unlocked: false, windowMs, ...(r.ok || r.status === 404 ? {} : { error: `HTTP ${r.status}` }) };
  },
  async create({ password }) {
    if (!password || password.length < 8) throw new Error('choose a vault password of at least 8 characters');
    if (await fetchFile()) throw new Error('a vault already exists — unlock it');
    const d = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)), 'Arigami');
    d.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    d.header.kdfParameters.set('M', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(KDF.memory));
    d.header.kdfParameters.set('I', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(KDF.iterations));
    const r = await put(await d.save(), '*');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `creating the vault failed (HTTP ${r.status})`);
    db = d;
    etag = r.headers.get('ETag');
    used();
    return ops.status();
  },
  async unlock({ password }) {
    const f = await fetchFile();
    if (!f) throw new Error('there is no vault yet');
    try {
      db = await kdbxweb.Kdbx.load(f.buf, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password || '')));
    } catch (e) {
      if (e?.code === kdbxweb.Consts.ErrorCodes.InvalidKey) throw new Error('wrong vault password');
      throw e;
    }
    etag = f.etag;
    used();
    return ops.status();
  },
  async lock() {
    lock();
    return { unlocked: false, exists: true };
  },
  async setWindow({ minutes }) {
    windowMs = Math.max(5, Math.min(24 * 60, Number(minutes) || 60)) * 60_000;
    if (db) used();
    return ops.status();
  },
  async list() {
    if (!db) throw new Error('the vault is locked');
    used();
    return entries().map(describe);
  },
  async match({ origin }) {
    if (!db) return [];
    used();
    return matches(origin);
  },
  async remove({ id }) {
    if (!db) throw new Error('the vault is locked');
    await save((d) => {
      const e = entries().find((x) => x.uuid.id === id);
      if (e) d.remove(e);
    });
    used();
    return entries().map(describe);
  },
  /**
   * Fill one pending sign-in: from an entry (entryId) or from what the owner typed on the card (values). The values
   * go from here to the host's fill route and nowhere else; with `save`, typed details become (or update) the entry
   * for the request's origin. A one-time code is never saved.
   */
  async fill({ sessionId, requestId, origin, fields, entryId, values, save: keep, remember, auto, exact }) {
    let v = {};
    if (entryId) {
      if (!db) throw new Error('the vault is locked');
      const e = entries().find((x) => x.uuid.id === entryId);
      if (!e) throw new Error('that entry is gone');
      const o = entryOrigin(e);
      if (o !== origin && registrable(new URL(o).hostname) !== registrable(new URL(origin).hostname)) throw new Error('that entry is for another site');
      v = { username: text(e.fields.get('UserName')), password: text(e.fields.get('Password')) };
      if (fields?.includes('otp')) {
        const spec = totpSpec(Object.fromEntries([...e.fields.keys()].filter((k) => /^(otp|TOTP Seed|TOTP Settings)$/i.test(k)).map((k) => [k, text(e.fields.get(k))])));
        if (!spec) throw new Error('this entry holds no one-time-code secret — type the code on the card');
        v.otp = await totp(spec);
      }
    } else {
      for (const k of ['username', 'password', 'otp']) if (typeof values?.[k] === 'string' && values[k]) v[k] = values[k];
    }
    // only the fields the card announced — plus a password for a username-first form's next screen, except on the
    // shared desktop (`exact`), where one card is one field the agent clicked into
    const allowed = new Set([...(fields || []), ...(!exact && fields?.includes('username') ? ['password'] : [])]);
    const body = {};
    for (const k of Object.keys(v)) if (allowed.has(k)) body[k] = v[k];
    const r = await fetch(`/__api/sessions/${encodeURIComponent(sessionId)}/credentials/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, values: body, remember: !!remember, auto: !!auto }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(out.error || `HTTP ${r.status}`), { status: r.status });
    let saved = false;
    if (keep && !entryId && db && v.password) {
      await save(upsert(origin, v.username || '', v.password));
      saved = true;
    }
    if (db) used();
    return { ...out, saved };
  },
};

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data || {};
  try {
    if (!ops[op]) throw new Error(`unknown vault op: ${op}`);
    const result = await ops[op](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e), status: e?.status });
  }
  if (op !== 'status') self.postMessage({ type: 'status', status: { unlocked: !!db, exists: db ? true : undefined, count: db ? entries().length : undefined, lockAt } });
};
