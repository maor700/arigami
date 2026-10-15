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
// OPENUI phase 2: a host library component; in the chat (dark) it sits on the
// shared CardFrame, in the Changes/Orchestration tabs it keeps its panel look.
function MergePanelView({ props: { session, sessionId, onMerged, onDismiss, dense, dark } }) {
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

  const fg = dark ? 'text-[var(--term-accent-strong)]' : 'text-foreground';
  const dim = dark ? 'text-[var(--term-accent-dim)]' : 'text-muted-foreground';
  const box = dark ? '' : 'rounded-lg border border-border bg-card px-3 py-2';
  // the chat (dark) face keeps native controls on the terminal palette; the
  // Changes/Orchestration face uses the ui kit
  const field = 'rounded-md border border-[var(--term-accent-border)] bg-transparent px-1.5 py-0.5 text-xs text-[var(--term-accent-strong)]';
  const Frame = dark && !dense ? CardFrame : 'div';
  const frameProps = dark && !dense ? { tone: 'accent', dense: true, className: 'flex flex-wrap items-center gap-2 !my-2.5' } : { className: `flex flex-wrap items-center gap-x-3 gap-y-2 ${dense ? 'my-0.5' : `my-2.5 ${box}`}` };
  const reasonCls = 'basis-full text-xs text-destructive';
  return (
    <Frame data-merge-panel="" {...frameProps}>
      {!dense && (
        <span className={`flex items-center gap-1.5 text-sm font-medium ${fg}`}>
          <CheckIcon className="size-4" /> <bdi dir="ltr" className="font-mono text-xs">{t('chat.mergeInto', { branch: md.branch, base: st?.base || md.base || '…' })}</bdi>
        </span>
      )}
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
          <Hint dark={dark} label={canMerge ? t('chat.mergeHint') : reasonText || t('chat.loading')}>
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
      {!dense && <span className={`basis-full text-2xs ${dim}`}>{t('chat.mergeHint')}</span>}
    </Frame>
  );
}
export const MergePanelDef = defineHostComponent({
  name: 'MergePanel',
  description: 'Host: approved → merge control (strategy, delete branch) — the host runs the merge',
  props: loose({ session: any, sessionId: str, onMerged: any, onDismiss: any, dense: bool, dark: bool }),
  component: MergePanelView,
});
export function MergePanel({ session, sessionId, onMerged, onDismiss, dense, dark }) {
  return <MergePanelView props={{ session, sessionId, onMerged, onDismiss, dense, dark }} />;
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
