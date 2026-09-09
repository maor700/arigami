// The registry: which files under $ARIGAMI_DIR carry a schema version, what
// version this build writes, and how to get an older file up to it.
//
// Engine + rationale: ./schema-version.ts. Adding a file here is one entry plus
// two call sites in its owner module — `migrateFile(...)` before the boot read,
// and `stamp(...)` on the persist path (without the second, the owner's next
// write drops the field and the migration re-runs every boot).
//
// WHAT IS COVERED, and why these four:
//
//   state.json       sessions, listeners, folders — the irreplaceable one.
//   config.json      the human's host settings, hand-edited in practice.
//   triggers.json    cron/Linear triggers + the pending queue — losing it
//                    silently stops automations the human still believes run.
//   extensions.json  which extensions are on, their settings and secrets.
//
// WHAT IS DELIBERATELY NOT COVERED (see the task report for the full map):
//
//   *.jsonl (incidents, funnel, sms, webhooks) — append-only logs with no
//     whole-file document to stamp; a version would have to live per line.
//   Caches and derived state (skills-graph.json, models.json,
//     claude-update.json, telemetry.json, funnel-first.json, onboarding.json,
//     setup-pending.json, chrome-*/) — regenerated when absent or stale, so a
//     misread costs a recompute, not data.
//   children.json, run/ — pid bookkeeping, meaningful only while THIS host
//     process lives; a stale read is already handled by the hostId sweep.
//   Credential stores (accounts.json, users.json, sessions.json, share-*,
//     vapid-keys.json, linear-oauth.json, identity.json, mcp-connections.json,
//     webhooks.json) — durable and 0600. The engine handles them unchanged the
//     day one of them actually changes shape; stamping them now would mean
//     rewriting live secret files for no reason, which is the opposite of the
//     point.
import type { StateSchema, Doc } from './schema-version.js';

/**
 * state.json — v2.
 *
 * The 1→2 step is the proving migration: it exists to run the chain end to end
 * on a real installation (backup, transform, stamp) while a human is still
 * watching upgrades, before the updater starts applying them overnight. It is
 * not speculation about a future schema — it removes three per-session run
 * flags that only ever reach disk when the host is killed mid-flight, and that
 * `state.load()` has always deleted on read anyway. So: no behaviour changes,
 * nothing is lost, and re-running it on its own output is a no-op.
 */
const dropTransientRunFlags = (doc: Doc): Doc => {
  const sessions = Array.isArray(doc.sessions) ? doc.sessions : null;
  if (!sessions) return doc;
  return {
    ...doc,
    sessions: sessions.map((s) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
      const { changesExplaining: _a, autoReviewing: _b, summarizing: _c, ...rest } = s as Doc;
      return rest;
    }),
  };
};

export const STATE_SCHEMA: StateSchema = {
  name: 'state.json',
  version: 2,
  steps: [
    { to: 2, note: 'drop transient per-session run flags (state.load() already ignored them)', up: dropTransientRunFlags },
  ],
};

/** config.json — v1: existing files are already the shape this build writes. */
export const CONFIG_SCHEMA: StateSchema = { name: 'config.json', version: 1, steps: [] };

/** triggers.json — v1. */
export const TRIGGERS_SCHEMA: StateSchema = { name: 'triggers.json', version: 1, steps: [] };

/** extensions.json — v1. */
export const EXTENSIONS_SCHEMA: StateSchema = { name: 'extensions.json', version: 1, steps: [] };

/** Everything the host versions, for tests and for `bin/host` diagnostics. */
export const ALL_SCHEMAS: StateSchema[] = [STATE_SCHEMA, CONFIG_SCHEMA, TRIGGERS_SCHEMA, EXTENSIONS_SCHEMA];
