// P2-6 — codex quota recovery, the IO half: confirm via account/rateLimits/read, rotate the codex pool, else the codex model ladder.
import { getSession } from './state.js';
import { cfg } from './lib/config.js';
import { getAccount, getActiveId, listAccounts, quarantine, setActive } from './accounts.js';
import { codexLimitNote, looksLikeCodexLimit, planCodexRecovery, type RecoveryPlan, type UsageSnapshot } from './lib/codex-quota.js';

const inflight = new Map<string, Promise<RecoveryPlan | null>>();

/** Test seam: resolves when the recovery started for `id` has finished. */
export const settled = (id: string): Promise<RecoveryPlan | null> => inflight.get(id) || Promise.resolve(null);

/** A codex turn failed with `text`: confirm, note, and recover. One run per session at a time. */
export function onCodexLimit(id: string, text: string): Promise<RecoveryPlan | null> {
  if (!looksLikeCodexLimit(text)) return Promise.resolve(null);
  const cur = inflight.get(id);
  if (cur) return cur;
  const p = recover(id, text)
    .catch((e) => {
      console.error('[codex-recovery]', id, (e as Error).message);
      return null;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function readUsage(accountId: string | null): Promise<UsageSnapshot | null> {
  if (!accountId || getAccount(accountId)?.provider !== 'codex') return null;
  try {
    const m = await import('./codex-account.js');
    return await m.codexUsage(accountId);
  } catch {
    return null;
  }
}

async function recover(id: string, text: string): Promise<RecoveryPlan | null> {
  const claude: any = await import('./claude.js');
  const s = getSession(id);
  if (!s || s.engine !== 'codex') return null;
  const lastMsg: string | null = claude.lastUserMessage(id);
  const pinned = s.claude?.accountId;
  const curId = pinned && getAccount(pinned)?.provider === 'codex' ? pinned : getActiveId('codex');
  const usage = await readUsage(curId);
  const ladder = claude.ladderState(id);
  const plan = planCodexRecovery({
    text,
    usage,
    accounts: (listAccounts().accounts as any[]).filter((a) => a.provider === 'codex'),
    curId,
    chain: ladder.chain,
    rung: ladder.rung,
    backoffMin: cfg.supervisor?.modelBackoffMin,
  });
  const note = codexLimitNote(text, plan.verdict, plan.pct);
  if (note) claude.appendChat(id, { kind: 'system', text: note });
  if (plan.action === 'none') return plan;
  const detail = { verdict: plan.verdict, resetAt: plan.resetAt, engine: 'codex' };
  if (curId) try { quarantine(curId, plan.resetAt); } catch {}
  if (plan.action === 'account-switch' && plan.next) {
    const from = getAccount(curId || '')?.label || curId || 'account';
    claude.appendChat(id, { kind: 'system', text: `⤷ ${from} hit its Codex limit — switched to “${plan.next.label}” and retrying…` });
    try { setActive(plan.next.id); } catch {}
    try {
      claude.setAccount(id, plan.next.id);
    } catch (e) {
      claude.recordCodexIncident(id, 'account-switch', { ...detail, error: (e as Error).message }, 'failed', 'account limit');
      return plan;
    }
    claude.recordCodexIncident(id, 'account-switch', { ...detail, from, to: plan.next.label }, 'ok', 'account limit');
    const t = setTimeout(() => { try { if (lastMsg) claude.sendMessage(id, lastMsg); } catch {} }, 900);
    if (t.unref) t.unref();
    return plan;
  }
  if (plan.action === 'model-down') {
    const r = claude.downgradeCodexModel(id, { resetAt: plan.resetAt, lastMsg });
    if (r.ok) claude.recordCodexIncident(id, 'model-down', { ...detail, from: r.from, to: r.model }, 'ok', 'all accounts limited');
    return plan;
  }
  claude.appendChat(id, {
    kind: 'error',
    text: 'Every Codex account has hit its limit and the Codex model ladder is at its bottom rung. Add another Codex account, or wait for one to reset.',
  });
  claude.recordCodexIncident(id, 'escalate', { ...detail, after: 'model-ladder' }, 'escalated', 'bottom rung, no quota left');
  return plan;
}
