// Available Claude models for the model picker, sourced from the server's
// `/models` cache (itself sourced from the `claude` CLI's own model list — see
// server/models.js). Same caching idiom as linearMeta.js: a module-level cache
// shared across every open ModelModal, refetched lazily and on manual refresh.
//
// Revalidated, not fetched-once: a cockpit tab stays open for days, and the
// server only learns about a CLI update (= new models) when it is asked. So
// every mount of a picker past REVALIDATE_MS quietly re-asks the server, and
// a new model shows up the next time the picker opens instead of after a reload.
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { setCodexCatalog } from './engines.js';

// Shown before the first successful fetch resolves (e.g. cockpit just started,
// server hasn't reached the CLI yet) so the picker never renders empty.
const FALLBACK = [
  { value: 'default', label: 'Default', desc: 'Use your Claude Code default model' },
];

export const REVALIDATE_MS = 5 * 60 * 1000;

// `fetchedAt` is the SERVER's timestamp (when it last ran the CLI handshake);
// `checkedAt` is ours (when this tab last asked the server) — staleness is
// judged on the latter.
// `cliUpdate` (UPD1): {installed, latest, updateAvailable} of the `claude` CLI
// behind the list — the picker shows a badge when a newer CLI (= newer models)
// is waiting in Settings › Host.
// `codex` — the Codex catalog rows the same response carries (server/codex.ts
// codexModels(): the active codex account's models_cache.json). Handed to
// lib/engines.js setCodexCatalog() so the Codex picker lists what THAT login
// can run, not a transcribed default; null until the first fetch.
let cache = { models: FALLBACK, fetchedAt: 0, checkedAt: 0, loading: false, error: null, cliUpdate: null, codex: null };
let inflight = null;
const listeners = new Set();
const emit = () => {
  for (const fn of listeners) fn();
};

function toOptions(models) {
  return models.map((m) => ({ value: m.value, label: m.displayName || m.value, desc: m.description || '' }));
}

// `quiet` — a background revalidate: keep the list (and the refresh button)
// usable while it runs; only a real result changes what the picker shows.
function run(promise, { quiet = false } = {}) {
  if (!quiet) {
    cache = { ...cache, loading: true };
    emit();
  }
  inflight = promise
    .then((d) => {
      const codex = Array.isArray(d.codex) && d.codex.length ? d.codex : cache.codex;
      cache = { models: d.models?.length ? toOptions(d.models) : cache.models, fetchedAt: d.fetchedAt || Date.now(), checkedAt: Date.now(), loading: false, error: d.error || null, cliUpdate: d.cliUpdate === undefined ? cache.cliUpdate : d.cliUpdate, codex };
      setCodexCatalog(codex);
    })
    .catch((e) => {
      cache = { ...cache, checkedAt: Date.now(), loading: false, error: e.message };
    })
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

/** Fetch on first use; past REVALIDATE_MS, re-ask the server in the background. */
export function ensureModels(now = Date.now()) {
  if (inflight) return inflight;
  if (!cache.checkedAt) return run(api.get('/models'));
  if (now - cache.checkedAt >= REVALIDATE_MS) return run(api.get('/models'), { quiet: true });
  return null;
}

export function refreshModels() {
  if (inflight) return inflight;
  return run(api.post('/models/refresh'));
}

/** Current cache (for tests and non-React callers). */
export const modelsSnapshot = () => cache;

export function useModels() {
  useEffect(() => { ensureModels(); }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache,
    () => cache,
  );
}
