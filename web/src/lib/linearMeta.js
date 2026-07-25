// Cached Linear reference data (labels, statuses, …) for the filter dropdowns.
//
// Same caching idiom as store.js/prefs.js (useSyncExternalStore) instead of a new
// dependency: a module-level cache with a TTL, in-flight dedupe, and cross-
// component sharing — so the ticket picker and the trigger tab don't each refetch,
// and reopening the launcher reuses fresh data.
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { api } from './api.js';

const TTL = 5 * 60 * 1000; // 5 min — reference data changes rarely
const EMPTY = [];

// Each key maps to a Linear list endpoint. Add new dynamic filter sources here.
const ENDPOINTS = {
  labels: '/linear/labels',
  statuses: '/linear/statuses',
};

const cache = {}; // key -> { data, ts }
const inflight = {}; // key -> Promise
const listeners = new Set();
const emit = () => {
  for (const fn of listeners) fn();
};

function ensure(key, force = false) {
  if (!ENDPOINTS[key]) return;
  const c = cache[key];
  if (!force && c && Date.now() - c.ts < TTL) return; // still fresh
  if (inflight[key]) return; // already loading
  inflight[key] = api
    .get(ENDPOINTS[key])
    .then((d) => {
      cache[key] = { data: Array.isArray(d) ? d : [], ts: Date.now() };
    })
    .catch(() => {
      cache[key] = { data: c?.data ?? EMPTY, ts: Date.now() }; // keep last good
    })
    .finally(() => {
      delete inflight[key];
      emit();
    });
}

// Subscribe to a cached list; fetches (once, shared) when `enabled` flips true.
export function useLinearList(key, enabled = true) {
  useEffect(() => {
    if (enabled) ensure(key);
  }, [key, enabled]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache[key]?.data ?? EMPTY,
    () => EMPTY,
  );
}

// Force a refresh of all reference data (e.g. after (re)connecting Linear).
export function refreshLinearMeta() {
  for (const k of Object.keys(ENDPOINTS)) ensure(k, true);
}
