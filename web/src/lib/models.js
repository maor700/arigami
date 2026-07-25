// Available Claude models for the model picker, sourced from the server's
// `/models` cache (itself sourced from the `claude` CLI's own model list — see
// server/models.js). Same caching idiom as linearMeta.js: a module-level cache
// shared across every open ModelModal, refetched lazily and on manual refresh.
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { api } from './api.js';

// Shown before the first successful fetch resolves (e.g. cockpit just started,
// server hasn't reached the CLI yet) so the picker never renders empty.
const FALLBACK = [
  { value: 'default', label: 'Default', desc: 'Use your Claude Code default model' },
];

let cache = { models: FALLBACK, fetchedAt: 0, loading: false, error: null };
let inflight = null;
const listeners = new Set();
const emit = () => {
  for (const fn of listeners) fn();
};

function toOptions(models) {
  return models.map((m) => ({ value: m.value, label: m.displayName || m.value, desc: m.description || '' }));
}

function run(promise) {
  cache = { ...cache, loading: true };
  emit();
  inflight = promise
    .then((d) => {
      cache = { models: d.models?.length ? toOptions(d.models) : cache.models, fetchedAt: d.fetchedAt || Date.now(), loading: false, error: d.error || null };
    })
    .catch((e) => {
      cache = { ...cache, loading: false, error: e.message };
    })
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

function ensure() {
  if (cache.fetchedAt || inflight) return;
  run(api.get('/models'));
}

export function refreshModels() {
  if (inflight) return inflight;
  return run(api.post('/models/refresh'));
}

export function useModels() {
  useEffect(ensure, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache,
    () => cache,
  );
}
