// F7 — approval → merge. Two faces of one component:
//   <MergePanel session>   the live control: "Approved · not merged" + Merge
//                          button (strategy select, delete-branch checkbox),
//                          disabled with a reason when the host says it can't.
//   <MergeEvent event>     a `{kind:'merge'}` chat card (merged / conflict).
// The HOST executes the merge (POST /sessions/:id/merge) — never a claude turn.
import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { CheckIcon, RotateCwIcon, XIcon, TriangleAlertIcon } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import { toastSuccess, toastError } from '../lib/toast.js';
import { fmtDateTime } from '../lib/time.js';
import { defineHostComponent, loose, str, any, bool, z } from '../openui/define.js';
import { CardFrame, Btn } from '../openui/primitives.jsx';
import { Badge, Button, Checkbox, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Tip } from './ui/index.js';

// The chat (dark) face renders outside the app's tooltip provider in tests and keeps
// native titles; the Changes face uses the kit tooltip.
const Hint = ({ dark, label, children }) => (dark ? React.cloneElement(children, { title: label }) : <Tip label={label}>{children}</Tip>);

const short = (sha) => (sha ? String(sha).slice(0, 7) : '');

// Header pill: "Approved · not merged" / "Merged <sha>" / "Merge conflict".
// Renders nothing when the session has no review state to show.
export function MergePill({ session, compact }) {
  const t = useT();
  const md = session?.metadata || {};
  if (md.merged) {
    return (
      <Badge status="ok" mono title={`${md.merged.base || ''} · ${md.merged.at ? fmtDateTime(md.merged.at) : ''}`}>
        <CheckIcon /> {t('chat.mergeMerged', { sha: short(md.merged.sha) })}
      </Badge>
    );
  }
  if (md.mergeConflict && md.review?.state === 'approved') {
    return (
      <Badge status="err" title={(md.mergeConflict.files || []).join(', ')}>
        <TriangleAlertIcon /> {t('chat.mergeConflict')}
      </Badge>
    );
  }
  if (md.review?.state === 'approved' && md.branch) {
    return (
      <Badge status="info" title={md.review.by ? t('chat.mergeApprovedBy', { by: md.review.by }) : ''}>
        <CheckIcon /> {compact ? t('chat.mergeApproved').split(' ')[0] : t('chat.mergeApproved')}
      </Badge>
    );
  }
  if (md.review?.state === 'changes-requested' && md.branch) {
    return (
      <Badge status="warn" title={t('chat.mergeReason.changes-requested')}>
        <TriangleAlertIcon /> {t('chat.mergeChangesRequested')}
      </Badge>
    );
  }
  return null;
}

// What the host says about approving/merging this session for THIS viewer
// (GET merge/status: {kind, mode, approved, base, pr, offer:{show, reason}}).
// Re-read when `key` changes; returns {st, refresh}.
export function useMergeStatus(sessionId, enabled, key = '') {
  const [st, setSt] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let stop = false;
    api.get(`/sessions/${sessionId}/merge/status`).then((r) => { if (!stop) setSt(r); }).catch((e) => { if (!stop) setSt({ error: e?.message || String(e) }); });
    return () => { stop = true; };
  }, [sessionId, enabled, tick, key]);
  return { st, refresh: () => setTick((n) => n + 1) };
}

// The control. Shown ONLY when the host says this viewer can merge now
// (status.offer.show): a local child branch the host can merge into its base,
// or the viewer's own PR they have merge rights on and GitHub calls mergeable.
// Otherwise, once approved, a passive line says why — no button.
// `session` may be the wire form (metadata only) — everything else is fetched.
// `dark` = render on the terminal (chat) surface with the term accent vars.
// `status`/`onRefresh`: a status the parent already holds (Changes tab).
// OPENUI phase 2: a host library component; in the chat (dark) it sits on the
// shared CardFrame, in the Changes/Orchestration tabs it keeps its panel look.
function MergePanelView({ props: { session, sessionId, onMerged, onDismiss, dense, dark, status, onRefresh } }) {
  const t = useT();
  const id = sessionId || session?.id;
  const md = session?.metadata || {};
  const approved = md.review?.state === 'approved' && !md.merged;
  const own = useMergeStatus(id, approved && !status, `${md.review?.at || ''}`);
  const st = status || own.st;
  const refresh = onRefresh || own.refresh;
  const [strategy, setStrategy] = useState('no-ff');
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!approved || !st) return null;

  const reasonOf = (reason) => (reason ? (t(`chat.mergeReason.${reason}`) !== `chat.mergeReason.${reason}` ? t(`chat.mergeReason.${reason}`) : String(reason)) : '');
  const fgP = dark ? 'text-[var(--term-dim)]' : 'text-muted-foreground';
  if (!st.offer?.show) {
    const why = st.error ? String(st.error) : reasonOf(st.offer?.reason);
    if (!why) return null;
    // passive: the approval stands, merging isn't something this viewer can do here
    return (
      <div data-merge-panel="" data-merge-passive={st.offer?.reason || 'error'} className={`flex items-center gap-1.5 text-xs ${fgP} ${dense ? 'my-0.5' : 'my-1.5'}`}>
        <CheckIcon className="size-3.5 shrink-0" />
        <span className="min-w-0" dir="auto">{t('chat.mergeUnavailable', { reason: why })}</span>
        <Hint dark={dark} label={t('chat.mergeRefresh')}>
          <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label={t('chat.mergeRefresh')} className={dark ? fgP : undefined}>
            <RotateCwIcon className="size-3.5" />
          </Button>
        </Hint>
        {onDismiss && (
          <Hint dark={dark} label={t('chat.mergeDismiss')}>
            <Button variant="ghost" size="icon-sm" data-merge-dismiss onClick={onDismiss} aria-label={t('chat.mergeDismiss')} className={dark ? fgP : undefined}>
              <XIcon className="size-3.5" />
            </Button>
          </Hint>
        )}
      </div>
    );
  }

  const isPr = st.kind === 'pr';
  const base = st.base || md.base || '…';
  const reason = st.reason;
  const canMerge = !!st.canMerge && !busy;
  const reasonText = reasonOf(reason);
  const hint = isPr ? t('chat.mergePrHint') : t('chat.mergeHint');
  const title = isPr ? t('chat.mergePrInto', { n: st.pr?.number, base }) : t('chat.mergeInto', { branch: md.branch, base });

  const merge = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post(`/sessions/${id}/merge`, { strategy, deleteBranch: del });
      setResult(r);
      toastSuccess(r.pr ? t('chat.mergePrDone', { n: r.pr, base: r.base }) : t('chat.mergeDone', { branch: r.branch, base: r.base, sha: short(r.sha) }));
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

  const fg = dark ? 'text-[var(--term-accent-strong)]' : 'text-foreground';
  const dim = dark ? 'text-[var(--term-accent-dim)]' : 'text-muted-foreground';
  const box = dark ? '' : 'rounded-lg border border-border bg-card px-3 py-2';
  // the chat (dark) face keeps native controls on the terminal palette; the
  // Changes/Orchestration face uses the ui kit
  const field = 'rounded-md border border-[var(--term-accent-border)] bg-transparent px-1.5 py-0.5 text-xs text-[var(--term-accent-strong)] coarse:min-h-11';
  const Frame = dark && !dense ? CardFrame : 'div';
  const frameProps = dark && !dense ? { tone: 'accent', dense: true, className: 'flex flex-wrap items-center gap-2 !my-2.5' } : { className: `flex flex-wrap items-center gap-x-3 gap-y-2 ${dense ? 'my-0.5' : `my-2.5 ${box}`}` };
  const reasonCls = 'basis-full text-xs text-destructive';
  return (
    <Frame data-merge-panel="" {...frameProps}>
      <span className={`flex items-center gap-1.5 font-medium ${dense ? 'text-xs' : 'text-sm'} ${fg}`} data-merge-target={base}>
        <CheckIcon className="size-4" /> <bdi dir="ltr" className="font-mono text-xs">{title}</bdi>
      </span>
      {!dense && md.review?.by && <span className={`text-xs ${dim}`}>{t('chat.mergeApprovedBy', { by: md.review.by })}</span>}
      <span className="ms-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        {dark ? (
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} disabled={busy} className={field}>
            <option value="no-ff">{t('chat.mergeStrategyNoFf')}</option>
            <option value="squash">{t('chat.mergeStrategySquash')}</option>
          </select>
        ) : (
          <Select value={strategy} onValueChange={setStrategy} disabled={busy}>
            <SelectTrigger className="h-7 w-auto text-xs" aria-label={t('chat.mergeStrategyNoFf')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="no-ff">{t('chat.mergeStrategyNoFf')}</SelectItem>
              <SelectItem value="squash">{t('chat.mergeStrategySquash')}</SelectItem>
            </SelectContent>
          </Select>
        )}
        <label className={`flex cursor-pointer items-center gap-2 text-xs ${dim} coarse:min-h-11`}>
          {dark ? (
            <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} disabled={busy} />
          ) : (
            <Checkbox checked={del} onCheckedChange={(v) => setDel(v === true)} disabled={busy} />
          )}
          {t('chat.mergeDeleteBranch')}
        </label>
        <span className="flex items-center gap-1.5">
          <Hint dark={dark} label={canMerge ? hint : reasonText || t('chat.loading')}>
            {/* span keeps the tooltip reachable while the button is disabled */}
            <span>
              {dark ? (
                <Btn variant="primary" className="!px-3 !py-1 disabled:cursor-not-allowed disabled:shadow-none" onClick={merge} disabled={!canMerge}>
                  {busy ? t('chat.merging') : t('chat.merge')}
                </Btn>
              ) : (
                <Button variant="primary" size="sm" onClick={merge} disabled={!canMerge} data-merge-button="">
                  {busy ? t('chat.merging') : t('chat.merge')}
                </Button>
              )}
            </span>
          </Hint>
          <Hint dark={dark} label={t('chat.mergeRefresh')}>
            <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={busy} aria-label={t('chat.mergeRefresh')} className={dark ? dim : undefined}>
              <RotateCwIcon className="size-3.5" />
            </Button>
          </Hint>
          {onDismiss && (
            <Hint dark={dark} label={t('chat.mergeDismiss')}>
              <Button variant="ghost" size="icon-sm" data-merge-dismiss onClick={onDismiss} disabled={busy} aria-label={t('chat.mergeDismiss')} className={dark ? dim : undefined}>
                <XIcon className="size-3.5" />
              </Button>
            </Hint>
          )}
        </span>
      </span>
      {!canMerge && reasonText && !busy && <span className={reasonCls}>{reasonText}</span>}
      {result?.conflict && <span className={reasonCls}>{t('chat.mergeConflictFiles', { files: (result.files || []).join(', ') })}</span>}
      <span className={`basis-full text-2xs ${dim}`} data-merge-hint="">{hint}</span>
    </Frame>
  );
}
export const MergePanelDef = defineHostComponent({
  name: 'MergePanel',
  description: 'Host: approved → merge control (strategy, delete branch) — the host runs the merge',
  props: loose({ session: any, sessionId: str, onMerged: any, onDismiss: any, dense: bool, dark: bool, status: any, onRefresh: any }),
  component: MergePanelView,
});
export function MergePanel({ session, sessionId, onMerged, onDismiss, dense, dark, status, onRefresh }) {
  return <MergePanelView props={{ session, sessionId, onMerged, onDismiss, dense, dark, status, onRefresh }} />;
}

// A `{kind:'merge'}` chat event — the durable record in the child and the master.
function MergeEventView({ props: { event } }) {
  const t = useT();
  const ok = event.state === 'merged';
  return (
    <CardFrame
      tone={ok ? 'ok' : 'danger'}
      data-merge-event={ok ? 'merged' : 'conflict'}
      className="!px-3 !py-2 text-xs"
      icon={ok ? <CheckIcon className="size-3.5" /> : <TriangleAlertIcon className="size-3.5" />}
      label={t('chat.mergeCardTitle')}
      meta={event.child && <span className="font-normal opacity-70">· {t('chat.mergeChild')} {event.child}</span>}
    >
      <div className="mt-0.5">
        {ok
          ? t('chat.mergeDone', { branch: event.branch, base: event.base, sha: short(event.sha) })
          : t('chat.mergeConflictFiles', { files: (event.files || []).join(', ') })}
      </div>
    </CardFrame>
  );
}
export const MergeEventDef = defineHostComponent({
  name: 'MergeEvent',
  description: 'Host: the durable merge record (merged / conflict)',
  props: loose({ event: loose({ state: str, branch: str, base: str, sha: str, files: any, child: str }) }),
  component: MergeEventView,
});
export function MergeEvent({ event }) {
  return <MergeEventView props={{ event }} />;
}
