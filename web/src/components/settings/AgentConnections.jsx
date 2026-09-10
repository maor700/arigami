// A2 — an agent's connections ("שייך ל: <agent>" — belongs to: <agent>). One presentational list
// (AgentConnections — pure props, SSR-testable) and its container
// (AgentConnectionsPanel — fetches GET /__api/agents/:slug/connections, re-reads
// on every setup.* bus event, wires connect / disconnect FOR the agent).
// Used by the Agent page (the connections ("חיבורים") tab) and by Settings → Connections ("חיבורים") when the
// "שייך ל" (belongs to) filter points at an agent.
//
// Rows: the OWNABLE capabilities (identity, composio:*) say where they
// resolved from — the agent's own connection, the host's shared one (a
// fallback the agent inherits), or nothing; host-level capabilities (claude,
// git, whatsapp, desktop…) are listed as shared-by-nature. The agent's Chrome
// profile line says whether agents/<slug>/browser exists yet.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { useStore } from '../../lib/store.js';
import { toastError } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import * as setupApi from '../../lib/setup-api.js';
import { capTitle, capFamily } from '../setup/registry.js';
import ConnectDialog from './ConnectDialog.jsx';
import { StatusPill, BTN_PRIMARY, ROW, LIST, fmtWhen } from './shared.jsx';
import { faCheck, faGlobe } from '@fortawesome/free-solid-svg-icons';

const HIDDEN = new Set(['telemetry', 'push']); // host-only toggles that mean nothing per agent

export function AgentConnections({ agent, data, busy = false, onConnect, onDisconnect }) {
  const t = useT();
  const owner = setupApi.ownerOfAgent(agent.slug);
  const caps = data?.capabilities || [];
  const own = caps.filter((c) => c.ownable);
  const host = caps.filter((c) => !c.ownable && !HIDDEN.has(c.id) && capFamily(c.id) !== 'repo');
  const audit = (data?.audit || []).slice(-8).reverse();
  const pill = (c) => {
    if (!c.ok) return <StatusPill status="todo" label={t('agent.conn.none')} />;
    if (c.resolvedFrom === owner) return <StatusPill status="ok" label={t('agent.conn.own')} />;
    return <StatusPill status="ok" label={t('agent.conn.shared')} />;
  };
  return (
    <div data-agent-connections={agent.slug} className="flex flex-col gap-3">
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-1 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.conn.ownTitle')}</div>
        <div className="mb-2 text-[11px] text-fgdim">{t('agent.conn.ownHint', { name: agent.name })}</div>
        <div className={LIST}>
          {own.map((c) => (
            <div key={c.id} data-agent-cap={c.id} data-resolved={c.resolvedFrom || 'none'} className={ROW}>
              {pill(c)}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-bold">{capTitle(t, c.id)}</span>
                {c.detail && <span dir="ltr" className="ms-2 font-mono text-[11.5px] md:text-[10px] text-fgdim">{c.detail}</span>}
              </span>
              {c.ok && c.resolvedFrom === owner && (
                <button type="button" disabled={busy} onClick={() => onDisconnect?.(c)} className="cursor-pointer text-[11.5px] md:text-[10px] text-fgdim hover:text-[#9c3b33]">{t('agent.conn.disconnect')}</button>
              )}
              <button type="button" disabled={busy} className={c.ok && c.resolvedFrom === owner ? 'cursor-pointer text-[11.5px] md:text-[10.5px] text-fgdim hover:text-fg' : BTN_PRIMARY} onClick={() => onConnect?.(c)}>
                {c.ok && c.resolvedFrom === owner ? <><Icon icon={faCheck} /> {t('setup.connections.reconnect')}</> : t('agent.conn.connect')}
              </button>
            </div>
          ))}
        </div>
        <div data-agent-browser={data?.browserProfile ? 'on' : 'off'} className="mt-2 flex items-center gap-2 text-[11px]">
          <StatusPill status={data?.browserProfile ? 'ok' : 'off'} label={data?.browserProfile ? t('setup.connections.on') : t('setup.connections.off')} />
          <span className="font-bold">{t('agent.conn.browser')}</span>
          <span className="text-fgdim">{data?.browserProfile ? t('agent.conn.browserOn') : t('agent.conn.browserOff')}</span>
        </div>
      </div>
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase"><Icon icon={faGlobe} /> {t('agent.conn.hostTitle')}</div>
        <div className="mb-2 text-[11px] text-fgdim">{t('agent.conn.hostHint')}</div>
        <div className={LIST}>
          {host.map((c) => (
            <div key={c.id} className={ROW}>
              <StatusPill status={c.ok ? 'ok' : 'todo'} label={c.ok ? t('setup.connections.on') : t('setup.connections.off')} />
              <span className="min-w-0 flex-1 truncate"><span className="font-bold">{capTitle(t, c.id)}</span>{c.detail && <span dir="ltr" className="ms-2 font-mono text-[11.5px] md:text-[10px] text-fgdim">{c.detail}</span>}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-[10px] border border-hair p-3">
        <div className="mb-2 font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('setup.connections.audit')}</div>
        {audit.length === 0 ? (
          <div className="text-[11px] text-fgdim">{t('setup.connections.noAudit')}</div>
        ) : (
          <div dir="ltr" className="max-h-[160px] overflow-auto font-mono text-[11.5px] md:text-[10px] text-fgdim">
            {audit.map((a, i) => (
              <div key={i} className="flex flex-wrap gap-x-2 border-b border-hair py-1 last:border-b-0">
                <span>{fmtWhen(a.at)}</span>
                <span className="font-bold text-fg">{a.capability}</span>
                <span>{a.mode}</span>
                <span className={a.result === 'done' || a.result === 'already' ? 'text-[#2f7d4f]' : a.result === 'failed' ? 'text-[#9c3b33]' : ''}>{a.result}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentConnectionsPanel({ agent }) {
  const t = useT();
  const { setupTick } = useStore();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const owner = setupApi.ownerOfAgent(agent.slug);
  const load = useCallback(() => {
    setupApi.agentConnections(agent.slug).then(setData).catch((e) => toastError(String(e?.message || e)));
  }, [agent.slug]);
  useEffect(() => { load(); }, [load, setupTick]);
  const disconnect = async (c) => {
    const ok = await confirmDialog({ title: t('agent.conn.disconnectConfirm', { name: capTitle(t, c.id), agent: agent.name }), body: '', confirmLabel: t('agent.conn.disconnect'), danger: true });
    if (!ok) return;
    setBusy(true);
    try { await setupApi.disconnect(c.id, owner); load(); } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  if (!data) return <div className="text-[11px] text-fgdim">{t('dialogs.loading')}</div>;
  return (
    <>
      <AgentConnections agent={agent} data={data} busy={busy} onConnect={setDialog} onDisconnect={disconnect} />
      {dialog && <ConnectDialog cap={dialog} identity={data.identity} owner={owner} onClose={() => setDialog(null)} onChanged={load} />}
    </>
  );
}
