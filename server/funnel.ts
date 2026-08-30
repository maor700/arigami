// K5 — the ONE funnel. Every product milestone worth measuring is emitted here
// and only here: the onboarding state machine (onboarding.ts → `onboarding.step`),
// and the first-time product events (`session.first`, `pm.first_tree`,
// `screen.first_request`, `skill.first_applied`, `artifact.first_publish`).
//
// Events are ALWAYS appended locally to $ARIGAMI_DIR/funnel.jsonl — one JSON
// object per line: {name, at, ...props}. Telemetry (D3, opt-in) reads this file
// and ships names + timestamps only; nothing here ever leaves the box by itself.
//
// firstTime(name) is idempotent across restarts: the set of names already
// emitted lives in $ARIGAMI_DIR/funnel-first.json.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';

export const FUNNEL_FILE = path.join(ARIGAMI_DIR, 'funnel.jsonl');
const FIRST_FILE = path.join(ARIGAMI_DIR, 'funnel-first.json');

export interface FunnelEvent {
  name: string;
  at: string; // ISO
  [k: string]: unknown;
}

type Hook = (ev: FunnelEvent) => void;
const hooks = new Set<Hook>();

/** D3 registers its shipper here; the wizard UI listens on the bus instead. */
export function onFunnel(hook: Hook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

function broadcastSafe(ev: FunnelEvent): void {
  // bus.js opens a WebSocketServer at import; keep it lazy so the CLI
  // (`bun server/onboarding.ts doctor`) and tests never touch it.
  import('./bus.js')
    .then((b: any) => b.broadcast({ type: 'funnel', event: ev }))
    .catch(() => {});
}

export function emit(name: string, props: Record<string, unknown> = {}, at?: string): FunnelEvent {
  const ev: FunnelEvent = { name, at: at || new Date().toISOString(), ...props };
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.appendFileSync(FUNNEL_FILE, JSON.stringify(ev) + '\n');
  } catch {
    /* a missing/readonly data dir must never break the caller */
  }
  for (const h of hooks) {
    try {
      h(ev);
    } catch {
      /* hooks are best-effort */
    }
  }
  if (process.env.ARIGAMI_FUNNEL_QUIET !== '1') broadcastSafe(ev);
  return ev;
}

function readFirst(): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(FIRST_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * When `install` is first recorded on a data dir that already has history
 * (the funnel-first file arrived with an upgrade), date it at the earliest
 * known event — or the data dir's birth time — so the funnel keeps its order
 * (F4 #5). Returns undefined for "now".
 */
export function backdatedInstallAt(events: FunnelEvent[] = readEvents(), dir = ARIGAMI_DIR, now = Date.now()): string | undefined {
  let earliest = Infinity;
  for (const e of events) {
    const t = Date.parse(String(e?.at || ''));
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (!Number.isFinite(earliest)) {
    try {
      const st = fs.statSync(dir);
      const b = st.birthtimeMs > 0 ? st.birthtimeMs : NaN;
      if (Number.isFinite(b)) earliest = b;
    } catch {}
  }
  return Number.isFinite(earliest) && earliest < now ? new Date(earliest).toISOString() : undefined;
}

/** Emit `name` once per instance lifetime. Returns true only the first time. */
export function firstTime(name: string, props: Record<string, unknown> = {}): boolean {
  const seen = readFirst();
  if (seen[name]) return false;
  const ev = emit(name, props, name === 'install' ? backdatedInstallAt() : undefined);
  seen[name] = ev.at;
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.writeFileSync(FIRST_FILE, JSON.stringify(seen, null, 2) + '\n');
  } catch {
    /* ignore */
  }
  return true;
}

export function hasHappened(name: string): boolean {
  return !!readFirst()[name];
}

/** Read back the local log (newest last). Used by tests, doctor and D3's "show what would be sent". */
export function readEvents(limit = 1000): FunnelEvent[] {
  try {
    const lines = fs.readFileSync(FUNNEL_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap((l) => {
      try {
        return [JSON.parse(l) as FunnelEvent];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
