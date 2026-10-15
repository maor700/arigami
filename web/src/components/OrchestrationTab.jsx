import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, FolderTreeIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { confirmDialog } from '../lib/confirm.js';
import { Truncate } from './Truncate.jsx';
import { MergePill, MergePanel } from './MergeCard.jsx';
import { Badge, Button, StatusDot } from './ui/index.js';
import { useT } from '../lib/i18n.js';
import { relTime } from '../lib/time.js';

// Built-in Orchestration tab (decision 18). Renders GET /sessions/:id/orchestration
// — the master's ORCHESTRATION.json plus bounded per-worker summaries. It NEVER
// reads a worker's chat (the one hard rule); everything here comes from the plan +
// metadata. List-first: a rollup header, a "Needs you" strip, then nodes grouped by
// state, with dep chips, a jump-to-worker link, the capped result, and per-node
// kill / retry controls.

// Neutral rows: the colour lives in the status dot only.
const STATE_STYLE = {
  running: { key: 'chat.stateRunning', dot: 'info' },
  ready: { key: 'chat.stateReady', dot: 'violet' },
  pending: { key: 'chat.statePending', dot: 'idle' },
  blocked: { key: 'chat.stateBlocked', dot: 'warn' },
  error: { key: 'chat.stateError', dot: 'err' },
  done: { key: 'chat.stateDone', dot: 'ok' },
  cancelled: { key: 'chat.stateCancelled', dot: 'idle' },
};
// Group order top-to-bottom — what needs attention first.
const GROUP_ORDER = ['blocked', 'error', 'running', 'ready', 'pending', 'done', 'cancelled'];

const jump = (id) =>
  window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id } }));

const WORKER_DOT = { working: 'ok', 'awaiting-input': 'warn', dead: 'err' };

function WorkerDot({ state }) {
  const t = useT();
  return <StatusDot status={WORKER_DOT[state] || 'idle'} pulse={state === 'awaiting-input'} title={state || t('chat.idle')} />;
}

// One node card: plan node + (optionally) the worker session that owns it.
function NodeCard({ node, worker, nodeStateById, masterId, onKill, onRetry }) {
  const t = useT();
  const result = worker?.result || null;
  const st = STATE_STYLE[node.state] || { dot: 'idle' };
  const when = relTime(result?.reportedAt);
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3" data-orch-node={node.id}>
      <div className="flex items-center gap-2">
        <StatusDot status={st.dot} pulse={node.state === 'blocked'} title={st.key ? t(st.key) : node.state} />
        <Truncate text={node.id} className="text-sm font-medium text-foreground" />
        {node.kind && <Badge mono>{node.kind}</Badge>}
        <span className="text-xs text-muted-foreground">{st.key ? t(st.key) : (node.state || '—')}</span>
        {when && <span className="ms-auto text-xs text-muted-foreground tabular-nums">{when}</span>}
      </div>
      {node.desc && <div className="mt-1 ps-3.5 text-sm leading-snug text-muted-foreground">{node.desc}</div>}

      {!!(node.deps && node.deps.length) && (
        <div className="mt-2 flex flex-wrap items-center gap-1 ps-3.5">
          <span className="me-1 text-xs text-muted-foreground">{t('chat.deps')}</span>
          {node.deps.map((d) => (
            <Badge key={d} variant="outline" status={nodeStateById[d] === 'done' ? 'ok' : undefined}>
              {nodeStateById[d] === 'done' && <CheckIcon />}
              {d}
            </Badge>
          ))}
        </div>
      )}

      {worker && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2.5">
          <WorkerDot state={worker.claude_state} />
          <Button variant="link" size="sm" className="max-w-64 text-sm" onClick={() => jump(worker.id)} title={`${t('chat.jumpToWorker')} · ${worker.id}`}>
            <Truncate text={worker.title || worker.id} /> <span className="rtl:-scale-x-100">→</span>
          </Button>
          {worker.branch && <Badge mono><bdi dir="ltr" className="truncate">{worker.branch}</bdi></Badge>}
          <MergePill session={{ metadata: { branch: worker.branch, review: worker.review, merged: worker.merged } }} compact />
          <span className="ms-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => onRetry(node)} disabled={!masterId} title={masterId ? t('chat.retryNode') : t('chat.noMaster')}>
              {t('chat.retry')}
            </Button>
            {worker.claude_state !== 'dead' && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onKill(worker)}>
                {t('chat.kill')}
              </Button>
            )}
          </span>
        </div>
      )}

      {result && (
        <div className="mt-2.5 border-s border-border ps-3">
          {result.note && <div className="text-sm font-medium text-foreground">{result.note}</div>}
          {result.summary && (
            <div className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {result.summary}
            </div>
          )}
          {!!(result.artifacts && result.artifacts.length) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {result.artifacts.map((a, i) => (
                <Badge key={i} variant="outline" mono><bdi dir="ltr" className="truncate">{a.kind}: {a.ref || a.path}</bdi></Badge>
              ))}
            </div>
          )}
        </div>
      )}
      {/* F7: the master's one-click merge of an approved child */}
      {worker && worker.review?.state === 'approved' && !worker.merged && (
        <div className="mt-2.5 border-t border-border pt-2">
          <MergePanel sessionId={worker.id} session={{ id: worker.id, metadata: { branch: worker.branch, review: worker.review, merged: worker.merged } }} dense />
        </div>
      )}
    </div>
  );
}

function GroupHeader({ dot, label, count }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <StatusDot status={dot} />
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export default function OrchestrationTab({ session, active }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/sessions/${session.id}/orchestration`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message || t('chat.failedLoadOrch'));
    }
  }, [session.id]);

  // Poll while the tab is open — workers report asynchronously.
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(load, 3500);
    return () => clearInterval(t);
  }, [active, load]);

  const kill = async (worker) => {
    const ok = await confirmDialog({
      title: t('chat.killWorkerQ', { id: worker.id }),
      body: t('chat.killWorkerCleanup'),
      confirmLabel: t('chat.killWorkerConfirm'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/sessions/${worker.id}?runCleanup=true`);
      toastSuccess(t('chat.killedWorker', { id: worker.id }));
      load();
    } catch (e) {
      toastError(t('chat.killFailed', { err: e.message }));
    }
  };

  // Retry is a master decision — nudge the master session to re-launch the node.
  const retry = async (node) => {
    try {
      await api.post(`/sessions/${session.id}/message`, {
        text: `Please retry orchestration node "${node.id}" — relaunch its worker (kill the old one with cleanup first if it's still around), per the dispatch protocol.`,
      });
      toastSuccess(t('chat.nudgedRetry', { id: node.id }));
    } catch (e) {
      toastError(t('chat.retryNudgeFailed', { err: e.message }));
    }
  };

  if (!data && !error)
    return <div className="p-6 text-sm text-muted-foreground">{t('chat.loadingOrch')}</div>;
  if (error)
    return <div className="flex items-center gap-2 p-6 text-sm text-destructive"><TriangleAlertIcon className="size-4" /> {error}</div>;

  const plan = data.plan || null;
  const nodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const nodeStateById = Object.fromEntries(nodes.map((n) => [n.id, n.state]));
  const childById = new Map((data.children || []).map((c) => [c.id, c]));
  const childBySubtask = new Map((data.children || []).filter((c) => c.subtask).map((c) => [c.subtask, c]));
  const workerFor = (n) => (n.worker && childById.get(n.worker)) || childBySubtask.get(n.id) || null;

  // Workers with no matching plan node (e.g. an integration worker, or a plan not
  // written yet) — surfaced so nothing the host knows about is hidden.
  const claimed = new Set();
  for (const n of nodes) {
    const w = workerFor(n);
    if (w) claimed.add(w.id);
  }
  const orphans = (data.children || []).filter((c) => !claimed.has(c.id));

  // Group nodes by state.
  const byGroup = new Map();
  for (const n of nodes) {
    const g = STATE_STYLE[n.state] ? n.state : 'pending';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(n);
  }
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g));

  // ---- rollup: how far along, and what is waiting on a person --------------
  const rollTotal = nodes.length || (data.children || []).length;
  const rollDone = nodes.length
    ? nodes.filter((n) => n.state === 'done').length
    : (data.children || []).filter((c) => c.result?.state === 'done').length;
  const rollCounts = groups.map((g) => [g, byGroup.get(g).length]);
  const needs = [];
  const seen = new Set();
  const pushNeed = (id, title, reasonKey, reason) => { if (!seen.has(id)) { seen.add(id); needs.push({ id, title, reasonKey, reason }); } };
  for (const n of nodes) {
    const w = workerFor(n);
    if (n.state === 'blocked' || n.state === 'error') pushNeed(w?.id || n.id, n.id, STATE_STYLE[n.state].key, w?.result?.note || n.desc || '');
    else if (w?.claude_state === 'awaiting-input') pushNeed(w.id, n.id, 'screen.needsYou', '');
  }
  for (const c of orphans) {
    if (c.claude_state === 'awaiting-input') pushNeed(c.id, c.subtask || c.title || c.id, 'screen.needsYou', '');
    else if (c.result?.state === 'blocked') pushNeed(c.id, c.subtask || c.title || c.id, 'chat.stateBlocked', c.result?.note || '');
  }

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-background" data-orchestration="">
      {/* header */}
      <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderTreeIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Truncate text={plan?.task || session.title || t('chat.orchestration')} className="block text-base font-semibold text-foreground" />
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              {plan?.base && <span>{t('chat.base')} <bdi dir="ltr" className="font-mono text-2xs">{plan.base}</bdi> ·</span>}
              <span>{t((data.children || []).length === 1 ? 'chat.workerCountOne' : 'chat.workerCountMany', { n: (data.children || []).length })}</span>
              {plan && <span>· {t(nodes.length === 1 ? 'chat.nodeCountOne' : 'chat.nodeCountMany', { n: nodes.length })}</span>}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RotateCwIcon className="size-3.5" /> {t('chat.refreshCap')}
          </Button>
        </div>
        {rollTotal > 0 && (
          <div className="mt-3" data-orch-rollup="">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-foreground tabular-nums">{t('chat.orchProgress', { done: rollDone, total: rollTotal })}</span>
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={rollTotal} aria-valuenow={rollDone}>
                <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-300" style={{ width: `${Math.round((rollDone / rollTotal) * 100)}%` }} />
              </div>
            </div>
            {rollCounts.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {rollCounts.map(([g, n]) => (
                  <span key={g} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot status={STATE_STYLE[g].dot} /> {t(STATE_STYLE[g].key)} <span className="tabular-nums text-foreground">{n}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {data.planError && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> <span>{data.planError} {t('chat.showingLiveWorkers')}</span>
        </div>
      )}

      <div className="space-y-5 p-4">
        {needs.length > 0 && (
          <section data-needs-you="">
            <GroupHeader dot="warn" label={t('screen.needsYou')} count={needs.length} />
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {needs.map((n, i) => (
                <div key={n.id} className={`flex min-h-11 items-center gap-2 px-3.5 py-2 ${i ? 'border-t border-border' : ''}`}>
                  <StatusDot status="warn" pulse />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-foreground">{n.title}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{t(n.reasonKey)}</span>
                    {n.reason && <span className="block truncate text-xs text-muted-foreground">{n.reason}</span>}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => jump(n.id)} title={t('chat.jumpToWorker')}>{t('chat.orchOpen')}</Button>
                </div>
              ))}
            </div>
          </section>
        )}

        {groups.map((g) => (
          <section key={g}>
            <GroupHeader dot={STATE_STYLE[g].dot} label={t(STATE_STYLE[g].key)} count={byGroup.get(g).length} />
            <div className="space-y-2">
              {byGroup.get(g).map((n) => (
                <NodeCard
                  key={n.id}
                  node={n}
                  worker={workerFor(n)}
                  nodeStateById={nodeStateById}
                  masterId={session.id}
                  onKill={kill}
                  onRetry={retry}
                />
              ))}
            </div>
          </section>
        ))}

        {orphans.length > 0 && (
          <section>
            <GroupHeader dot="idle" label={plan ? t('chat.otherWorkers') : t('chat.workers')} count={orphans.length} />
            <div className="space-y-2">
              {orphans.map((c) => (
                <NodeCard
                  key={c.id}
                  node={{
                    id: c.subtask || c.title || c.id,
                    desc: '',
                    kind: c.kind,
                    state: c.result?.state === 'done' ? 'done' : c.claude_state === 'dead' ? 'error' : 'running',
                    deps: [],
                  }}
                  worker={c}
                  nodeStateById={nodeStateById}
                  masterId={session.id}
                  onKill={kill}
                  onRetry={retry}
                />
              ))}
            </div>
          </section>
        )}

        {!nodes.length && !orphans.length && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('chat.noWorkers')}
          </div>
        )}
      </div>
    </div>
  );
}
