// Gemini quota recovery, the IO half: confirm against the account's quota, then a rung that can still run — or say when the quota resets.
import { getSession } from './state.js';
import { cfg } from './lib/config.js';
import { getActiveId, quarantine } from './accounts.js';
import { geminiLimitNote, looksLikeGeminiLimit, planGeminiRecovery, type GeminiRecoveryPlan } from './lib/gemini-quota.js';
import type { UsageSnapshot } from './lib/codex-quota.js';

const inflight = new Map<string, Promise<GeminiRecoveryPlan | null>>();

/** Test seam: resolves when the recovery started for `id` has finished. */
export const settled = (id: string): Promise<GeminiRecoveryPlan | null> => inflight.get(id) || Promise.resolve(null);

type Deps = { usage?: () => Promise<UsageSnapshot | null> };

/** A gemini turn failed with `text`: confirm, note, and recover. One run per session at a time. */
export function onGeminiLimit(id: string, text: string, deps: Deps = {}): Promise<GeminiRecoveryPlan | null> {
  if (!looksLikeGeminiLimit(text)) return Promise.resolve(null);
  const cur = inflight.get(id);
  if (cur) return cur;
  const p = recover(id, text, deps)
    .catch((e) => {
      console.error('[gemini-recovery]', id, (e as Error).message);
      return null;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function readUsage(): Promise<UsageSnapshot | null> {
  try {
    return (await (await import('./gemini-account.js')).geminiUsage({ force: true })) as UsageSnapshot;
  } catch {
    return null;
  }
}

const localTime = (iso: string | null): string => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'later';
};

async function recover(id: string, text: string, deps: Deps): Promise<GeminiRecoveryPlan | null> {
  const claude: any = await import('./claude.js');
  const s = getSession(id);
  if (!s || s.engine !== 'gemini') return null;
  const lastMsg: string | null = claude.lastUserMessage(id);
  const usage = await (deps.usage || readUsage)();
  const ladder = claude.ladderState(id);
  const plan = planGeminiRecovery({ text, usage, chain: ladder.chain, rung: ladder.rung, backoffMin: cfg.supervisor?.modelBackoffMin });
  const note = geminiLimitNote(text, plan.verdict, plan.pct);
  if (note) claude.appendChat(id, { kind: 'system', text: note });
  if (plan.action === 'none') return plan;
  const detail = { verdict: plan.verdict, resetAt: plan.resetAt, engine: 'gemini' };
  // A confirmed wall marks the account limited until the bucket resets (the cockpit's account card, the supervisor's view).
  const account = getActiveId('gemini');
  if (plan.verdict === 'confirmed' && account) try { quarantine(account, plan.resetAt); } catch { /* no such account */ }
  if (plan.action === 'model-down' && plan.model != null && plan.rung != null) {
    const why = plan.verdict === 'confirmed' ? "Gemini's quota is used up" : 'the model is not taking requests';
    const r = claude.downgradeGeminiModel(id, { resetAt: plan.resetAt, lastMsg, why, to: { model: plan.model, rung: plan.rung } });
    if (r.ok) claude.recordCodexIncident(id, 'model-down', { ...detail, from: r.from, to: r.model }, 'ok', why);
    return plan;
  }
  claude.appendChat(id, {
    kind: 'error',
    text: `Gemini's 5-hour quota is used up and resets around ${localTime(plan.resetAt)}. Every Gemini model draws on the same quota, so a lighter one would not help — send the message again after the reset, or switch this work to another engine.`,
  });
  claude.recordCodexIncident(id, 'escalate', { ...detail, after: 'shared-quota' }, 'escalated', 'quota used up, no rung outside it');
  return plan;
}
