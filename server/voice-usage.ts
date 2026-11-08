// Voice usage ledger + monthly caps (docs/VOICE.md): counters per provider per month, never decremented.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import { cfg } from './lib/config.js';

export const USAGE_FILE = path.join(ARIGAMI_DIR, 'voice-usage.json');

// Prices in USD from PLAN.md (2026-11-04); estimates only, the provider's invoice is the truth.
export const OPENAI_REALTIME_USD_PER_MIN = 0.1; // gpt-realtime-2, midpoint of $0.05–0.15
export const OPENAI_TTS_USD_PER_1K_CHARS = 0.015; // OpenAI list price (not in PLAN.md)
export const GEMINI_LIVE_USD_PER_MIN = 0.023; // Gemini Live (PLAN.md)
export const ELEVENLABS_USD_PER_1K_CHARS = 0.04;
export const CARTESIA_USD_PER_1K_CHARS = 0.055; // midpoint of $0.045–0.065
export const DEEPGRAM_USD_PER_MIN = 0.0092; // Nova-3
export const TWILIO_INBOUND_USD_PER_MIN = 0.0107; // Israel, inbound
export const TWILIO_OUTBOUND_USD_PER_MIN = 0.0646; // Israel, outbound to mobile
export const TWILIO_SMS_USD = 0.2575; // Israel, per outbound SMS segment (PLAN.md)

export interface Usage {
  seconds?: number;
  chars?: number;
  usd?: number; // a known amount wins over the estimate
  inbound?: boolean; // telephony direction
}
export interface Counter {
  seconds: number;
  chars: number;
  usd: number;
  calls: number;
}
export type BudgetState = 'ok' | 'soft-stopped';

export function estimateUsd(provider: string, u: Usage): number {
  const min = (u.seconds || 0) / 60;
  const k = (u.chars || 0) / 1000;
  switch (provider) {
    case 'voice:openai': return min * OPENAI_REALTIME_USD_PER_MIN + k * OPENAI_TTS_USD_PER_1K_CHARS;
    case 'voice:gemini': return min * GEMINI_LIVE_USD_PER_MIN;
    case 'voice:elevenlabs': return k * ELEVENLABS_USD_PER_1K_CHARS;
    case 'voice:cartesia': return k * CARTESIA_USD_PER_1K_CHARS;
    case 'voice:deepgram': return min * DEEPGRAM_USD_PER_MIN;
    case 'telephony:twilio': return min * (u.inbound ? TWILIO_INBOUND_USD_PER_MIN : TWILIO_OUTBOUND_USD_PER_MIN);
    default: return 0;
  }
}

export const monthKey = (d = new Date()): string => d.toISOString().slice(0, 7);

type Ledger = Record<string, Record<string, Counter>>;
function readLedger(): Ledger {
  try {
    const j = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
function writeLedger(l: Ledger): void {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  const tmp = `${USAGE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
  fs.renameSync(tmp, USAGE_FILE);
}
const zero = (): Counter => ({ seconds: 0, chars: 0, usd: 0, calls: 0 });

/** Add one call's usage to this month's counter for `provider`. Never throws. */
export function recordVoiceUsage(provider: string, u: Usage = {}): Counter {
  try {
    const l = readLedger();
    const m = (l[monthKey()] ||= {});
    const c = (m[provider] ||= zero());
    c.seconds += Math.max(0, Number(u.seconds) || 0);
    c.chars += Math.max(0, Number(u.chars) || 0);
    c.usd += Math.max(0, typeof u.usd === 'number' && Number.isFinite(u.usd) ? u.usd : estimateUsd(provider, u));
    c.calls += 1;
    writeLedger(l);
    return { ...c };
  } catch (e) {
    console.error('[voice-usage]', (e as Error).message);
    return zero();
  }
}

export const capUsd = (provider: string): number | null => {
  const v = cfg.voice?.caps?.[provider];
  return typeof v === 'number' && v > 0 ? v : null;
};

/** This month's counters, with the cap and state per provider that has one or was used. */
export function voiceUsageThisMonth(): Record<string, Counter & { capUsd: number | null; state: BudgetState }> {
  const m = readLedger()[monthKey()] || {};
  const ids = new Set([...Object.keys(m), ...Object.keys(cfg.voice?.caps || {})]);
  const out: Record<string, Counter & { capUsd: number | null; state: BudgetState }> = {};
  for (const id of ids) out[id] = { ...(m[id] || zero()), capUsd: capUsd(id), state: voiceBudgetState(id) };
  return out;
}

/** 'soft-stopped' once this month's estimate reached the provider's cap; callers fall back to text. Never throws. */
export function voiceBudgetState(provider: string): BudgetState {
  try {
    const cap = capUsd(provider);
    if (cap === null) return 'ok';
    const used = readLedger()[monthKey()]?.[provider]?.usd || 0;
    return used >= cap ? 'soft-stopped' : 'ok';
  } catch {
    return 'ok';
  }
}
