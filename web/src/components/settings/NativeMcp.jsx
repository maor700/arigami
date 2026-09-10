// Settings › Connections › "Direct connections (MCP)" — M1.
//
// The vendors that host their own remote MCP server: connecting one is the
// vendor's own OAuth consent, the token is stored on THIS host, and the calls go
// to the vendor with nobody in between. That is why these cards sit ABOVE the
// Composio grid — Composio stays as the fallback broker for what has no native
// server (Google, Slack, Facebook Pages) and for its triggers.
//
// The section is data-driven: rows are whatever the host reports with
// `provider === 'native-mcp'` (server/mcp-catalog.ts). Adding a service adds a
// card here with no code change.
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { capTitle } from '../setup/registry.js';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { Section, StatusPill, BTN_PRIMARY, BTN_DANGER, fmtWhen } from './shared.jsx';

function McpCard({ cap, busy, onConnect, onDisconnect, ownerName }) {
  const t = useT();
  const d = cap.data || {};
  const byo = d.auth === 'oauth-byo-client';
  return (
    <div data-mcp-card={cap.id} className={`flex flex-col gap-2 rounded-xl border p-2.5 ${cap.ok ? 'border-[#bfe3cf] bg-[#EAF6EF]/60' : 'border-hair bg-panel'}`}>
      <div className="flex items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hair bg-chip text-[13px] font-bold text-fgdim">
          {(cap.title || '?')[0].toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[12px] font-bold text-fg">{cap.title || capTitle(t, cap.id)}</span>
            {cap.ok && <StatusPill status="ok" label={t('integrations.connected')} />}
            {d.auth === 'bearer' && <span className="rounded-full border border-hair px-1.5 py-px text-[11px] md:text-[9.5px] text-fgdim">{t('mcp.auth.token')}</span>}
            {byo && <span className="rounded-full border border-hair px-1.5 py-px text-[11px] md:text-[9.5px] text-fgdim">{t('mcp.auth.byo')}</span>}
          </div>
          <p className="mt-0.5 text-[11.5px] md:text-[10.5px] leading-snug text-fgdim">
            {cap.ok ? t('mcp.card.connected', { name: d.name || '' }) : d.note || t('mcp.card.hint')}
          </p>
          {cap.ok && d.tools && (
            <p dir="ltr" className="mt-0.5 font-mono text-[11px] md:text-[9.5px] text-fgdim">{d.tools}{cap.resolvedFrom && cap.resolvedFrom !== cap.owner ? ` · ${ownerName?.(cap.resolvedFrom) || ''}` : ''}</p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {d.docs && (
          <a href={d.docs} target="_blank" rel="noreferrer" className="text-[11.5px] md:text-[10px] text-fgdim underline hover:text-fg">
            {t('mcp.docs')} <Icon icon={faArrowUpRightFromSquare} />
          </a>
        )}
        {cap.ok ? (
          <button type="button" disabled={busy} onClick={() => onDisconnect(cap)} className={BTN_DANGER}>{t('integrations.disconnect')}</button>
        ) : (
          <button type="button" disabled={busy || byo} title={byo ? t('mcp.auth.byo.hint') : undefined} onClick={() => onConnect(cap)} className={BTN_PRIMARY}>
            {busy ? t('integrations.connecting') : t('integrations.connect')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function NativeMcp({ caps = [], busy, onOpen, onDisconnect, onRefresh, ownerName, audit = [] }) {
  const t = useT();
  const connected = caps.filter((c) => c.ok).length;
  const lastAt = audit.find((a) => String(a.capability || '').startsWith('mcp:'))?.at;
  return (
    <Section id="mcp" title={t('settings.connections.native')} onRefresh={onRefresh}>
      <p className="mb-2 text-[11px] leading-snug text-fgdim">
        {t('mcp.intro')}
        {connected ? ` · ${t('integrations.connectedFilter')} ${connected}` : ''}
        {lastAt ? ` · ${fmtWhen(lastAt)}` : ''}
      </p>
      {caps.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-fgdim">{t('mcp.empty')}</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {caps.map((c) => (
            <McpCard key={c.id} cap={c} busy={busy} onConnect={onOpen} onDisconnect={onDisconnect} ownerName={ownerName} />
          ))}
        </div>
      )}
    </Section>
  );
}
