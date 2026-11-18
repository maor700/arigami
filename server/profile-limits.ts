// Host-side caps for RESTRICTED sessions (S15: a loop that burns model quota). A profile's `limits`:
//
//   concurrent  sessions of that profile (by name) working at once, host-wide. A turn that would go over waits in
//               a host queue and starts when a slot frees — nothing is dropped, nothing runs beyond the cap.
//   spendUsd    model spend of one session TREE (the top restricted session and every descendant): claude's own
//               `total_cost_usd` at each turn end, plus a conservative estimate from the token usage streamed while a
//               turn is still running (so one endless turn cannot run past the cap unseen).
//   tokens      the same for engines that report no cost (codex): tokens of the whole tree.
//
// Going over a spend cap trips the tree: every session in it gets a `budget` error line in its chat, working ones
// are interrupted (killed if they keep going), queued turns are dropped, every further turn is refused (429), and
// the owner is alerted (notify: Web Push / the configured channels) — once per tree.
//
// Full sessions never reach any of this: every entry point returns at once for a session without a profile.
// The meters live in memory (a host restart starts them at zero); the alert is also one JSON line in
// $ARIGAMI_DIR/profile-limits.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import type { ProfileLimits, SessionProfile } from './session-profile.js';

type S = { id: string; engine?: string; archived?: boolean; title?: string; profile?: SessionProfile | null; claude?: { state?: string; model?: string | null; modelChoice?: string | null } | null };

export interface LimitsDeps {
  getSession(id: string): S | null;
  listSessions(): S[];
  /** Start a turn that was queued (claude.sendMessage with the gate already passed). */
  send(id: string, text: string, attachments: unknown[], opts: Record<string, unknown>): void;
  interrupt(id: string): void;
  kill(id: string): void;
  appendChat(id: string, ev: Record<string, unknown>): void;
  notify(p: { title: string; body: string; tag?: string; sessionId?: string }): void;
}
let deps: LimitsDeps | null = null;
export const wire = (d: LimitsDeps) => { deps = d; };

/**
 * Per-million-token USD for the in-turn estimate, by model family (list prices, rounded up). An unknown model is priced
 * as the dearest family, so the estimate errs on the side of stopping early; the engine's own figure replaces it at
 * every turn end, so the estimate only ever covers the turn still running.
 */
export const EST_PRICES: Record<string, { input: number; output: number; cacheCreation: number; cacheRead: number }> = {
  haiku: { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 },
  sonnet: { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  opus: { input: 5, output: 25, cacheCreation: 6.25, cacheRead: 0.5 },
  unknown: { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
};
export const priceFor = (model: string | null | undefined) => {
  const m = String(model || '').toLowerCase();
  return EST_PRICES[['haiku', 'sonnet', 'opus'].find((f) => m.includes(f)) || 'unknown'];
};

interface Meter { usd: number; est: number; tokens: number; lastTotal: number; msg: { id: string; tokens: number; est: number } | null }
const meters = new Map<string, Meter>();
const tripped = new Map<string, { at: number; why: string }>();
interface Queued { id: string; text: string; attachments: unknown[]; opts: Record<string, unknown>; at: number }
const queue: Queued[] = [];
const announced = new Set<string>();
let drainTimer: ReturnType<typeof setInterval> | null = null;

const meter = (id: string): Meter => {
  let m = meters.get(id);
  if (!m) meters.set(id, (m = { usd: 0, est: 0, tokens: 0, lastTotal: 0, msg: null }));
  return m;
};

/** The top restricted session above `s` (itself when its parent is not restricted or gone). */
export function rootOf(s: S, get: (id: string) => S | null): string {
  let cur = s;
  const seen = new Set<string>([s.id]);
  for (;;) {
    const pid = cur.profile?.parent;
    if (!pid || seen.has(pid)) return cur.id;
    const p = get(pid);
    if (!p?.profile) return cur.id;
    seen.add(pid);
    cur = p;
  }
}

/** Every session whose root is `root` (archived ones too: their spend counts). */
export function treeOf(root: string, all: S[], get: (id: string) => S | null): S[] {
  return all.filter((s) => s.profile && rootOf(s, get) === root);
}

export function estimateUsd(u: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }, model?: string | null): number {
  const p = priceFor(model);
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output +
    (u.cache_creation_input_tokens || 0) * p.cacheCreation + (u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
}

function spendOf(root: string): { usd: number; tokens: number; sessions: number } {
  const d = deps!;
  const tree = treeOf(root, d.listSessions(), d.getSession);
  let usd = 0, tokens = 0;
  for (const s of tree) {
    const m = meters.get(s.id);
    if (m) { usd += m.usd + m.est; tokens += m.tokens; }
  }
  return { usd, tokens, sessions: tree.length };
}

function capsOf(root: string): ProfileLimits | undefined {
  return deps?.getSession(root)?.profile?.limits;
}

/** `s` and its restricted ancestors, nearest first (the chain the host recorded; a Full parent ends it). */
function chainOf(s: S, get: (id: string) => S | null): S[] {
  const out: S[] = [s];
  const seen = new Set<string>([s.id]);
  for (let cur = s; ; ) {
    const pid = cur.profile?.parent;
    if (!pid || seen.has(pid)) return out;
    const p = get(pid);
    if (!p?.profile) return out;
    seen.add(pid);
    out.push((cur = p));
  }
}

/** Sessions at or below `top` (by the host-recorded parent chain). */
function subtreeOf(top: string): S[] {
  const d = deps!;
  return d.listSessions().filter((x) => x.profile && chainOf(x, d.getSession).some((a) => a.id === top));
}

/**
 * Every restricted ancestor that carries a spend cap (the session itself included) caps its own subtree — a child
 * that narrowed its parent's cap is held to its own, and can never escape the parent's.
 */
function check(id: string): void {
  if (!deps) return;
  const s = deps.getSession(id);
  if (!s?.profile) return;
  // top first: a trip there covers every subtree below it (one alert, not one per inherited copy of the cap)
  for (const a of chainOf(s, deps.getSession).reverse()) {
    if (tripped.has(a.id)) return;
    const caps = a.profile?.limits;
    if (!caps?.spendUsd && !caps?.tokens) continue;
    const tree = subtreeOf(a.id);
    let usd = 0, tokens = 0;
    for (const x of tree) { const m = meters.get(x.id); if (m) { usd += m.usd + m.est; tokens += m.tokens; } }
    const over = caps.spendUsd && usd >= caps.spendUsd ? `spend ~$${usd.toFixed(2)} ≥ cap $${caps.spendUsd}` : caps.tokens && tokens >= caps.tokens ? `${tokens} tokens ≥ cap ${caps.tokens}` : null;
    if (over) return trip(a.id, over, tree.length);
  }
}

function trip(root: string, why: string, sessions: number): void {
  const d = deps!;
  tripped.set(root, { at: Date.now(), why });
  const rootS = d.getSession(root);
  const profile = rootS?.profile?.name || 'restricted';
  const line = `[host] spend cap reached for this restricted session tree (profile "${profile}"): ${why}. Every session in it is stopped; further turns are refused.`;
  const tree = subtreeOf(root);
  const inTree = new Set(tree.map((x) => x.id));
  for (let i = queue.length - 1; i >= 0; i--) if (inTree.has(queue[i].id)) queue.splice(i, 1);
  for (const s of tree) {
    try { d.appendChat(s.id, { kind: 'error', text: line, isError: true, budget: true }); } catch {}
    if (s.claude?.state === 'working') {
      try { d.interrupt(s.id); } catch {}
      // an engine that keeps going after the interrupt is stopped outright
      setTimeout(() => { try { if (d.getSession(s.id)?.claude?.state === 'working') d.kill(s.id); } catch {} }, 15_000).unref?.();
    }
  }
  const alert = { ts: new Date().toISOString(), kind: 'spend-cap', root, profile, why, sessions };
  try { fs.appendFileSync(path.join(ARIGAMI_DIR, 'profile-limits.jsonl'), JSON.stringify(alert) + '\n'); } catch {}
  console.warn(`[limits] spend cap tripped: tree ${root} (profile ${profile}, ${sessions} session(s)): ${why}`);
  try { d.notify({ title: 'Restricted sessions stopped: spend cap', body: `${rootS?.title || root} (profile ${profile}): ${why}. ${sessions} session(s) stopped.`, tag: `spend-cap-${root}`, sessionId: root }); } catch {}
}


// ---- the engine hooks (claude.js noteTurnUsage / recordTurn — every engine) ---------------------------------------

/**
 * One assistant message's usage (streamed while the turn runs). Claude repeats a message's usage on every content
 * block of it (same message id): a repeat REPLACES that message's previous figures instead of adding to them.
 */
export function noteUsage(id: string, u: Record<string, number> | null | undefined, messageId?: string | null): void {
  if (!deps || !u) return;
  const s = deps.getSession(id);
  if (!s?.profile) return;
  const m = meter(id);
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  // an engine that reports no cost (codex) is capped by tokens only — its usage is not priced against spendUsd
  const est = s.engine !== 'codex' ? estimateUsd(u, s.claude?.model || s.claude?.modelChoice) : 0;
  if (messageId && m.msg?.id === messageId) {
    m.tokens -= m.msg.tokens;
    m.est = Math.max(0, m.est - m.msg.est);
  }
  m.tokens += tokens;
  m.est += est;
  m.msg = messageId ? { id: messageId, tokens, est } : null;
  check(id);
}

/** A turn's end. `totalCostUsd` = the engine process's running total (claude), null when it reports none (codex). */
export function noteResult(id: string, totalCostUsd: number | null | undefined): void {
  if (!deps) return;
  const s = deps.getSession(id);
  if (!s?.profile) return;
  const m = meter(id);
  if (typeof totalCostUsd === 'number' && Number.isFinite(totalCostUsd)) {
    const delta = totalCostUsd >= m.lastTotal ? totalCostUsd - m.lastTotal : totalCostUsd; // lower = a new process
    m.lastTotal = totalCostUsd;
    m.usd += delta;
    m.est = 0; // the engine's figure covers everything up to here
    m.msg = null;
  }
  check(id);
}

// ---- the turn gate (claude.js sendMessage) -------------------------------------------------------------------------

/** The concurrency bucket: the profile name at the top of the session's restricted chain. */
function bucketOf(s: S): string {
  const c = chainOf(s, deps!.getSession);
  return c[c.length - 1].profile?.name || 'restricted';
}

export type Admit = { ok: true } | { ok: false; queued: true; note: string } | { ok: false; queued: false; error: Error & { status?: number; budget?: unknown } };

/** May a new turn of `id` start now? Full sessions: always. */
export function admit(id: string): Admit {
  if (!deps) return { ok: true };
  const s = deps.getSession(id);
  if (!s?.profile) return { ok: true };
  const chain = chainOf(s, deps.getSession);
  const hit = chain.find((a) => tripped.has(a.id));
  if (hit) {
    const t = tripped.get(hit.id)!;
    const err = Object.assign(new Error(`restricted session tree stopped by its spend cap (${t.why}); no further turns`), { status: 429, budget: { root: hit.id, why: t.why } });
    return { ok: false, queued: false, error: err };
  }
  const cap = s.profile.limits?.concurrent;
  if (!cap || s.claude?.state === 'working') return { ok: true }; // already counted: a mid-turn message adds no slot
  // The bucket is the profile at the TOP of the tree: a child cannot leave it by naming its own (inline) profile.
  const bucket = bucketOf(s);
  const working = deps.listSessions().filter((x) => x.id !== id && !x.archived && x.profile && x.claude?.state === 'working' && bucketOf(x) === bucket).length;
  if (working < cap) return { ok: true };
  return { ok: false, queued: true, note: `[host] waiting for a free slot: ${working} session(s) of profile "${bucket}" are working (cap ${cap}). This turn starts by itself when one finishes.` };
}

export function enqueue(id: string, text: string, attachments: unknown[], opts: Record<string, unknown>, note: string): void {
  queue.push({ id, text, attachments, opts, at: Date.now() });
  try { deps?.appendChat(id, { kind: 'system', text: note }); } catch {}
  const s = deps?.getSession(id);
  if (s?.profile && !announced.has(s.profile.name)) {
    announced.add(s.profile.name);
    console.warn(`[limits] profile ${s.profile.name}: concurrency cap reached, turns are queued`);
  }
  if (!drainTimer) drainTimer = setInterval(drain, 2_000);
  (drainTimer as { unref?: () => void }).unref?.();
}

/** Start queued turns whose slot has freed (FIFO). */
export function drain(): void {
  if (!deps) return;
  for (let i = 0; i < queue.length; ) {
    const q = queue[i];
    const s = deps.getSession(q.id);
    if (!s || s.archived) { queue.splice(i, 1); continue; }
    const a = admit(q.id);
    if (a.ok) {
      queue.splice(i, 1);
      try { deps.send(q.id, q.text, q.attachments, { ...q.opts, admitted: true }); } catch (e) { console.error('[limits] queued turn failed:', (e as Error).message); }
      continue;
    }
    if (!a.queued) { queue.splice(i, 1); continue; } // tripped meanwhile
    i++;
  }
  if (!queue.length && drainTimer) { clearInterval(drainTimer); drainTimer = null; }
}

/** For GET /__api/sessions/<id>/policy (restricted sessions only). */
export function usageOf(id: string) {
  if (!deps) return null;
  const s = deps.getSession(id);
  if (!s?.profile) return null;
  const root = rootOf(s, deps.getSession);
  const sp = spendOf(root);
  return { root, caps: capsOf(root) || null, treeUsd: Math.round(sp.usd * 1e4) / 1e4, treeTokens: sp.tokens, sessions: sp.sessions, tripped: tripped.get(root) || null, queued: queue.filter((q) => q.id === id).length };
}

/** Test hook. */
export function _reset(): void {
  meters.clear(); tripped.clear(); queue.length = 0; announced.clear();
  if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
}
