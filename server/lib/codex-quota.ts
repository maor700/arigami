// P2-6 — codex quota recovery, the pure half: detection, rotation decision, model chain. IO lives in server/codex-recovery.ts.
import { effectiveChain, nextRung, rungOf, rungsLeft } from '../supervisor.js';

export const DEFAULT_CODEX_MODEL_CHAIN: readonly string[] = ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

// The turn's error text: `unexpected status <code>` is codex-cli's verified HTTP wrapper; the enum names are RateLimitReachedType's.
export const CODEX_LIMIT_RE =
  /unexpected status 429\b|rate_limit_reached|workspace_(?:owner|member)_(?:credits_depleted|usage_limit_reached)|\brate[ -]?limit(?:ed|s)?\b|\busage limit\b|\bquota\b|\bcredits? (?:depleted|exhausted)\b/i;
/** The subset specific enough to act on when the rateLimits read is unavailable (api-key login, probe failed). */
export const CODEX_LIMIT_STRONG_RE = /unexpected status 429\b|rate_limit_reached|workspace_(?:owner|member)_(?:credits_depleted|usage_limit_reached)|\busage limit\b/i;

export const looksLikeCodexLimit = (text: string): boolean => CODEX_LIMIT_RE.test(String(text || ''));

export interface UsageWindow { pct: number; resetsAt: string | null; windowMins?: number | null }
export interface UsageSnapshot { available: boolean; reason?: string; session?: UsageWindow | null; week?: UsageWindow | null; limitReached?: string | null }

export type Verdict = 'confirmed' | 'not-limited' | 'unknown';

/** Does `account/rateLimits/read` confirm the wall? resetAt = the exhausted window's reset (the later one when both are). */
export function confirmCodexLimit(u: UsageSnapshot | null | undefined): { verdict: Verdict; resetAt: string | null; pct: number | null } {
  if (!u?.available) return { verdict: 'unknown', resetAt: null, pct: null };
  const wins = [u.session, u.week].filter((w): w is UsageWindow => !!w && typeof w.pct === 'number');
  const full = wins.filter((w) => w.pct >= 100);
  const top = wins.reduce<UsageWindow | null>((a, w) => (!a || w.pct > a.pct ? w : a), null);
  if (!full.length && !u.limitReached) return { verdict: 'not-limited', resetAt: null, pct: top?.pct ?? null };
  const pick = (full.length ? full : top ? [top] : []).map((w) => w.resetsAt).filter((r): r is string => !!r).sort().pop() || null;
  return { verdict: 'confirmed', resetAt: pick, pct: top?.pct ?? null };
}

/** The chat note under a limit-looking error; "unverified" only when the rateLimits read could not confirm it. */
export function codexLimitNote(message: string, verdict: Verdict = 'unknown', pct: number | null = null): string | null {
  if (!looksLikeCodexLimit(message)) return null;
  const hint = message.match(/reset[s]?\s*(?:at|in|on)\s*[^,."')]+/i);
  const said = hint ? ` Codex said: "${hint[0]}".` : '';
  if (verdict === 'confirmed') return `⤷ Codex's quota ran out — confirmed by the account's rate limits${pct != null ? ` (${pct}% used)` : ''}.${said}`;
  if (verdict === 'not-limited')
    return `⤷ This error mentions a limit, but the account's rate limits are not exhausted${pct != null ? ` (${pct}% used)` : ''} — probably not a quota wall.${said}`;
  return `⤷ This looks like Codex's quota (rate limit / credits / usage limit) ran out, not a code error — unverified: the account's rate limits could not be read.${said}`;
}

export interface AccountLike { id: string; label?: string; provider?: string; pool?: boolean; quarantineUntil?: string | null }

/** Next pooled, available codex account other than `exceptId`. */
export function nextCodexAccount(accounts: AccountLike[], exceptId: string | null, now = Date.now()): AccountLike | null {
  return (
    accounts.find(
      (a) => a.provider === 'codex' && a.pool && a.id !== exceptId && (!a.quarantineUntil || Date.parse(a.quarantineUntil) <= now)
    ) || null
  );
}

export type RecoveryAction = 'none' | 'account-switch' | 'model-down' | 'escalate';

export interface RecoveryPlan {
  action: RecoveryAction;
  verdict: Verdict;
  /** when the current account's window resets — the quarantine end and the climb-back time */
  resetAt: string | null;
  pct: number | null;
  next?: AccountLike;
  model?: string;
  rung?: number;
}

/** One decision after a limit-looking codex turn failure. */
export function planCodexRecovery(input: {
  text: string;
  usage: UsageSnapshot | null;
  accounts: AccountLike[];
  curId: string | null;
  chain: string[];
  rung: number;
  now?: number;
  backoffMin?: number;
}): RecoveryPlan {
  const now = input.now ?? Date.now();
  const { verdict, resetAt: seen, pct } = confirmCodexLimit(input.usage);
  const base = { verdict, pct };
  if (!looksLikeCodexLimit(input.text)) return { action: 'none', resetAt: null, ...base };
  const act = verdict === 'confirmed' || (verdict === 'unknown' && CODEX_LIMIT_STRONG_RE.test(input.text));
  if (!act) return { action: 'none', resetAt: null, ...base };
  const resetAt = seen && Date.parse(seen) > now ? seen : new Date(now + Math.max(0.01, input.backoffMin ?? 60) * 60_000).toISOString();
  const next = nextCodexAccount(input.accounts, input.curId, now);
  if (next) return { action: 'account-switch', resetAt, next, ...base };
  const down = nextRung(input.chain, input.rung);
  if (down) return { action: 'model-down', resetAt, model: down.model, rung: down.rung, ...base };
  return { action: 'escalate', resetAt, ...base };
}

/** Codex chain: session override → agent (codex agents only) → config → default, filtered to the account's catalog; the picked model stays on top. */
export function codexChain(opts: { sessionChain?: unknown; agentChain?: unknown; configChain?: unknown; catalog?: string[]; modelChoice?: string | null }): string[] {
  const chain = effectiveChain({
    sessionChain: opts.sessionChain,
    agentChain: opts.agentChain,
    configChain: Array.isArray(opts.configChain) && opts.configChain.length ? opts.configChain : DEFAULT_CODEX_MODEL_CHAIN,
    modelChoice: opts.modelChoice,
  });
  const known = new Set(opts.catalog || []);
  if (!known.size) return chain;
  return chain.filter((m, i) => (i === 0 && m === (opts.modelChoice || '').trim()) || known.has(m));
}

/** Where a codex session sits in its chain (same shape as claude.js ladderState). */
export function codexLadder(chain: string[], claude: { modelRung?: number; modelChoice?: string | null; modelRestoreAt?: string | null } | null | undefined) {
  const stored = Number.isFinite(claude?.modelRung) ? Number(claude!.modelRung) : rungOf(chain, claude?.modelChoice);
  const rung = stored > 0 ? Math.min(stored, Math.max(0, chain.length - 1)) : 0;
  return { chain, rung, model: chain[rung] || claude?.modelChoice || null, rungsLeft: rungsLeft(chain, rung), restoreAt: claude?.modelRestoreAt || null };
}

// codex.ts registers its catalog here, so claude.js can read it without importing codex.ts (import cycle).
let catalogSource: () => string[] = () => [];
export const setCodexCatalogSource = (fn: () => string[]): void => { catalogSource = fn; };
export const codexCatalogIds = (): string[] => { try { return catalogSource(); } catch { return []; } };
