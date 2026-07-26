import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { confirmDialog } from '../lib/confirm.js';
import { Truncate } from './Truncate.jsx';
import { Icon } from '../lib/icons.js';
import { useT } from '../lib/i18n.js';
import { faCheck, faFolderTree, faRotateRight, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';

// Built-in Orchestration tab (decision 18). Renders GET /sessions/:id/orchestration
// — the master's ORCHESTRATION.json plus bounded per-worker summaries. It NEVER
// reads a worker's chat (the one hard rule); everything here comes from the plan +
// metadata. List-first: nodes grouped by state, with dep chips, a jump-to-worker
// link, the capped result, and per-node kill / retry controls.

const STATE_STYLE = {
  running: { key: 'chat.stateRunning', color: '#CE8324' },
  ready: { key: 'chat.stateReady', color: '#2C6BD6' },
  pending: { key: 'chat.statePending', color: '#8a8a8a' },
  blocked: { key: 'chat.stateBlocked', color: '#B23B30' },
  error: { key: 'chat.stateError', color: '#B23B30' },
  done: { key: 'chat.stateDone', color: '#3C9A4E' },
  cancelled: { key: 'chat.stateCancelled', color: '#8a8a8a' },
};
// Group order top-to-bottom — what needs attention first.
const GROUP_ORDER = ['blocked', 'error', 'running', 'ready', 'pending', 'done', 'cancelled'];

const jump = (id) =>
  window.dispatchEvent(new CustomEvent('host:select-session', { detail: { id } }));

function StatePill({ state }) {
  const t = useT();
  const st = STATE_STYLE[state] || { color: '#8a8a8a' };
  const label = st.key ? t(st.key) : (state || '—');
  return (
    <span
      className="flex h-[18px] shrink-0 items-center rounded-[4px] border px-1.5 font-mono text-[10px] font-bold"
      style={{ color: st.color, borderColor: st.color }}
    >
      {label.toLowerCase()}
    </span>
  );
}

function Chip({ children, color }) {
  return (
    <span
      className="inline-flex items-center rounded-[4px] border px-1.5 py-px font-mono text-[10px]"
      style={{ color: color || '#8a8a8a', borderColor: color || '#d8d4cc' }}
    >
      {children}
    </span>
  );
}

function ClaudeDot({ state }) {
  const t = useT();
  const color =
    state === 'working'
      ? '#3C9A4E'
      : state === 'awaiting-input'
        ? '#F9D312'
        : state === 'dead'
          ? '#B23B30'
          : '#c4c4c4';
  return (
    <span
      title={state || t('chat.idle')}
      className={`h-[7px] w-[7px] shrink-0 rounded-full ${state === 'awaiting-input' ? 'pulse-yellow' : ''}`}
      style={{ background: color }}
    />
  );
}

// One node card: plan node + (optionally) the worker session that owns it.
function NodeCard({ node, worker, nodeStateById, masterId, onKill, onRetry }) {
  const t = useT();
  const result = worker?.result || null;
  return (
    <div className="rounded-[9px] border-[1.5px] border-border bg-panel px-3 py-2.5">
      <div className="flex items-start gap-2">
        <StatePill state={node.state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Truncate text={node.id} className="font-mono text-[11.5px] font-bold text-fg" />
            {node.kind && <Chip color={node.kind === 'mutating' ? '#6A4FC4' : '#1F9C82'}>{node.kind}</Chip>}
          </div>
          {node.desc && <div className="mt-0.5 text-[12px] leading-snug text-fgdim">{node.desc}</div>}
        </div>
      </div>

      {!!(node.deps && node.deps.length) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="font-mono text-[9.5px] tracking-wide text-fgdim uppercase">{t('chat.deps')}</span>
          {node.deps.map((d) => (
            <Chip key={d} color={nodeStateById[d] === 'done' ? '#3C9A4E' : '#B23B30'}>
              {nodeStateById[d] === 'done' ? <><Icon icon={faCheck} />{' '}</> : ''}
              {d}
            </Chip>
          ))}
        </div>
      )}

      {worker && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hair pt-2">
          <ClaudeDot state={worker.claude_state} />
          <button
            type="button"
            onClick={() => jump(worker.id)}
            title={t('chat.jumpToWorker')}
            className="cursor-pointer font-mono text-[10.5px] text-[#2C6BD6] hover:underline"
          >
            → {worker.id}
          </button>
          {worker.branch && <Chip>{worker.branch}</Chip>}
          {worker.claude_state !== 'dead' && (
            <button
              type="button"
              onClick={() => onKill(worker)}
              className="cursor-pointer rounded-[5px] border border-border px-2 py-0.5 text-[10.5px] text-danger hover:border-danger"
            >
              {t('chat.kill')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onRetry(node)}
            disabled={!masterId}
            title={masterId ? t('chat.retryNode') : t('chat.noMaster')}
            className="cursor-pointer rounded-[5px] border border-border px-2 py-0.5 text-[10.5px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-40"
          >
            {t('chat.retry')}
          </button>
        </div>
      )}

      {result && (
        <div className="mt-2 rounded-[7px] bg-chip/50 px-2.5 py-1.5">
          {result.note && <div className="text-[11.5px] font-bold text-fg">{result.note}</div>}
          {result.summary && (
            <div className="mt-0.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fgdim">
              {result.summary}
            </div>
          )}
          {!!(result.artifacts && result.artifacts.length) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {result.artifacts.map((a, i) => (
                <Chip key={i}>{a.kind}: {a.ref || a.path}</Chip>
              ))}
            </div>
          )}
        </div>
      )}
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
    return <div className="p-6 text-[12px] text-fgdim">{t('chat.loadingOrch')}</div>;
  if (error)
    return <div className="p-6 text-[12px] text-danger"><Icon icon={faTriangleExclamation} /> {error}</div>;

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

  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-bg">
      {/* header */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel px-4 py-2.5">
        <span className="text-[13px]"><Icon icon={faFolderTree} /></span>
        <div className="min-w-0 flex-1">
          <Truncate
            text={plan?.task || session.title || t('chat.orchestration')}
            className="text-[12.5px] font-bold text-fg"
          />
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-fgdim">
            {plan?.base && <span>{t('chat.base')} {plan.base}</span>}
            <span>· {t((data.children || []).length === 1 ? 'chat.workerCountOne' : 'chat.workerCountMany', { n: (data.children || []).length })}</span>
            {plan && <span>· {t(nodes.length === 1 ? 'chat.nodeCountOne' : 'chat.nodeCountMany', { n: nodes.length })}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          className="cursor-pointer rounded-[6px] border border-border px-2 py-1 text-[11px] text-fgdim hover:border-ink hover:text-fg"
        >
          <Icon icon={faRotateRight} /> {t('chat.refreshCap')}
        </button>
      </div>

      {data.planError && (
        <div className="mx-4 mt-3 rounded-[8px] border border-[#e6d27a] bg-chip/60 px-3 py-2 text-[11.5px] text-fgdim">
          {data.planError} {t('chat.showingLiveWorkers')}
        </div>
      )}

      <div className="space-y-4 p-4">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 flex items-center gap-[7px]">
              <span
                className="font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase"
                style={{ color: STATE_STYLE[g].color }}
              >
                {t(STATE_STYLE[g].key)}
              </span>
              <span className="font-mono text-[9.5px] text-fgdim">{byGroup.get(g).length}</span>
              <span className="h-px flex-1 bg-hair" />
            </div>
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
          </div>
        ))}

        {orphans.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-[7px]">
              <span className="font-mono text-[9.5px] font-bold tracking-[0.06em] text-fgdim uppercase">
                {plan ? t('chat.otherWorkers') : t('chat.workers')}
              </span>
              <span className="font-mono text-[9.5px] text-fgdim">{orphans.length}</span>
              <span className="h-px flex-1 bg-hair" />
            </div>
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
          </div>
        )}

        {!nodes.length && !orphans.length && (
          <div className="py-8 text-center text-[12px] text-fgdim">
            {t('chat.noWorkers')}
          </div>
        )}
      </div>
    </div>
  );
}
