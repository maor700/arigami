// VAULT1 — the page side of the credential vault. The database itself lives in vault.worker.js; this file only
// passes requests to it and keeps a small status (exists / unlocked / how many entries) the sign-in card and
// Settings › Connections › Passwords render from. No value ever comes back to the page: the worker returns usernames
// and fill outcomes only.
import { useSyncExternalStore } from 'react';
import { revokeAllGrants } from './vault-grants.js';

let worker = null;
let seq = 0;
const waiting = new Map();
// VAULT4: a call to the worker always settles — an answer, the worker's death, or a clock per operation: opening or
// creating the vault runs argon2 (64 MiB × 3) which a slow phone takes many seconds over; a fill waits on the host for
// up to 30 s (the worker's own fetch clock) and must outlive it, so the host's reason — not a generic clock — is what
// the owner reads. No card ever sits on "busy" forever, and a dropped worker's late answers are ignored.
const CALL_TIMEOUTS = { default: 60_000, unlock: 180_000, create: 180_000, fill: 45_000, fillField: 45_000, saveFields: 90_000 };
/** Test seam: one op's clock, or the default. */
export const _setCallTimeout = (ms, op = 'default') => { CALL_TIMEOUTS[op] = ms; };
const clockFor = (op) => CALL_TIMEOUTS[op] ?? CALL_TIMEOUTS.default;
// fixed phrases: never the worker's own message, an event's text or anything that could carry a value
const WORKER_DEAD = 'the vault worker stopped — unlock the vault again; nothing is known to have been filled';
const WORKER_UNREACHABLE = 'the vault worker could not be reached — unlock the vault again; nothing is known to have been filled';
const slow = (op, ms) => `the vault did not answer in ${Math.round(ms / 1000)} s (${op}) — unlock the vault again, or reload the cockpit; nothing is known to have been filled`;
function failAll(error) {
  for (const [id, w] of waiting) { waiting.delete(id); clearTimeout(w.timer); w.reject(new Error(error)); }
}
/** The worker crashed, froze or will not load: every waiting call fails, the vault counts as locked, the next call starts a new worker. */
function workerDied(why) {
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  failAll(why);
  setStatus({ unlocked: false });
}
let status = { loaded: false, exists: false, unlocked: false, count: 0 };
const subs = new Set();
const WINDOW_KEY = 'arigami.vault.windowMinutes';

function setStatus(next) {
  const was = status.unlocked;
  status = { ...status, ...next, loaded: true };
  // VAULT4: a grant lives only while the vault is open in this tab
  if (was && !status.unlocked) revokeAllGrants();
  for (const fn of subs) fn();
}
/** Test seams: the status a server render sees. */
export const _setVaultStatus = (s) => setStatus(s);
export const _status = () => status;

/** A message from worker `w` — taken only while `w` is still THE worker; a dropped worker's late word (even "unlocked") is not. */
function onWorkerMessage(w, ev) {
  if (w !== worker) return;
  const msg = ev.data || {};
  if (msg.type === 'status') {
    const s = Object.fromEntries(Object.entries(msg.status || {}).filter(([, v]) => v !== undefined));
    if (s.unlocked) s.exists = true;
    return setStatus(s);
  }
  const p = waiting.get(msg.id);
  if (!p) return;
  waiting.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(Object.assign(new Error(msg.error), { status: msg.status }));
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(new URL('./vault.worker.js', import.meta.url), { type: 'module' });
  worker = w;
  w.onmessage = (ev) => onWorkerMessage(w, ev);
  w.onerror = () => { if (w === worker) workerDied(WORKER_DEAD); };
  w.onmessageerror = () => { if (w === worker) workerDied(WORKER_DEAD); };
  const min = Number(localStorage.getItem(WINDOW_KEY));
  if (min) w.postMessage({ id: ++seq, op: 'setWindow', args: { minutes: min } });
  return w;
}

function call(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const ms = clockFor(op);
    // a worker that does not answer is not kept: this call fails, and so does every other one waiting on it; the next call starts afresh
    const timer = setTimeout(() => { if (waiting.has(id)) workerDied(slow(op, ms)); }, ms);
    waiting.set(id, { resolve, reject, timer });
    try {
      getWorker().postMessage({ id, op, args });
    } catch {
      // a worker that cannot be reached is gone: this call and every other one waiting fail, the vault counts as locked
      workerDied(WORKER_UNREACHABLE);
    }
  });
}

/** Crypto in the worker needs a secure context: https, or http://localhost. */
export const vaultSupported = () => typeof window !== 'undefined' && window.isSecureContext && typeof Worker !== 'undefined';

export async function refreshVault() {
  if (!vaultSupported()) return setStatus({ exists: false, unlocked: false, unsupported: true });
  const s = await call('status');
  setStatus({ error: null, ...s }); // a stale "could not be read" clears once the file answers
  return s;
}

const withStatus = (op) => async (args) => {
  const s = await call(op, args);
  if (s && typeof s === 'object' && 'unlocked' in s) setStatus(s);
  return s;
};

export const createVault = withStatus('create');
export const unlockVault = withStatus('unlock');
export const lockVault = withStatus('lock');
export const setVaultWindow = (minutes) => {
  localStorage.setItem(WINDOW_KEY, String(minutes));
  return withStatus('setWindow')({ minutes });
};
export const vaultWindowMinutes = () => Number(localStorage.getItem(WINDOW_KEY)) || 60;
export const listVault = () => call('list');
export const matchVault = (origin) => call('match', { origin });
export const removeVaultEntry = (id) => call('remove', { id });
/** Fill a pending sign-in request: `{sessionId, requestId, origin, fields, entryId?|values?, save, remember, auto}`. */
export const fillFromVault = (args) => call('fill', args);
// VAULT2: named fields. None of these returns a value to the page except `revealVaultField`, which the owner asks for
// by a click of their own on the Passwords page.
export const vaultEntry = (id) => call('entry', { id });
/** Create or update an entry: `{id?, origin, title?, username?, fields:[{name,type,value}], remove?:[names]}` → its description (names only). */
export const saveVaultFields = (args) => call('saveFields', args);
export const revealVaultField = (id, name) => call('reveal', { id, name });
/** Entries of the origin that hold `field`, narrowed by the agent's `entry` hint. */
export const matchVaultField = (origin, field, entry) => call('matchField', { origin, field, entry });
/** Fill ONE named field of a pending request: `{sessionId, requestId, origin, field, entryId?|value?, save, saveTo?, title?, remember, auto}`. */
export const fillVaultField = (args) => call('fillField', args);

export function useVault() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      if (!status.loaded) refreshVault().catch(() => setStatus({}));
      return () => subs.delete(fn);
    },
    () => status,
    () => status // a server render (tests, SSR) needs the snapshot too, or React throws "Missing getServerSnapshot"
  );
}
