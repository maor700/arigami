// Available Claude models for the session model picker, sourced from the
// `claude` CLI's own `initialize` control-handshake (the same list `/model`
// shows) — see server/claude.js's mergeCaps for the live-session equivalent.
// This is a standalone, throwaway handshake (no session/worktree/MCP attached)
// so the picker works even for a fresh cockpit with no sessions running yet.
//
// Cached to disk once/day; a manual refresh (UI button) bypasses the TTL.
// Persistence: ~/.arigami/models.json, independent of state.json.
//
// The cache is also keyed on the `claude` CLI version: the model list ships
// with the CLI, so an upgrade is exactly when it goes stale. Without that key a
// day-old cache keeps advertising the previous release's models (and hides new
// ones) until the TTL lapses or someone hits refresh.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './state.js';
import { supervise } from './lib/children.js';

const STORE = path.join(cfg.configDir, 'models.json');
const TTL_MS = 24 * 60 * 60 * 1000; // once/day
const HANDSHAKE_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_TTL_MS = 60_000; // re-probe at most once a minute
const CLAUDE_BIN = process.env.ARIGAMI_CLAUDE_BIN || 'claude';

let cache = { models: [], fetchedAt: 0, cliVersion: null };
let inflight = null;
let verCache = { value: null, at: 0 };

// `claude --version` → "2.1.241 (Claude Code)" → "2.1.241". ~120ms, memoised for
// a minute. Resolves null (never rejects) if the probe fails, which callers read
// as "can't tell" — the cache is then left alone rather than thrown away.
function cliVersion() {
  if (verCache.value && Date.now() - verCache.at < VERSION_TTL_MS) return Promise.resolve(verCache.value);
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        console.error('[models] version probe failed:', err.message);
        return resolve(null);
      }
      const v = String(stdout).trim().split(/\s+/)[0] || null;
      verCache = { value: v, at: Date.now() };
      resolve(v);
    });
  });
}

(function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (Array.isArray(j.models)) cache = j;
  } catch {}
})();

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[models] persist failed:', e.message);
  }
}

// One-shot: spawn `claude`, send the `initialize` control_request, resolve with
// its `response.models` list, then kill the process. Mirrors the control_request
// shape server/claude.js writes on every session spawn (see mergeCaps there).
function fetchFromCli() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.ARIGAMI_CLAUDE_BIN || 'claude',
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--print', ''],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    supervise(child, 'models-handshake');
    let settled = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error('timed out waiting for claude initialize handshake'));
    }, HANDSHAKE_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const models = j?.type === 'control_response' && j.response?.response?.models;
        if (Array.isArray(models) && !settled) {
          settled = true;
          clearTimeout(timer);
          try { child.kill(); } catch {}
          resolve(models);
        }
      }
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`claude exited ${code} before reporting models`));
    });
    try {
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'req_1', request: { subtype: 'initialize' } }) + '\n');
    } catch (e) {
      reject(e);
    }
  });
}

// Cached model list. Refetched when `force`, when the 24h TTL lapses, or when
// the `claude` CLI version no longer matches the one the cache was built from
// (including a pre-versioning cache, which has no `cliVersion` at all). Never
// throws — falls back to the last known-good cache on fetch failure.
export async function getModels(force = false) {
  if (!force && cache.models.length && Date.now() - cache.fetchedAt < TTL_MS) {
    const ver = await cliVersion();
    // ver === null → probe failed, so we can't prove staleness; serve the cache.
    if (!ver || ver === cache.cliVersion) return cache;
    console.log(`[models] claude ${cache.cliVersion || '(unknown)'} → ${ver}, refetching model list`);
  }
  if (inflight) return inflight;
  inflight = fetchFromCli()
    .then(async (models) => {
      cache = { models, fetchedAt: Date.now(), cliVersion: await cliVersion() };
      persist();
      return cache;
    })
    .catch((e) => {
      console.error('[models] fetch failed:', e.message);
      cache = { ...cache, error: e.message };
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
