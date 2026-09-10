// RES1 §2 — the incident log: `$ARIGAMI_DIR/incidents.jsonl`.
//
// Every automatic action the supervisor takes (and every automatic recovery
// claude.js already did on its own — account switch, auth refresh, model
// downgrade) writes one line here, next to the chat receipt in the affected
// session. Settings → Host → Health reads the last 24h of it, so "what did the
// host do while I was asleep" is answerable without grepping logs.
//
// Append-only JSONL, one bounded read (the tail we ever parse), and a size cap
// applied on append — the same shape as agent-ledger.ts, deliberately: no db, no
// migration, greppable by hand.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';

export const INCIDENTS_FILE = path.join(ARIGAMI_DIR, 'incidents.jsonl');

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // rotate to .1 past this

export interface Incident {
  ts: string; // ISO
  sessionId: string;
  /** The supervisor ActionKind, or a claude.js recovery ('account-switch'). */
  action: string;
  /** The health state that triggered it (RUNNING/BLOCKED_SYSTEM/…). */
  health?: string;
  reason?: string;
  /** 'ok' | 'failed' | 'escalated' — what actually happened. */
  outcome?: string;
  detail?: Record<string, unknown>;
}

function rotateIfBig(): void {
  try {
    const st = fs.statSync(INCIDENTS_FILE);
    if (st.size > MAX_FILE_BYTES) fs.renameSync(INCIDENTS_FILE, INCIDENTS_FILE + '.1');
  } catch {
    /* no file yet */
  }
}

export function appendIncident(entry: Omit<Incident, 'ts'> & { ts?: string }): Incident | null {
  const e: Incident = { ts: entry.ts || new Date().toISOString(), ...entry } as Incident;
  try {
    fs.mkdirSync(path.dirname(INCIDENTS_FILE), { recursive: true });
    rotateIfBig();
    fs.appendFileSync(INCIDENTS_FILE, JSON.stringify(e) + '\n');
  } catch (err) {
    console.error('[incidents] append failed:', (err as Error).message);
    return null;
  }
  // EXT: this file is the ONE neck every system incident passes through, so the
  // announcement belongs here rather than at each call site (they used to
  // broadcast separately, which would have delivered the same incident to an
  // extension hook twice). Same wire message as before — cockpit unaffected.
  try {
    const { broadcast } = require('./bus.js') as { broadcast: (m: unknown) => void };
    broadcast({ type: 'incident', sessionId: e.sessionId, action: e.action, outcome: e.outcome });
  } catch {}
  return e;
}

/** Incidents newer than `since` (default: the last 24h), oldest first. */
export function readIncidents(opts: { since?: Date | string | number; sessionId?: string } = {}): Incident[] {
  let raw = '';
  try {
    const st = fs.statSync(INCIDENTS_FILE);
    const fd = fs.openSync(INCIDENTS_FILE, 'r');
    try {
      const start = Math.max(0, st.size - MAX_READ_BYTES);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // drop a torn first line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const sinceMs =
    opts.since !== undefined ? new Date(opts.since).getTime() : Date.now() - 24 * 60 * 60_000;
  const out: Incident[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Incident;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e?.ts || !e.action) continue;
    if (new Date(e.ts).getTime() < sinceMs) continue;
    if (opts.sessionId && e.sessionId !== opts.sessionId) continue;
    out.push(e);
  }
  return out;
}

/** `{ [action]: count }` over a window — the "what did the host do" summary. */
export function summarize(entries: Incident[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const e of entries) by[e.action] = (by[e.action] || 0) + 1;
  return by;
}
