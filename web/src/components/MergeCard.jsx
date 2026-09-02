// F7 — approval → merge. Two faces of one component:
//   <MergePanel session>   the live control: "Approved · not merged" + Merge
//                          button (strategy select, delete-branch checkbox),
//                          disabled with a reason when the host says it can't.
//   <MergeEvent event>     a `{kind:'merge'}` chat card (merged / conflict).
// The HOST executes the merge (POST /sessions/:id/merge) — never a claude turn.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { faCheck, faTriangleExclamation, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { useT } from '../lib/i18n.js';
import { toastSuccess, toastError } from '../lib/toast.js';
import { fmtDateTime } from '../lib/time.js';

const short = (sha) => (sha ? String(sha).slice(0, 7) : '');

// Header pill: "Approved · not merged" / "Merged <sha>" / "Merge conflict".
// Renders nothing when the session has no review state to show.
export function MergePill({ session, compact }) {
  const t = useT();
  const md = session?.metadata || {};
  if (md.merged) {
    return (
      <span title={`${md.merged.base || ''} · ${md.merged.at ? fmtDateTime(md.merged.at) : ''}`} className="flex shrink-0 items-center gap-1 rounded-full border border-[#8fcf9a] bg-[#e8f6ea] px-2 py-0.5 font-mono text-[9.5px] font-bold text-[#2a6b35]">
        <Icon icon={faCheck} /> {t('chat.mergeMerged', { sha: short(md.merged.sha) })}
      </span>
    );
  }
  if (md.mergeConflict && md.review?.state === 'approved') {
    return (
      <span title={(md.mergeConflict.files || []).join(', ')} className="flex shrink-0 items-center gap-1 rounded-full border border-[#d98078] bg-danger/10 px-2 py-0.5 font-mono text-[9.5px] font-bold text-danger">
        <Icon icon={faTriangleExclamation} /> {t('chat.mergeConflict')}
      </span>
    );
  }
  if (md.review?.state === 'approved' && md.branch) {
    return (
      <span title={md.review.by ? t('chat.mergeApprovedBy', { by: md.review.by }) : ''} className="flex shrink-0 items-center gap-1 rounded-full border border-[#e6d27a] bg-chip/60 px-2 py-0.5 font-mono text-[9.5px] font-bold text-fgdim">
        <Icon icon={faCheck} /> {compact ? t('chat.mergeApproved').split(' ')[0] : t('chat.mergeApproved')}
      </span>
    );
  }
  return null;
}

// Can this session be merged right now? Polls the host's merge/status while
// the panel is mounted (cheap: one git status). Returns {st, refresh}.
function useMergeStatus(sessionId, enabled) {
  const [st, setSt] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    api.get(`/sessions/${sessionId}/merge/status`).then((r) => { if (!stop) setSt(r); }).catch((e) => { if (!stop) setSt({ error: e?.message || String(e) }); });
    return () => { stop = true; };
  }, [sessionId, enabled, tick]);
  return { st, refresh: () => setTick((n) => n + 1) };
}

// The control. Shown for the human (and in the master's view of a child).
// `session` may be the wire form (metadata only) — everything else is fetched.
// `dark` = render on the terminal (chat) surface with the term accent vars.
export function MergePanel({ session, sessionId, onMerged, dense, dark }) {
  const t = useT();
  const id = sessionId || session?.id;
  const md = session?.metadata || {};
  const approved = md.review?.state === 'approved' && !!md.branch && !md.merged;
  const { st, refresh } = useMergeStatus(id, approved);
  const [strategy, setStrategy] = useState('no-ff');
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!approved) return null;

  const reason = st?.error ? st.error : st ? st.reason : null;
  const canMerge = !!st?.canMerge && !busy;
  const reasonText = reason ? (t(`chat.mergeReason.${reason}`) !== `chat.mergeReason.${reason}` ? t(`chat.mergeReason.${reason}`) : String(reason)) : '';

  const merge = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post(`/sessions/${id}/merge`, { strategy, deleteBranch: del });
      setResult(r);
      toastSuccess(t('chat.mergeDone', { branch: r.branch, base: r.base, sha: short(r.sha) }));
      onMerged?.(r);
    } catch (e) {
      // 409 bodies carry {conflict, files} or {error, reason} — surface them
      let body = null;
      try { body = JSON.parse(String(e?.message || '').replace(/^HTTP \d+ — /, '')); } catch {}
      if (body?.conflict) {
        setResult(body);
        toastError(t('chat.mergeConflictFiles', { files: (body.files || []).join(', ') }));
      } else {
        toastError(t('chat.mergeFailed', { err: body?.error || e?.message || e }));
      }
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const fg = dark ? 'text-[var(--term-accent-strong)]' : 'text-fg';
  const dim = dark ? 'text-[var(--term-accent-dim)]' : 'text-fgdim';
  const box = dark
    ? 'rounded-[10px] border border-[var(--term-accent-border)] bg-[var(--term-accent-bg)] px-3 py-2.5'
    : 'rounded-[9px] border-[1.5px] border-[#e6d27a] bg-chip/40 px-3 py-2';
  const field = dark
    ? 'rounded-[6px] border-[1.5px] border-[var(--term-accent-border)] bg-transparent px-1.5 py-0.5 font-mono text-[10px] text-[var(--term-accent-strong)]'
    : 'rounded-[6px] border-[1.5px] border-border bg-panel px-1.5 py-0.5 font-mono text-[10px] text-fg';
  return (
    <div data-merge-panel className={`my-2.5 flex flex-wrap items-center gap-2 ${dense ? '' : box}`}>
      {!dense && (
        <span className={`flex items-center gap-1.5 font-mono text-[11px] font-bold ${fg}`}>
          <Icon icon={faCheck} /> {t('chat.mergeInto', { branch: md.branch, base: st?.base || md.base || '…' })}
        </span>
      )}
      {!dense && md.review?.by && <span className={`font-mono text-[10px] ${dim}`}>{t('chat.mergeApprovedBy', { by: md.review.by })}</span>}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          disabled={busy}
          className={field}
        >
          <option value="no-ff">{t('chat.mergeStrategyNoFf')}</option>
          <option value="squash">{t('chat.mergeStrategySquash')}</option>
        </select>
        <label className={`flex cursor-pointer items-center gap-1 font-mono text-[10px] ${dim}`}>
          <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} disabled={busy} /> {t('chat.mergeDeleteBranch')}
        </label>
        <button
          type="button"
          onClick={merge}
          disabled={!canMerge}
          title={canMerge ? t('chat.mergeHint') : reasonText || t('chat.loading')}
          className="cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-3 py-1 text-[11.5px] font-bold text-[#1a1a1a] shadow-[2px_2px_0_#2a2a2a] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          {busy ? t('chat.merging') : t('chat.merge')}
        </button>
        <button type="button" onClick={refresh} disabled={busy} title={t('chat.mergeRefresh')} aria-label={t('chat.mergeRefresh')} className={`cursor-pointer rounded px-1 ${dim} hover:opacity-100 disabled:opacity-40`}>
          <Icon icon={faRotateRight} />
        </button>
      </span>
      {!canMerge && reasonText && !busy && (
        <span className="basis-full font-mono text-[10px] text-danger">{reasonText}</span>
      )}
      {result?.conflict && (
        <span className="basis-full font-mono text-[10px] text-danger">{t('chat.mergeConflictFiles', { files: (result.files || []).join(', ') })}</span>
      )}
      {!dense && <span className={`basis-full font-mono text-[9.5px] ${dim}`}>{t('chat.mergeHint')}</span>}
    </div>
  );
}

// A `{kind:'merge'}` chat event — the durable record in the child and the master.
export function MergeEvent({ event }) {
  const t = useT();
  const ok = event.state === 'merged';
  return (
    <div className={`my-2 rounded-[9px] border px-3 py-2 font-mono text-[11px] ${ok ? 'border-[#8fcf9a] bg-[#e8f6ea] text-[#2a6b35]' : 'border-[#d98078] bg-danger/10 text-danger'}`}>
      <div className="flex items-center gap-1.5 font-bold">
        <Icon icon={ok ? faCheck : faTriangleExclamation} /> {t('chat.mergeCardTitle')}
        {event.child && <span className="font-normal opacity-70">· {t('chat.mergeChild')} {event.child}</span>}
      </div>
      <div className="mt-0.5">
        {ok
          ? t('chat.mergeDone', { branch: event.branch, base: event.base, sha: short(event.sha) })
          : t('chat.mergeConflictFiles', { files: (event.files || []).join(', ') })}
      </div>
    </div>
  );
}
