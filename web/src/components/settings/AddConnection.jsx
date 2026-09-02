// Settings › Connections › "Add connection" (AUDIT2) — the ONE searchable picker
// that replaced the 11 native-MCP cards and the 200-card Composio grid on the
// page. Three groups, one search box:
//   direct    the native remote-MCP catalog rows that are not connected yet
//             (server/mcp-catalog.ts via GET /setup/capabilities)
//   composio  FEATURED toolkits while the box is empty; typing searches the
//             whole catalog GET /composio/toolkits returns. No key → the
//             Composio sign-in block.
//   local     the WhatsApp bridge when it is not linked
// Picking a row hands the capability to the caller, which opens the same
// ConnectDialog the JIT setup cards use — nothing new on the wire.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { capTitle } from '../setup/registry.js';
import { FEATURED, ComposioLogin } from './Integrations.jsx';
import { StatusPill } from './shared.jsx';

export const composioCap = (tk) => ({
  id: `composio:${tk.slug}`,
  title: tk.name,
  ok: !!tk.connected,
  logo: tk.logo,
  provider: 'composio',
  manual: { kind: 'oauth', flow: 'redirect', token: true },
  autoCapable: true,
});

function Logo({ item }) {
  const [broken, setBroken] = useState(false);
  if (item.logo && !broken) return <img src={item.logo} alt="" onError={() => setBroken(true)} className="h-7 w-7 shrink-0 rounded-lg border border-hair bg-white object-contain p-0.5" />;
  return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hair bg-chip text-[12px] font-bold text-fgdim">{(item.title || '?')[0].toUpperCase()}</span>;
}

function Group({ title, items, onPick, busy, hint }) {
  const t = useT();
  if (!items.length && !hint) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 font-mono text-[9.5px] tracking-[0.08em] text-fgdim uppercase">{title}</div>
      <div className="overflow-hidden rounded-lg border border-hair">
        {items.map((it) => (
          <button
            key={it.cap.id}
            type="button"
            data-add-item={it.cap.id}
            disabled={busy || it.disabled}
            title={it.disabled ? it.disabledHint : it.note || ''}
            onClick={() => onPick(it.cap)}
            className="flex w-full cursor-pointer items-center gap-2.5 border-b border-hair px-2.5 py-2 text-start hover:bg-chip/60 disabled:cursor-default disabled:opacity-50 last:border-b-0"
          >
            <Logo item={it} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-bold text-fg">{it.title}</span>
              {(it.note || it.description) && <span className="block truncate text-[10.5px] text-fgdim">{it.note || it.description}</span>}
            </span>
            {it.disabled ? <StatusPill status="off" label={t('mcp.auth.byo')} /> : <span className="text-[10.5px] text-fgdim">{t('setup.connections.connect')}</span>}
          </button>
        ))}
        {hint && <div className="px-2.5 py-2 text-[10.5px] text-fgdim">{hint}</div>}
      </div>
    </div>
  );
}

export default function AddConnection({ mcpCaps = [], composio, whatsappCap, busy, onPick, onClose, onComposioSignedIn }) {
  const t = useT();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const query = q.trim().toLowerCase();
  const match = (s) => !query || String(s || '').toLowerCase().includes(query);

  const direct = useMemo(() => mcpCaps
    .filter((c) => !c.ok)
    .map((c) => {
      const d = c.data || {};
      const byo = d.auth === 'oauth-byo-client';
      return { cap: c, title: c.title || capTitle(t, c.id), note: d.note || '', disabled: byo, disabledHint: byo ? t('mcp.auth.byo.hint') : '' };
    })
    .filter((it) => match(it.title) || match(it.note)), [mcpCaps, query]);

  const toolkits = composio?.toolkits || [];
  const composioItems = useMemo(() => {
    const free = toolkits.filter((tk) => !tk.connected);
    const list = query
      ? free.filter((tk) => match(tk.name) || match(tk.description))
      : free.filter((tk) => FEATURED.includes(tk.slug)).sort((a, b) => FEATURED.indexOf(a.slug) - FEATURED.indexOf(b.slug));
    return list.slice(0, 40).map((tk) => ({ cap: composioCap(tk), title: tk.name, description: tk.description, logo: tk.logo }));
  }, [toolkits, query]);

  const local = useMemo(() => {
    const out = [];
    if (whatsappCap && !whatsappCap.ok && match('whatsapp')) out.push({ cap: whatsappCap, title: 'WhatsApp', note: t('settings.channels.whatsapp.hint') });
    return out;
  }, [whatsappCap, query]);

  const nothing = !direct.length && !composioItems.length && !local.length && !(composio && !composio.hasKey);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" data-add-connection className="flex max-h-[85vh] w-full max-w-[520px] flex-col rounded-[12px] border-[1.5px] border-ink bg-panel p-4 text-fg shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-bold">{t('settings.connections.add.title')}</span>
          <button type="button" onClick={onClose} className="ms-auto cursor-pointer px-1 text-[15px] text-fgdim hover:text-fg" aria-label={t('setup.cancel')}><Icon icon={faXmark} /></button>
        </div>
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('settings.connections.add.search')}
          className="mt-3 w-full rounded-lg border border-hair bg-panel px-3 py-1.5 text-[12px] text-fg outline-none placeholder:text-fgdim focus:border-ink"
        />
        <div className="thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto">
          {nothing && <div className="py-6 text-center text-[12px] text-fgdim">{t('settings.connections.add.empty')}</div>}
          <Group title={t('settings.connections.add.direct')} items={direct} onPick={onPick} busy={busy} />
          <Group
            title={t('settings.connections.add.composio')}
            items={composioItems}
            onPick={onPick}
            busy={busy}
            hint={composio?.hasKey && !query && toolkits.length > FEATURED.length ? t('settings.connections.add.moreComposio', { n: toolkits.length }) : ''}
          />
          {composio && !composio.hasKey && !composio.toolkits && <div className="mt-3"><ComposioLogin onDone={onComposioSignedIn} /></div>}
          <Group title={t('settings.connections.add.local')} items={local} onPick={onPick} busy={busy} />
        </div>
      </div>
    </div>
  );
}
