// Context window resolution for `claude --model <id>` values.
//
// The `claude` CLI enforces its own client-side table for models it
// recognizes; for one it doesn't, it picks a conservative window and says so
// ("… is not a model this version of Claude Code recognizes, so auto-compact
// will keep this session within N tokens (the context window it assumes)"),
// pointing at CLAUDE_CODE_MAX_CONTEXT_TOKENS or its `modelOverrides` setting
// to fix it (strings in the 2.1.251 binary). `modelOverrides` itself maps an
// unrecognized id to a *provider* id (e.g. a Bedrock ARN) — it does not carry
// a token count — so there's nothing to read the window from there; this
// mirrors the same idea with our own settings knob instead.
//
// KNOWN_WINDOWS below is ground truth measured on this host with the CLI
// itself (`claude -p "/context" --model <id>`, reading the "**Tokens:** X / Y"
// line), not guessed from naming conventions — re-verify the same way before
// changing an entry:
//   claude-sonnet-5            → 1,000,000  (no [1m] tag needed)
//   claude-sonnet-5[1m]        → 1,000,000
//   claude-opus-5              → 1,000,000
//   claude-fable-5             → 1,000,000
//   claude-fable-5-1           → 1,000,000  (family match; 5.1 shipped 2026-09)
//   claude-haiku-4-5-20251001  →   200,000
import { cfg } from '../state.js';

export const CONSERVATIVE_UNKNOWN_WINDOW = 200_000;

// Ordered families; first match wins. `sonnet-5` must precede the bare
// `sonnet` fallback so older sonnet generations (200k, unless tagged [1m])
// don't get swept into the new 1M default.
const KNOWN_WINDOWS: Array<{ re: RegExp; window: number }> = [
  { re: /sonnet-5\b/i, window: 1_000_000 },
  { re: /\bopus\b/i, window: 1_000_000 },
  { re: /\b(fable|mythos)\b/i, window: 1_000_000 },
  { re: /\bhaiku\b/i, window: 200_000 },
  { re: /\bsonnet\b/i, window: 200_000 },
];

export type CtxWindowSource = 'override' | 'tag' | 'table' | 'default';

export interface CtxWindowResult {
  window: number;
  assumed: boolean;
  source: CtxWindowSource;
}

function envOverride(): number | null {
  const n = Number(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Resolution order: per-model override (settings, then env) > explicit [1m]
// tag > known-model table > conservative default (flagged `assumed` so the UI
// can say so instead of silently claiming a number we don't actually know).
export function resolveCtxWindow(model?: string | null): CtxWindowResult {
  const m = String(model || '').toLowerCase();

  const override = (m && cfg.ctxWindowOverrides?.[m]) || envOverride();
  if (override) return { window: override, assumed: false, source: 'override' };

  if (m.includes('[1m]')) return { window: 1_000_000, assumed: false, source: 'tag' };

  for (const { re, window } of KNOWN_WINDOWS) {
    if (re.test(m)) return { window, assumed: false, source: 'table' };
  }

  return { window: CONSERVATIVE_UNKNOWN_WINDOW, assumed: true, source: 'default' };
}
