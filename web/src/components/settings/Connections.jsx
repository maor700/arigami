// Settings › Connections — the one hub (SET), restructured by AUDIT2 from 233
// default-visible items to ~14. On the page: Google identity · Claude accounts
// · ONE "connected" list (native MCP + Composio + the WhatsApp bridge +
// Tailscale, no provider split — the route shows on hover / in the detail) ·
// "Add connection" (AddConnection.jsx, the searchable picker that replaced the
// native-MCP cards and the Composio grid) · push notifications.
// In the Advanced drawer: the A2 "belongs to" owner filter, the Claude
// active/pool explainer, webhooks (Channels.jsx › Webhooks, admin), HTTPS serve,
// the git/desktop/repo status rows and the connections audit log.
// Deep links: #/settings/connections/<id>; `mcp` and `integrations` (Launcher,
// old bookmarks) open the picker. Capability status: GET /setup/capabilities
// (lib/setup-api.js); connect/disconnect stay on the JIT setup contract.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { useStore } from '../../lib/store.js';
import { toastError } from '../../lib/toast.js';
import { confirmDialog } from '../../lib/confirm.js';
import { subscribePush, unsubscribePush, isPushSubscribed } from '../../lib/push.js';
import * as setupApi from '../../lib/setup-api.js';
import { capTitle, capFamily, manualFor } from '../setup/registry.js';
import { Icon } from '../../lib/icons.js';
import { faPlus, faCheck } from '@fortawesome/free-solid-svg-icons';
import ConnectDialog from './ConnectDialog.jsx';
import Accounts, { AccountsFooter } from './Accounts.jsx';
import AddConnection, { composioCap } from './AddConnection.jsx';
import { Webhooks } from './Channels.jsx';
import AgentConnectionsPanel from './AgentConnections.jsx';
import { AgentAvatar } from '../AgentCard.jsx';
import { Section, SettingCard, StatusPill, Field, Toggle, CopyRow, ErrorLine, BTN, BTN_SM, BTN_PRIMARY, BTN_DANGER, ROW, LIST, fmtWhen, Advanced } from './shared.jsx';

// Families rendered by a section of their own — everything else falls into the
// "infrastructure status" list in the drawer (git, desktop, repo:*).
const OWN_SECTION = new Set(['identity', 'claude', 'codex', 'whatsapp', 'remote', 'push', 'telemetry', 'composio', 'mcp']);
export const CONNECTIONS_ADVANCED_IDS = ['owner', 'claude-more', 'channels', 'remote-advanced', 'status', 'audit'];
const PICKER_SECTIONS = new Set(['mcp', 'integrations', 'add']);

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

// A2: "Belongs to:" — the hub shows the host's (global) connections or ONE agent's.
function OwnerFilter({ owner, agents, onChange }) {
  const t = useT();
  if (!agents?.length) return null;
  return (
    <label className="mb-3 flex items-center gap-2 text-[11.5px]">
      <span className="font-mono text-[11.5px] md:text-[10px] tracking-[0.08em] text-fgdim uppercase">{t('agent.conn.ownerLabel')}</span>
      <select data-connections-owner value={owner} onChange={(e) => onChange(e.target.value)} className="rounded-[7px] border-[1.5px] border-border bg-panel px-2 py-1 text-[11.5px] text-fg outline-none focus:border-ink">
        <option value="global">{t('agent.conn.ownerGlobal')}</option>
        {agents.map((a) => <option key={a.slug} value={`agent:${a.slug}`}>{a.emoji} {a.name}</option>)}
      </select>
    </label>
  );
}

function RowLogo({ row }) {
  const [broken, setBroken] = useState(false);
  if (row.logo && !broken) return <img src={row.logo} alt="" onError={() => setBroken(true)} className="h-7 w-7 shrink-0 rounded-lg border border-hair bg-white object-contain p-0.5" />;
  return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hair bg-chip text-[12px] font-bold text-fgdim">{(row.title || '?')[0].toUpperCase()}</span>;
}

// One row of the unified list. `provider` is the route (native-mcp / composio /
// local) — shown as the hover title and in the mono detail, never as a heading.
function ConnectedRow({ row, busy, onDisconnect }) {
  const t = useT();
  const providerLabel = t(`settings.connections.provider.${row.provider}`);
  return (
    <div data-connected-row={row.id} data-provider={row.provider} title={providerLabel} className={`${ROW} py-2`}>
      <RowLogo row={row} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-bold text-fg">{row.title}</span>
          {row.pill || <StatusPill status="ok" label={t('setup.connections.on')} />}
        </span>
        {row.detail && <span dir="ltr" className="block truncate font-mono text-[11.5px] md:text-[10px] text-fgdim">{row.detail}</span>}
      </span>
      {row.copy && <CopyRow url={row.copy} compact />}
      {row.actions}
      {onDisconnect && <button type="button" disabled={busy} onClick={onDisconnect} className="cursor-pointer text-[11.5px] md:text-[10px] text-fgdim hover:text-[#9c3b33]">{t('setup.connections.disconnect')}</button>}
    </div>
  );
}

export default function Connections({ initialAdd = false, section = '' }) {
  const t = useT();
  const { setupTick, agents, auth } = useStore();
  const admin = !!auth?.isAdmin || auth?.authMode === 'off';
  const [owner, setOwner] = useState('global');
  const ownerAgent = (agents || []).find((a) => `agent:${a.slug}` === owner) || null;
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [composio, setComposio] = useState(null); // GET /composio/toolkits → {toolkits, hasKey} | {error, hasKey}
  const [wa, setWa] = useState(null); // GET /whatsapp/status
  const [remote, setRemote] = useState(null); // GET /remote
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteErr, setRemoteErr] = useState('');
  const [dialog, setDialog] = useState(null); // capability object → ConnectDialog
  const [picker, setPicker] = useState(PICKER_SECTIONS.has(section));
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setupApi.overview().then((r) => { setOv(r); setErr(null); }).catch((e) => setErr(e.message));
    api.get('/composio/toolkits').then(setComposio).catch((e) => setComposio({ error: String(e?.message || e), hasKey: false }));
    api.get('/whatsapp/status').then(setWa).catch(() => setWa({ status: 'disconnected' }));
    api.get('/remote').then(setRemote).catch(() => setRemote({ available: false, reason: t('chrome.remote.unreachable') }));
  }, []);
  useEffect(() => { load(); }, [load, setupTick]);
  useEffect(() => { if (PICKER_SECTIONS.has(section)) setPicker(true); }, [section]);

  const disconnect = async (c) => {
    const name = capFamily(c.id) === 'identity' ? t('setup.connections.identity') : c.title || capTitle(t, c.id);
    const ok = await confirmDialog({ title: t('setup.connections.disconnectConfirm', { name }), body: '', confirmLabel: t('setup.connections.disconnect'), danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      if (c.id === 'whatsapp') await api.post('/whatsapp/disconnect', {});
      else await setupApi.disconnect(c.id);
      load();
    } catch (e) { toastError(String(e?.message || e)); } finally { setBusy(false); }
  };
  const toggleHttps = async (on) => {
    setRemoteBusy(true); setRemoteErr('');
    try { const r = await api.post('/remote', { enable: on }); setRemote(r); setRemoteErr(r?.error || ''); } catch (e) { setRemoteErr(String(e?.message || e)); }
    setRemoteBusy(false);
  };

  const identity = ov?.identity || null;
  const allCaps = ov?.capabilities || [];
  const leftovers = allCaps.filter((c) => !OWN_SECTION.has(capFamily(c.id)));
  const mcpCaps = allCaps.filter((c) => c.provider === 'native-mcp' || capFamily(c.id) === 'mcp');
  const claudeCap = allCaps.find((c) => c.id === 'claude');
  const whatsappCap = { ...(allCaps.find((c) => c.id === 'whatsapp') || { id: 'whatsapp', ...manualFor('whatsapp') }), ok: wa?.status === 'connected' };
  const audit = (ov?.audit || []).slice(-10).reverse();
  const ownerName = (o) => {
    const a = o && (agents || []).find((x) => `agent:${x.slug}` === o);
    return a ? `${a.emoji} ${a.name}` : t('agent.conn.ownerGlobal');
  };

  // ---- the unified "connected" list ---------------------------------------
  const rows = [];
  for (const c of mcpCaps.filter((x) => x.ok)) {
    const d = c.data || {};
    // Who holds the grant: the host's serves every engine; an engine's own
    // (`claude mcp login`) only that engine — say so, and offer the move.
    const engineOnly = d.heldBy === 'engine';
    rows.push({
      id: c.id,
      title: c.title || capTitle(t, c.id),
      provider: 'native-mcp',
      detail: [d.tools, d.heldBy === 'host' ? t('mcp.card.viaHost') : '', engineOnly ? t('mcp.card.engineOnly', { engines: (d.engines || []).map((e) => (e === 'codex' ? 'Codex' : 'Claude')).join(', ') }) : '', c.resolvedFrom && c.resolvedFrom !== c.owner ? ownerName(c.resolvedFrom) : ''].filter(Boolean).join(' · '),
      ...(engineOnly ? { pill: <StatusPill status="missing" label={t('mcp.card.enginePill', { engines: (d.engines || []).map((e) => (e === 'codex' ? 'Codex' : 'Claude')).join(', ') })} />, actions: <button type="button" data-move-to-host={c.id} disabled={busy} onClick={() => setDialog(c)} className="cursor-pointer text-[11.5px] md:text-[10px] text-fg underline hover:text-ink">{t('mcp.card.moveToHost')}</button> } : {}),
      cap: c,
    });
  }
  for (const tk of (composio?.toolkits || []).filter((x) => x.connected)) {
    rows.push({ id: `composio:${tk.slug}`, title: tk.name, logo: tk.logo, provider: 'composio', detail: `composio:${tk.slug}`, cap: composioCap(tk) });
  }
  if (wa?.status === 'connected') rows.push({ id: 'whatsapp', title: 'WhatsApp', provider: 'local', detail: [t('settings.channels.whatsapp.linked'), wa.user].filter(Boolean).join(' · '), cap: whatsappCap });
  // Tailscale is always one row: the private URL when it is up, the way to get there when not.
  const rs = remote;
  rows.push({
    id: 'remote',
    title: 'Tailscale',
    provider: 'local',
    noDisconnect: true,
    pill: !rs ? <StatusPill status="pending" label={t('chrome.remote.checking')} /> : !rs.available ? <StatusPill status="off" label={t('chrome.remote.notInstalled').split('.')[0]} />
      : !rs.loggedIn ? <StatusPill status="todo" label={t('setup.state.todo')} /> : <StatusPill status="ok" label={rs.serving ? 'HTTPS' : t('setup.state.ok')} />,
    detail: rs?.loggedIn ? (rs.serving && rs.httpsUrl ? rs.httpsUrl : rs.directUrl) : rs && !rs.available ? '' : rs?.reason || '',
    copy: rs?.loggedIn ? (rs.serving && rs.httpsUrl ? rs.httpsUrl : rs.directUrl) : '',
    actions: rs && (!rs.available
      ? <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className={BTN_SM}>{t('chrome.remote.get')}</a>
      : !rs.loggedIn ? <button type="button" onClick={load} className={BTN_SM}>{t('chrome.remote.recheck')}</button> : null),
  });

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

      <Accounts initialAdd={initialAdd} identity={identity} footer={false} onConnectAuto={claudeCap ? () => setDialog(claudeCap) : null} />

      <Section id="connected" title={t('settings.connections.connected')} onRefresh={load}>
        <div className="mb-2 text-[11px] text-fgdim">{t('settings.connections.connected.hint')}</div>
        {composio?.error && composio.hasKey && <ErrorLine>{composio.error}</ErrorLine>}
        <div data-connected-list className="rounded-lg border border-hair px-3 py-1">
          {rows.length === 0 && <div className="py-2 text-[11px] text-fgdim">{t('settings.connections.none')}</div>}
          {rows.map((r) => (
            <ConnectedRow
              key={r.id}
              row={r}
              busy={busy}
              onDisconnect={r.noDisconnect ? null : () => disconnect(r.cap)}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" data-add-connection-btn onClick={() => setPicker(true)} className={BTN_PRIMARY}><Icon icon={faPlus} /> {t('settings.connections.add')}</button>
        </div>
      </Section>

      <Notifications />

      <Advanced section={section} ids={CONNECTIONS_ADVANCED_IDS}>
        <Section id="owner" title={t('agent.conn.ownerLabel')}>
          <OwnerFilter owner={owner} agents={agents} onChange={setOwner} />
          {!agents?.length && <div className="text-[11px] text-fgdim">{t('agent.conn.ownerGlobal')}</div>}
        </Section>

        <Section id="claude-more" title={t('settings.connections.claude.more')}>
          <AccountsFooter />
        </Section>

        {admin && (
          <Section id="channels" title={t('settings.connections.channels')}>
            <Webhooks />
          </Section>
        )}

        {rs?.loggedIn && (
          <Section id="remote-advanced" title={t('chrome.remote.section')}>
            <Field label={t('chrome.remote.https')} hint={rs.serving ? t('chrome.remote.https.on') : t('chrome.remote.https.off')}>
              <Toggle on={!!rs.serving} disabled={remoteBusy} onChange={toggleHttps} />
            </Field>
            {rs.directUrl && <CopyRow url={rs.directUrl} />}
            {rs.serving && rs.httpsUrl && <CopyRow url={rs.httpsUrl} />}
            {remoteErr && (
              <ErrorLine>
                {remoteErr} <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer" className="underline">{t('chrome.remote.adminConsole')}</a>
              </ErrorLine>
            )}
          </Section>
        )}

        {leftovers.length > 0 && (
          <Section id="status" title={t('settings.connections.status')}>
            <div className="text-[11px] text-fgdim">{t('settings.connections.status.hint')}</div>
            <div className={LIST}>
              {leftovers.map((c) => (
                <div key={c.id} className={ROW}>
                  <StatusPill status={c.ok ? 'ok' : 'todo'} label={c.ok ? t('setup.connections.on') : t('setup.connections.off')} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-bold">{capTitle(t, c.id)}</span>
                    {(c.detail || c.connectedAt) && <span dir="ltr" className="ms-2 font-mono text-[11.5px] md:text-[10px] text-fgdim">{c.detail}{c.connectedAt ? ` · ${fmtWhen(c.connectedAt)}` : ''}</span>}
                  </span>
                  {c.ok && capFamily(c.id) !== 'repo' && capFamily(c.id) !== 'desktop' && (
                    <button type="button" disabled={busy} onClick={() => disconnect(c)} className="cursor-pointer text-[11.5px] md:text-[10px] text-fgdim hover:text-[#9c3b33]">{t('setup.connections.disconnect')}</button>
                  )}
                  <button type="button" className={c.ok ? 'cursor-pointer text-[11.5px] md:text-[10.5px] text-fgdim hover:text-fg' : BTN_PRIMARY} onClick={() => setDialog(c)}>
                    {c.ok ? <><Icon icon={faCheck} /> {t('setup.connections.reconnect')}</> : t('setup.connections.connect')}
                  </button>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section id="audit" title={t('setup.connections.audit')}>
          {audit.length === 0 ? (
            <div className="text-[11px] text-fgdim">{t('setup.connections.noAudit')}</div>
          ) : (
            <div dir="ltr" className="max-h-[180px] overflow-auto rounded-lg border border-hair px-3 py-1 font-mono text-[11.5px] md:text-[10px] text-fgdim">
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
      </Advanced>

      {picker && (
        <AddConnection
          mcpCaps={mcpCaps}
          composio={composio}
          whatsappCap={whatsappCap}
          busy={busy}
          onPick={(cap) => { setPicker(false); setDialog(cap); }}
          onClose={() => setPicker(false)}
          onComposioSignedIn={load}
        />
      )}
      {dialog && <ConnectDialog cap={dialog} identity={identity} onClose={() => setDialog(null)} onChanged={load} />}
    </>
  );
}
