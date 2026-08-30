// A3 — per-agent activity ledger with cost + the daily token budget.
//
// `$ARIGAMI_DIR/agents/<slug>/activity.jsonl` — one JSON line per event:
//   { ts, kind, sessionId?, tokens?, breakdown?, costUsd?, model?, detail?, … }
//   kind: 'session'  a session born from the agent was spawned (first spawn)
//         'turn'     a turn finished — tokens (input+output+cache) + cost delta
//         'action'   request_action (auto approved or answered by the human)
//         'artifact' publish_artifact
//         'policy'   a tool call the host denied (agent-policy.ts)
//         'budget'   the daily budget was hit (warning delivered)
//
// Tokens are the sum of every assistant message's usage in the turn
// (input + output + cache_creation + cache_read — what the account is billed
// for, in the same units Claude Code's own cost line uses). `costUsd` is the
// per-turn delta of the CLI's cumulative `total_cost_usd`.
//
// Budget: `agent.budget.tokensPerDay` vs the tokens of today's 'turn' lines,
// where "today" is the HOST's local calendar day (resets at local midnight).
// Exceeded → new sessions for the agent are refused (api.applyAgentToSession) and
// the running one gets ONE final warning (claude.js) to wrap up; after that
// warning every further turn is refused too (turnBlocked → claude.sendMessage).
import fs from 'node:fs';
import path from 'node:path';
import { agentDir, getAgent } from './agents.js';

export type ActivityKind = 'session' | 'turn' | 'action' | 'artifact' | 'policy' | 'budget';

export interface ActivityEntry {
  ts: string; // ISO
  kind: ActivityKind;
  sessionId?: string;
  tokens?: number;
  breakdown?: { input: number; output: number; cacheCreation: number; cacheRead: number };
  costUsd?: number;
  model?: string | null;
  detail?: string;
  [k: string]: unknown;
}

export const ledgerFile = (slug: string): string => path.join(agentDir(slug), 'activity.jsonl');

const MAX_READ_BYTES = 8 * 1024 * 1024; // the tail we ever parse (≈ tens of thousands of lines)

/** Local calendar day key `YYYY-MM-DD` (host timezone) — the budget window. */
export function localDay(ts: Date | string | number = new Date()): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start of the NEXT local day (when the budget resets). */
export function nextLocalMidnight(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

export function appendActivity(slug: string, entry: Omit<ActivityEntry, 'ts'> & { ts?: string }): ActivityEntry | null {
  if (!slug || !getAgent(slug)) return null; // never create a ledger for a deleted/unknown agent
  const e: ActivityEntry = { ts: entry.ts || new Date().toISOString(), ...entry } as ActivityEntry;
  try {
    fs.mkdirSync(agentDir(slug), { recursive: true });
    fs.appendFileSync(ledgerFile(slug), JSON.stringify(e) + '\n');
  } catch (err) {
    console.error('[ledger] append failed:', (err as Error).message);
    return null;
  }
  return e;
}

/** Every line (oldest first) — parses only the last MAX_READ_BYTES. */
export function readActivity(slug: string, opts: { since?: Date | string | number; kinds?: ActivityKind[] } = {}): ActivityEntry[] {
  let raw = '';
  try {
    const f = ledgerFile(slug);
    const st = fs.statSync(f);
    const fd = fs.openSync(f, 'r');
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
  const sinceMs = opts.since !== undefined ? new Date(opts.since).getTime() : -Infinity;
  const out: ActivityEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: ActivityEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || !e.ts || !e.kind) continue;
    if (new Date(e.ts).getTime() < sinceMs) continue;
    if (opts.kinds && !opts.kinds.includes(e.kind)) continue;
    out.push(e);
  }
  return out;
}

export interface Totals {
  tokens: number;
  costUsd: number;
  turns: number;
  sessions: number;
  actions: number;
  artifacts: number;
  denied: number;
}

export function totalsOf(entries: ActivityEntry[]): Totals {
  const t: Totals = { tokens: 0, costUsd: 0, turns: 0, sessions: 0, actions: 0, artifacts: 0, denied: 0 };
  for (const e of entries) {
    if (e.kind === 'turn') {
      t.turns++;
      t.tokens += Number(e.tokens) || 0;
      t.costUsd += Number(e.costUsd) || 0;
    } else if (e.kind === 'session') t.sessions++;
    else if (e.kind === 'action') t.actions++;
    else if (e.kind === 'artifact') t.artifacts++;
    else if (e.kind === 'policy') t.denied++;
  }
  t.costUsd = Math.round(t.costUsd * 1e6) / 1e6;
  return t;
}

/** `today` | `7d` | `30d` → the window start. */
export function rangeStart(range: string, now: Date = new Date()): Date {
  if (range === '7d' || range === '30d') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (range === '7d' ? 6 : 29));
    return d;
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Today's 'turn' lines only (local day). */
export function usedToday(slug: string, now: Date = new Date()): { tokens: number; costUsd: number; turns: number } {
  const day = localDay(now);
  const t = totalsOf(readActivity(slug, { since: rangeStart('today', now), kinds: ['turn'] }).filter((e) => localDay(e.ts) === day));
  return { tokens: t.tokens, costUsd: t.costUsd, turns: t.turns };
}

export interface BudgetState {
  slug: string;
  cap: number | null; // tokens/day, null = no cap
  usedTokens: number;
  usedCostUsd: number;
  exceeded: boolean;
  resetsAt: string; // ISO — next local midnight
}

export function budgetState(slug: string, now: Date = new Date()): BudgetState | null {
  const a = getAgent(slug);
  if (!a) return null;
  const cap = a.budget?.tokensPerDay && a.budget.tokensPerDay > 0 ? a.budget.tokensPerDay : null;
  const u = usedToday(slug, now);
  return {
    slug,
    cap,
    usedTokens: u.tokens,
    usedCostUsd: u.costUsd,
    exceeded: cap !== null && u.tokens >= cap,
    resetsAt: nextLocalMidnight(now).toISOString(),
  };
}

/**
 * A5 (#5) — was today's ONE final warning already delivered? Read from the ledger
 * (not from the claude proc record) so it survives a respawn or a host restart.
 */
export function warnedToday(slug: string, now: Date = new Date()): boolean {
  const day = localDay(now);
  return readActivity(slug, { since: rangeStart('today', now), kinds: ['budget'] }).some((e) => localDay(e.ts) === day);
}

/**
 * A5 (#5) — must a TURN be refused? The cap only gated new sessions, so messages
 * kept landing in an existing agent chat and the agent ran far past its cap. Once
 * the cap is crossed AND the final warning went out, every further turn is refused
 * until local midnight. Returns the state to quote, or null when the turn may run.
 */
export function turnBlocked(slug: string | null | undefined, now: Date = new Date()): BudgetState | null {
  if (!slug) return null;
  const b = budgetState(slug, now);
  return b?.exceeded && warnedToday(slug, now) ? b : null;
}

/**
 * The refusal line the human/model sees when a budget-exhausted agent is asked for
 * a new session OR another turn. English only (A5 #11: the UI localises it from
 * the structured `budget` body — no Hebrew inside an English string).
 */
export function budgetRefusal(b: BudgetState, name: string): string {
  const at = new Date(b.resetsAt);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `agent "${name}" hit its daily token budget (${b.usedTokens.toLocaleString('en-US')} / ${(b.cap || 0).toLocaleString('en-US')} tokens today) — no new sessions or turns until local midnight (${hhmm}); raise the cap in Settings → Host → Budgets`;
}
