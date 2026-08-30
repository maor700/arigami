// Settings › Connections — the one hub that replaced Integrations, Accounts
// and Settings → Connections. Sections (deep-linkable as
// #/settings/connections/<id>): identity · claude · integrations · channels ·
// remote · notifications · audit. Capability status comes from
// GET /setup/capabilities (lib/setup-api.js, legacy fallback on old hosts).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { useStore } from '../../lib/store.js';
import { toastError } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import { subscribePush, unsubscribePush, isPushSubscribed } from '../../lib/push.js';
import * as setupApi from '../../lib/setup-api.js';
import { capTitle, capFamily } from '../setup/registry.js';
import ConnectDialog from './ConnectDialog.jsx';
import ClaudeAccounts from './ClaudeAccounts.jsx';
import Integrations from './Integrations.jsx';
import NativeMcp from './NativeMcp.jsx';
import Channels from './Channels.jsx';
import AgentConnectionsPanel from './AgentConnections.jsx';
import { AgentAvatar } from '../AgentCard.jsx';
import { Section, SettingCard, StatusPill, Field, Toggle, CopyRow, ErrorLine, BTN, BTN_SM, BTN_DANGER, fmtWhen } from './shared.jsx';

// Families rendered by a section of their own — everything else falls into the
// leftovers list under the Composio grid. M1 adds `mcp` (the native cards).
const OWN_SECTION = new Set(['identity', 'claude', 'whatsapp', 'remote', 'push', 'telemetry', 'composio', 'mcp']);

// Reach the cockpit from your phone over Tailscale — private to your devices.
// The direct tailnet URL works as soon as Tailscale is up; HTTPS serve is an
// optional upgrade (needs HTTPS Certificates on the tailnet).
function RemoteAccess() {
  const t = useT();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.get('/remote').then(setSt).catch(() => setSt({ available: false, reason: t('chrome.remote.unreachable') }));
  useEffect(() => { load(); }, []);
  const toggle = async (on) => {
    setBusy(true); setErr('');
    try { const r = await api.post('/remote', { enable: on }); setSt(r); setErr(r?.error || ''); } catch (e) { setErr(String(e?.message || e)); }
    setBusy(false);
  };
  const pill = !st ? null : !st.available ? <StatusPill status="off" label={t('chrome.remote.notInstalled')} />
    : !st.loggedIn ? <StatusPill status="todo" label={t('setup.state.todo')} />
      : <StatusPill status="ok" label={st.serving ? 'HTTPS' : t('setup.state.ok')} />;
  return (
    <Section id="remote" title={t('chrome.remote.section')}>
      <SettingCard
        title="Tailscale"
        pill={pill}
        hint={!st ? t('chrome.remote.checking') : !st.available ? t('chrome.remote.notInstalled') : !st.loggedIn ? (st.reason || t('chrome.remote.signInHint')) : t('chrome.remote.openOnPhone.hint')}
        actions={st && (!st.available
          ? <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className={BTN_SM}>{t('chrome.remote.get')}</a>
          : !st.loggedIn && <button type="button" onClick={load} className={BTN_SM}>{t('chrome.remote.recheck')}</button>)}
      >
        {st?.loggedIn && (
          <>
            {st.directUrl && <CopyRow url={st.directUrl} />}
            <Field label={t('chrome.remote.https')} hint={st.serving ? t('chrome.remote.https.on') : t('chrome.remote.https.off')}>
              <Toggle on={!!st.serving} disabled={busy} onChange={toggle} />
            </Field>
            {st.serving && st.httpsUrl && <CopyRow url={st.httpsUrl} />}
            {err && (
              <ErrorLine>
                {err} <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" className="underline">{t('chrome.remote.adminConsole')}</a>
              </ErrorLine>
            )}
          </>
        )}
      </SettingCard>
    </Section>
  );
}

function Notifications() {
  const t = useT();
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => { isPushSubscribed().then(setOn).finally(() => setLoading(false)); }, []);
  const toggle = async (v) => {
    setLoading(true);
    try { if (v) await subscribePush(); else await unsubscribePush(); setOn(v); } catch (e) { toastError(String(e?.message || e)); } finally { setLoading(false); }
  };
  const supported = typeof window !== 'undefined' && 'PushManager' in window;
  return (
    <Section id="notifications" title={t('settings.pushTitle')}>
      <Field label={t('settings.pushEnable')} hint={supported ? t('settings.pushHint') : t('settings.push.unsupported')}>
        <Toggle on={on} onChange={toggle} disabled={loading || !supported} />
      </Field>
    </Section>
  );
}

// A2: "שייך ל:" — the hub shows the host's (global) connections or ONE agent's.
function OwnerFilter({ owner, agents, onChange }) {
  const t = useT();
  if (!agents?.length) return null;
  return (
    <label className="mb-3 flex items-center gap-2 text-[11.5px]">
      <span className="font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.conn.ownerLabel')}</span>
      <select data-connections-owner value={owner} onChange={(e) => onChange(e.target.value)} className="rounded-[7px] border-[1.5px] border-border bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ink">
        <option value="global">{t('agent.conn.ownerGlobal')}</option>
        {agents.map((a) => <option key={a.slug} value={`agent:${a.slug}`}>{a.emoji} {a.name}</option>)}
      </select>
    </label>
  );
}

export default function Connections({ initialAdd = false }) {
  const t = useT();
  const { setupTick, agents } = useStore();
  const [owner, setOwner] = useState('global');
  const ownerAgent = (agents || []).find((a) => `agent:${a.slug}` === owner) || null;
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [dialog, setDialog] = useState(null); // capability object
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    setupApi.overview().then((r) => { setOv(r); setErr(null); }).catch((e) => setErr(e.message));
    setTick((n) => n + 1);
  }, []);
  useEffect(() => { load(); }, [load, setupTick]);

  const disconnect = async (c) => {
    const name = capFamily(c.id) === 'identity' ? t('setup.connections.identity') : c.title || capTitle(t, c.id);
    const ok = await confirmDialog({ title: t('setup.connections.disconnectConfirm', { name }), body: '', confirmLabel: t('setup.connections.disconnect'), danger: true });
    if (!ok) return;
    setBusy(true);
    try { await setupApi.disconnect(c.id); load(); } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };

  const identity = ov?.identity || null;
  const caps = (ov?.capabilities || []).filter((c) => !OWN_SECTION.has(capFamily(c.id)));
  // M1: native remote-MCP cards, in catalog order, above the Composio grid.
  const mcpCaps = (ov?.capabilities || []).filter((c) => c.provider === 'native-mcp' || capFamily(c.id) === 'mcp');
  const claudeCap = (ov?.capabilities || []).find((c) => c.id === 'claude');
  const audit = (ov?.audit || []).slice(-10).reverse();
  const ownerName = (o) => {
    const a = o && (agents || []).find((x) => `agent:${x.slug}` === o);
    return a ? `${a.emoji} ${a.name}` : t('agent.conn.ownerGlobal');
  };

  if (ownerAgent) {
    // An agent's view: its own connections (settings/AgentConnections.jsx) — host-level sections are the host's.
    return (
      <Section id="identity" title={t('agent.conn.title', { name: ownerAgent.name })} first>
        <OwnerFilter owner={owner} agents={agents} onChange={setOwner} />
        <div className="mb-3 flex items-center gap-2 text-[12px]"><AgentAvatar agent={ownerAgent} size={18} /> <span className="font-bold">{ownerAgent.name}</span></div>
        <AgentConnectionsPanel agent={ownerAgent} />
      </Section>
    );
  }

  return (
    <>
      <Section id="identity" title={t('setup.connections.identity')} onRefresh={load} first>
        <OwnerFilter owner={owner} agents={agents} onChange={setOwner} />
        <ErrorLine>{err}</ErrorLine>
        <SettingCard
          title={t('setup.connections.identity')}
          pill={ov ? <StatusPill status={identity ? 'ok' : 'todo'} label={identity ? t('setup.state.ok') : t('setup.state.todo')} /> : null}
          hint={!ov ? t('setup.loading') : identity ? <span dir="ltr" className="font-mono">{identity.email} · {identity.provider || 'google'} · {fmtWhen(identity.connectedAt)}</span> : t('setup.connections.noIdentity')}
          actions={ov && (identity
            ? <button type="button" disabled={busy} onClick={() => disconnect({ id: 'identity' })} className={BTN_DANGER}>{t('setup.connections.disconnect')}</button>
            : <button type="button" className={BTN} onClick={() => setDialog({ id: 'identity', manual: { kind: 'takeover' }, autoCapable: false })}>{t('setup.connections.connect')}</button>)}
        />
      </Section>

      <ClaudeAccounts initialAdd={initialAdd} identity={identity} onConnectAuto={claudeCap ? () => setDialog(claudeCap) : null} />
      <NativeMcp caps={mcpCaps} busy={busy} audit={audit} ownerName={ownerName} onRefresh={load} onOpen={setDialog} onDisconnect={disconnect} />
      <Integrations caps={caps} busy={busy} tick={tick} onOpen={setDialog} onDisconnect={disconnect} />
      <Channels onChanged={load} />
      <RemoteAccess />
      <Notifications />

      <Section id="audit" title={t('setup.connections.audit')}>
        {audit.length === 0 ? (
          <div className="text-[11px] text-fgdim">{t('setup.connections.noAudit')}</div>
        ) : (
          <div dir="ltr" className="max-h-[180px] overflow-auto rounded-lg border border-hair px-3 py-1 font-mono text-[10px] text-fgdim">
            {audit.map((a, i) => (
              <div key={i} className="flex flex-wrap gap-x-2 border-b border-hair py-1 last:border-b-0">
                <span>{fmtWhen(a.at)}</span>
                <span className="font-bold text-fg">{a.capability}</span>
                <span data-audit-owner={a.owner || 'global'} dir="auto">{ownerName(a.owner)}</span>
                <span>{a.mode}</span>
                <span className={a.result === 'ok' || a.result === 'done' || a.result === 'already' ? 'text-[#2f7d4f]' : a.result === 'failed' ? 'text-[#9c3b33]' : ''}>{a.result}</span>
                {a.human ? <span>human</span> : null}
                {a.evidence && <a href={a.evidence} target="_blank" rel="noopener noreferrer" className="underline">{t('setup.auto.evidence')}</a>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {dialog && <ConnectDialog cap={dialog} identity={identity} onClose={() => setDialog(null)} onChanged={load} />}
    </>
  );
}
