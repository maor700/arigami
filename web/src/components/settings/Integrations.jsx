// Settings › Connections › "More, via Composio" (M1 — it used to be THE
// integrations section; the native remote-MCP cards now sit above it):
// the Composio toolkit grid (search + category chips + connected filter) plus
// the non-Composio capabilities the host tracks (GitHub CLI, desktop, repos).
// Composio stays for what has no vendor-hosted MCP server we can use — Google
// (own GCP client + a preview program), Slack (own app + admin approval),
// Facebook Pages (none at all) — and for its event triggers.
// Connect/disconnect go through the JIT setup contract (ConnectDialog →
// AUTO session when a Google identity exists, MANUAL redirect flow
// otherwise; DELETE /setup/composio:<slug> to disconnect), so this section and
// the in-chat setup cards behave identically.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { Icon } from '../../lib/icons.js';
import { capTitle, capFamily } from '../setup/registry.js';
import { faArrowUpRightFromSquare, faCheck } from '@fortawesome/free-solid-svg-icons';
import { Section, StatusPill, ErrorLine, BTN_PRIMARY, BTN_DANGER, BTN_SM, ROW, LIST, fmtWhen } from './shared.jsx';

// M1: what Composio is still the best path for. `linear`/`notion`/`github` moved
// to their vendors' own MCP servers (the native cards above), and `whatsapp` is
// gone entirely — Composio's toolkit is WhatsApp *Business* (WABA templates,
// per-conversation billing), while ours is the local personal bridge.
export const FEATURED = ['gmail', 'googledrive', 'googlecalendar', 'googledocs', 'slack', 'facebook'];
const CHIP = (on) => `shrink-0 cursor-pointer rounded-full border px-2.5 py-0.5 text-[11.5px] md:text-[10.5px] ${on ? 'border-ink bg-chip font-bold text-fg' : 'border-hair text-fgdim hover:border-ink hover:text-fg'}`;

function ToolkitCard({ toolkit, busy, onConnect, onDisconnect }) {
  const t = useT();
  return (
    <div className={`flex flex-col gap-2 rounded-xl border p-2.5 ${toolkit.connected ? 'border-ok-line bg-ok-bg/60' : 'border-hair bg-panel'}`}>
      <div className="flex items-start gap-2">
        {toolkit.logo ? (
          <img src={toolkit.logo} alt="" className="h-8 w-8 shrink-0 rounded-lg border border-hair bg-white object-contain p-0.5" onError={(e) => { e.target.style.display = 'none'; }} />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hair bg-chip text-[13px] font-bold text-fgdim">{(toolkit.name || '?')[0].toUpperCase()}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-bold text-fg">{toolkit.name}</span>
            {toolkit.connected && <StatusPill status="ok" label={t('integrations.connected')} />}
          </div>
          {toolkit.description && <p className="mt-0.5 line-clamp-2 text-[11.5px] md:text-[10.5px] leading-snug text-fgdim">{toolkit.description}</p>}
        </div>
      </div>
      <div className="flex justify-end">
        {toolkit.connected ? (
          <button type="button" disabled={busy} onClick={() => onDisconnect(toolkit)} className={BTN_DANGER}>{t('integrations.disconnect')}</button>
        ) : (
          <button type="button" disabled={busy} onClick={() => onConnect(toolkit)} className={BTN_PRIMARY}>{busy ? t('integrations.connecting') : t('integrations.connect')}</button>
        )}
      </div>
    </div>
  );
}

// No Composio key yet → the Composio OAuth login (opens a tab, polls).
export function ComposioLogin({ onDone }) {
  const t = useT();
  const [state, setState] = useState(null); // null | 'starting' | 'waiting' | 'error'
  const [err, setErr] = useState('');
  const pollRef = useRef(null);
  const sidRef = useRef(null);
  useEffect(() => () => clearInterval(pollRef.current), []);
  const start = async () => {
    setState('starting'); setErr('');
    try {
      const r = await api.post('/composio/auth/start', {});
      if (r.error) { setState('error'); setErr(r.error); return; }
      sidRef.current = r.sessionId;
      window.open(r.loginUrl, '_blank', 'noopener,noreferrer');
      setState('waiting');
      pollRef.current = setInterval(async () => {
        try {
          const s = await api.get(`/composio/auth/status?sessionId=${encodeURIComponent(sidRef.current || '')}`);
          if (s.authenticated) { clearInterval(pollRef.current); setState(null); onDone(); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) { setState('error'); setErr(String(e?.message || e)); }
  };
  const cancel = () => { clearInterval(pollRef.current); sidRef.current = null; setState(null); };
  return (
    <div className="rounded-xl border border-hair bg-panel px-3 py-4 text-center">
      <div className="text-[13px] font-bold text-fg">{t('integrations.noKey.title')}</div>
      <div className="mx-auto mt-1 max-w-sm text-[11.5px] text-fgdim">{t('integrations.noKey.body')}</div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {state === 'waiting' ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fgdim border-t-transparent" />
            <span className="text-[11.5px] text-fgdim">{t('integrations.oauth.waiting')}</span>
            <button type="button" onClick={cancel} className="text-[11px] text-fgdim underline">{t('integrations.oauth.cancel')}</button>
          </>
        ) : (
          <button type="button" onClick={start} disabled={state === 'starting'} className={BTN_SM}>
            {state === 'starting' ? t('integrations.oauth.starting') : <><Icon icon={faArrowUpRightFromSquare} /> {t('integrations.oauth.button')}</>}
          </button>
        )}
      </div>
      <ErrorLine>{state === 'error' ? err : ''}</ErrorLine>
    </div>
  );
}

// `caps`: the JIT capability rows that aren't identity/claude/whatsapp/remote/
// push/telemetry (those have their own sections) — git, desktop, repo:*.
export default function Integrations({ caps, onOpen, onDisconnect, busy, tick }) {
  const t = useT();
  const [data, setData] = useState(null); // { toolkits, hasKey, error? }
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/composio/toolkits')
      .then(setData)
      .catch((e) => setData({ error: String(e?.message || e), hasKey: false }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [tick]);

  const categories = useMemo(() => {
    const s = new Set();
    for (const tk of data?.toolkits || []) for (const c of tk.categories || []) s.add(c);
    return [...s].sort();
  }, [data]);
  const toolkits = useMemo(() => {
    let list = data?.toolkits || [];
    if (category === 'connected') list = list.filter((x) => x.connected);
    else if (category !== 'all') list = list.filter((x) => (x.categories || []).includes(category));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((x) => x.name.toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q));
    return [...list.filter((x) => FEATURED.includes(x.slug)), ...list.filter((x) => !FEATURED.includes(x.slug))];
  }, [data, category, search]);
  const connectedCount = (data?.toolkits || []).filter((x) => x.connected).length;

  const cap = (tk) => ({
    id: `composio:${tk.slug}`,
    title: tk.name,
    ok: !!tk.connected,
    manual: { kind: 'oauth', flow: 'redirect', token: true },
    autoCapable: true,
  });

  return (
    <Section id="integrations" title={t('settings.connections.composioMore')} onRefresh={load}>
      {data && !data.hasKey && !data.toolkits && <ComposioLogin onDone={load} />}
      {data?.error && data.hasKey && <ErrorLine>{data.error}</ErrorLine>}
      {loading && !data && <div className="py-3 text-[11.5px] text-fgdim">{t('dialogs.loading')}</div>}
      {data?.toolkits && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <input
              type="search"
              placeholder={t('integrations.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-[160px] flex-1 rounded-lg border border-hair bg-panel px-3 py-1.5 text-[12px] text-fg outline-none placeholder:text-fgdim focus:border-ink"
            />
          </div>
          <div className="thin-scroll mb-2 flex gap-1.5 overflow-x-auto pb-1">
            <button type="button" onClick={() => setCategory('all')} className={CHIP(category === 'all')}>{t('integrations.all')}</button>
            <button type="button" onClick={() => setCategory('connected')} className={CHIP(category === 'connected')}>
              {t('integrations.connectedFilter')}{connectedCount ? ` · ${connectedCount}` : ''}
            </button>
            {categories.map((c) => (
              <button key={c} type="button" onClick={() => setCategory(c)} className={CHIP(category === c)}>{c.charAt(0).toUpperCase() + c.slice(1)}</button>
            ))}
          </div>
          {toolkits.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-fgdim">{t('integrations.empty')}</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {toolkits.map((tk) => (
                <ToolkitCard key={tk.slug} toolkit={tk} busy={busy} onConnect={() => onOpen(cap(tk))} onDisconnect={() => onDisconnect(cap(tk))} />
              ))}
            </div>
          )}
        </>
      )}

      {caps.length > 0 && (
        <div className={LIST}>
          {caps.map((c) => (
            <div key={c.id} className={ROW}>
              <StatusPill status={c.ok ? 'ok' : 'todo'} label={c.ok ? t('setup.connections.on') : t('setup.connections.off')} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-bold">{capTitle(t, c.id)}</span>
                {(c.detail || c.connectedAt) && <span dir="ltr" className="ms-2 font-mono text-[11.5px] md:text-[10px] text-fgdim">{c.detail}{c.connectedAt ? ` · ${fmtWhen(c.connectedAt)}` : ''}</span>}
              </span>
              {c.ok && capFamily(c.id) !== 'repo' && capFamily(c.id) !== 'desktop' && (
                <button type="button" disabled={busy} onClick={() => onDisconnect(c)} className="cursor-pointer text-[11.5px] md:text-[10px] text-fgdim hover:text-err">{t('setup.connections.disconnect')}</button>
              )}
              <button type="button" className={c.ok ? 'cursor-pointer text-[11.5px] md:text-[10.5px] text-fgdim hover:text-fg' : BTN_PRIMARY} onClick={() => onOpen(c)}>
                {c.ok ? <><Icon icon={faCheck} /> {t('setup.connections.reconnect')}</> : t('setup.connections.connect')}
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
