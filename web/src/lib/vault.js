// VAULT1 — the page side of the credential vault. The database itself lives in vault.worker.js; this file only
// passes requests to it and keeps a small status (exists / unlocked / how many entries) the sign-in card and
// Settings › Connections › Passwords render from. No value ever comes back to the page: the worker returns usernames
// and fill outcomes only.
import { useSyncExternalStore } from 'react';

let worker = null;
let seq = 0;
const waiting = new Map();
let status = { loaded: false, exists: false, unlocked: false, count: 0 };
const subs = new Set();
const WINDOW_KEY = 'arigami.vault.windowMinutes';

function setStatus(next) {
  status = { ...status, ...next, loaded: true };
  for (const fn of subs) fn();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./vault.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'status') {
      const s = Object.fromEntries(Object.entries(msg.status || {}).filter(([, v]) => v !== undefined));
      if (s.unlocked) s.exists = true;
      return setStatus(s);
    }
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(Object.assign(new Error(msg.error), { status: msg.status }));
  };
  const min = Number(localStorage.getItem(WINDOW_KEY));
  if (min) worker.postMessage({ id: ++seq, op: 'setWindow', args: { minutes: min } });
  return worker;
}

function call(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, op, args });
  });
}

/** Crypto in the worker needs a secure context: https, or http://localhost. */
export const vaultSupported = () => typeof window !== 'undefined' && window.isSecureContext && typeof Worker !== 'undefined';

export async function refreshVault() {
  if (!vaultSupported()) return setStatus({ exists: false, unlocked: false, unsupported: true });
  const s = await call('status');
  setStatus(s);
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
