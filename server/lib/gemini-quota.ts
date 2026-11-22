// Gemini quota recovery, the pure half: detection, the model chain, the decision. IO lives in server/gemini-recovery.ts.
// Measured 2026-11-22: every gemini-* model draws on ONE 5-hour bucket; Claude/GPT through Google have their own.
import { effectiveChain, nextRung, rungOf, rungsLeft } from '../supervisor.js';
import { confirmCodexLimit, type UsageSnapshot, type Verdict } from './codex-quota.js';
import { splitModelId } from './gemini-cli.js';

export const DEFAULT_GEMINI_MODEL_CHAIN: readonly string[] = ['gemini-4-neon', 'gemini-4-argon', 'gemini-3.8-flash'];

// Guesses — no quota wall or overload was reproduced against agy; the account's quota read is what confirms one.
export const GEMINI_QUOTA_RE = /\b429\b|RESOURCE_EXHAUSTED|\bquota\b|\brate[ -]?limit(?:ed|s)?\b|\busage limit\b|\bout of (?:credits|quota)\b/i;
/** One model is refusing work, whatever the account's quota says. */
export const GEMINI_UNAVAILABLE_RE = /\b503\b|\bUNAVAILABLE\b|\boverloaded\b|\bat capacity\b|model (?:is )?(?:temporarily |currently )?(?:not available|unavailable)/i;
/** The subset specific enough to act on when the quota read is unavailable. */
export const GEMINI_LIMIT_STRONG_RE = /\b429\b|RESOURCE_EXHAUSTED|\busage limit\b/i;

export const looksLikeGeminiLimit = (text: string): boolean => GEMINI_QUOTA_RE.test(String(text || '')) || GEMINI_UNAVAILABLE_RE.test(String(text || ''));

/** Does a model draw on Gemini's shared bucket? (Claude/GPT ids agy also serves do not.) */
export const sharesGeminiBucket = (model: string | null | undefined): boolean => /^gemini-/.test(String(model || ''));

const familyOf = (m: string | null | undefined): string => splitModelId(String(m || '').trim()).family;

/** Gemini chain of model FAMILIES: session override → agent (gemini agents only) → config → default, filtered to what the account is offered; the picked family stays on top. */
export function geminiChain(opts: { sessionChain?: unknown; agentChain?: unknown; configChain?: unknown; catalog?: string[]; modelChoice?: string | null }): string[] {
  const pick = familyOf(opts.modelChoice) || null;
  const chain = effectiveChain({
    sessionChain: opts.sessionChain,
    agentChain: opts.agentChain,
    configChain: Array.isArray(opts.configChain) && opts.configChain.length ? opts.configChain : DEFAULT_GEMINI_MODEL_CHAIN,
    modelChoice: pick,
  });
  const known = new Set(opts.catalog || []);
  if (!known.size) return chain;
  return chain.filter((m, i) => (i === 0 && m === pick) || known.has(m));
}

/** Where a gemini session sits in its chain (same shape as claude.js ladderState). */
export function geminiLadder(chain: string[], claude: { modelRung?: number; modelChoice?: string | null; modelRestoreAt?: string | null } | null | undefined) {
  const pick = familyOf(claude?.modelChoice) || null;
  const stored = Number.isFinite(claude?.modelRung) ? Number(claude!.modelRung) : rungOf(chain, pick);
  const rung = stored > 0 ? Math.min(stored, Math.max(0, chain.length - 1)) : 0;
  return { chain, rung, model: chain[rung] || pick, rungsLeft: rungsLeft(chain, rung), restoreAt: claude?.modelRestoreAt || null };
}

export type GeminiRecoveryAction = 'none' | 'model-down' | 'wait';

export interface GeminiRecoveryPlan {
  action: GeminiRecoveryAction;
  verdict: Verdict;
  /** when the bucket resets (confirmed), else a backoff — the climb-back time */
  resetAt: string | null;
  pct: number | null;
  model?: string;
  rung?: number;
}

/**
 * One decision after a limit-looking gemini turn failure. A spent bucket is not routed around by a lighter Gemini
 * model (they share it): only a rung outside the bucket helps, else the session waits for the reset. A model that
 * is merely unavailable steps one rung down.
 */
export function planGeminiRecovery(input: { text: string; usage: UsageSnapshot | null; chain: string[]; rung: number; now?: number; backoffMin?: number }): GeminiRecoveryPlan {
  const now = input.now ?? Date.now();
  const { verdict, resetAt: seen, pct } = confirmCodexLimit(input.usage);
  const base = { verdict, pct };
  if (!looksLikeGeminiLimit(input.text)) return { action: 'none', resetAt: null, ...base };
  const backoff = new Date(now + Math.max(0.01, input.backoffMin ?? 60) * 60_000).toISOString();
  if (verdict === 'confirmed') {
    const resetAt = seen && Date.parse(seen) > now ? seen : backoff;
    const out = input.chain.findIndex((m, i) => i > input.rung && !sharesGeminiBucket(m));
    return out > 0 ? { action: 'model-down', resetAt, model: input.chain[out], rung: out, ...base } : { action: 'wait', resetAt, ...base };
  }
  const act = GEMINI_UNAVAILABLE_RE.test(input.text) || (verdict === 'unknown' && GEMINI_LIMIT_STRONG_RE.test(input.text));
  if (!act) return { action: 'none', resetAt: null, ...base };
  const down = nextRung(input.chain, input.rung);
  return down ? { action: 'model-down', resetAt: backoff, model: down.model, rung: down.rung, ...base } : { action: 'none', resetAt: null, ...base };
}

/** The chat note under a limit-looking error; "unverified" only when the quota read could not confirm it. */
export function geminiLimitNote(message: string, verdict: Verdict = 'unknown', pct: number | null = null): string | null {
  if (!looksLikeGeminiLimit(message)) return null;
  if (verdict === 'confirmed') return `⤷ Gemini's 5-hour quota ran out — confirmed by the account's quota${pct != null ? ` (${pct}% used)` : ''}. Every Gemini model draws on the same quota.`;
  if (GEMINI_UNAVAILABLE_RE.test(message) && !GEMINI_QUOTA_RE.test(message)) return `⤷ This model is not taking requests right now${pct != null ? ` (the account's quota is at ${pct}%)` : ''} — not a code error.`;
  if (verdict === 'not-limited') return `⤷ This error mentions a limit, but the account's Gemini quota is not exhausted${pct != null ? ` (${pct}% used)` : ''} — probably a per-model limit, not the quota wall.`;
  return '⤷ This looks like a Gemini quota or rate limit, not a code error — unverified: the account\'s quota could not be read.';
}

// gemini-acp.ts registers what the account is offered, so claude.js can read it without importing the driver (import cycle).
let catalogSource: () => string[] = () => [];
export const setGeminiCatalogSource = (fn: () => string[]): void => { catalogSource = fn; };
export const geminiCatalogIds = (): string[] => { try { return catalogSource(); } catch { return []; } };
