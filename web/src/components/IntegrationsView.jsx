// Integrations view — browse and connect Composio-powered integrations.
// Mirrors the full-pane pattern of SkillsView/AccountsView.
import { useEffect, useRef, useState, useMemo } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Icon } from '../lib/icons.js';
import { faXmark, faRotateRight, faCheck, faLink, faTriangleExclamation, faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';

const FEATURED = ['linear', 'gmail', 'googledrive', 'googledocs', 'whatsapp', 'facebook', 'twitter', 'slack', 'github', 'notion'];

function IntegrationCard({ toolkit, onConnect, onDisconnect, connecting }) {
  const t = useT();
  const busy = connecting === toolkit.slug;

  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border p-3 transition-colors ${
        toolkit.connected ? 'border-[#2f9c82]/40 bg-[#eaf4ef]' : 'border-hair bg-bg hover:border-border'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {toolkit.logo ? (
          <img
            src={toolkit.logo}
            alt={toolkit.name}
            className="h-9 w-9 shrink-0 rounded-lg border border-hair bg-white object-contain p-0.5"
            onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
          />
        ) : null}
        <div
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hair bg-chip text-[13px] font-bold text-fgdim"
          style={{ display: toolkit.logo ? 'none' : 'flex' }}
        >
          {(toolkit.name || '?')[0].toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-bold text-fg">{toolkit.name}</span>
            {toolkit.connected && (
              <span className="shrink-0 rounded-full bg-[#2f9c82] px-1.5 py-0.5 text-[9px] font-bold text-white">
                <Icon icon={faCheck} className="mr-0.5" />
                {t('integrations.connected')}
              </span>
            )}
          </div>
          {toolkit.description && (
            <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-fgdim">
              {toolkit.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end">
        {toolkit.connected ? (
          <button
            type="button"
            onClick={() => onDisconnect(toolkit.slug)}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-[#c0d9d4] bg-white px-2.5 py-1 text-[10.5px] text-[#2f9c82] hover:bg-[#ddf0eb] disabled:opacity-50"
          >
            {t('integrations.disconnect')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onConnect(toolkit.slug)}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-ink bg-brand px-2.5 py-1 text-[10.5px] font-bold text-fg hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('integrations.connecting') : t('integrations.connect')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsView({ onClose }) {
  const t = useT();
  const [data, setData] = useState(null);   // { toolkits, hasKey, error? }
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [connecting, setConnecting] = useState(null); // slug being connected
  const [notice, setNotice] = useState(null);          // { type: 'success'|'error', msg }
  // OAuth state
  const [oauthState, setOauthState] = useState(null); // null | 'starting' | 'waiting' | 'error'
  const [oauthError, setOauthError] = useState('');
  const pollRef = useRef(null);
  const sessionIdRef = useRef(null);

  // Clean up poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const startOAuth = async () => {
    setOauthState('starting');
    setOauthError('');
    try {
      const r = await api.post('/composio/auth/start', {});
      if (r.error) { setOauthState('error'); setOauthError(r.error); return; }
      sessionIdRef.current = r.sessionId;
      window.open(r.loginUrl, '_blank', 'noopener,noreferrer');
      setOauthState('waiting');
      // Poll until authenticated
      pollRef.current = setInterval(async () => {
        try {
          const s = await api.get(`/composio/auth/status?sessionId=${encodeURIComponent(sessionIdRef.current || '')}`);
          if (s.authenticated) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            sessionIdRef.current = null;
            setOauthState(null);
            load();
          }
        } catch {}
      }, 2000);
    } catch (e) {
      setOauthState('error');
      setOauthError(String(e?.message || e));
    }
  };

  const load = (cat = category) => {
    setLoading(true);
    api
      .get(`/composio/toolkits${cat && cat !== 'all' ? `?category=${encodeURIComponent(cat)}` : ''}`)
      .then((d) => setData(d))
      .catch((e) => setData({ error: String(e?.message || e), hasKey: false }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const categories = useMemo(() => {
    if (!data?.toolkits) return [];
    const cats = new Set();
    for (const t of data.toolkits) for (const c of (t.categories || [])) cats.add(c);
    return [...cats].sort();
  }, [data]);

  const toolkits = useMemo(() => {
    if (!data?.toolkits) return [];
    let list = data.toolkits;
    if (category === 'connected') list = list.filter((t) => t.connected);
    else if (category !== 'all') list = list.filter((t) => (t.categories || []).includes(category));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
    }
    // Featured on top
    return [
      ...list.filter((t) => FEATURED.includes(t.slug)),
      ...list.filter((t) => !FEATURED.includes(t.slug)),
    ];
  }, [data, category, search]);

  const connectedCount = data?.toolkits?.filter((t) => t.connected).length || 0;

  const handleConnect = async (slug) => {
    setConnecting(slug);
    setNotice(null);
    try {
      const r = await api.post('/composio/connect', { toolkitSlug: slug });
      if (r.error) { setNotice({ type: 'error', msg: r.error }); return; }
      if (r.redirectUrl) {
        window.open(r.redirectUrl, '_blank', 'noopener,noreferrer');
        setNotice({ type: 'success', msg: t('integrations.oauthOpened') });
        // Refresh after a delay so user can come back
        setTimeout(() => load(), 3000);
      }
    } catch (e) {
      setNotice({ type: 'error', msg: String(e?.message || e) });
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (slug) => {
    const toolkit = data?.toolkits?.find((t) => t.slug === slug);
    setConnecting(slug);
    setNotice(null);
    try {
      const conns = await api.get('/composio/connections').catch(() => ({ connections: [] }));
      const matching = (conns.connections || []).filter((c) => c.toolkit?.slug === slug);
      if (!matching.length) { setNotice({ type: 'error', msg: t('integrations.notFound') }); return; }
      const results = await Promise.all(matching.map((c) => api.del(`/composio/connections/${c.id}`)));
      const failed = results.find((r) => r.error);
      if (failed) { setNotice({ type: 'error', msg: failed.error }); return; }
      setNotice({ type: 'success', msg: t('integrations.disconnected', { name: toolkit?.name || slug }) });
      load();
    } catch (e) {
      setNotice({ type: 'error', msg: String(e?.message || e) });
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hair bg-panel px-4 py-2.5">
        <span className="text-[14px] font-bold text-fg">{t('integrations.title')}</span>
        {connectedCount > 0 && (
          <span className="rounded-full border border-[#2f9c82]/40 bg-[#eaf4ef] px-2 py-0.5 text-[10px] font-bold text-[#2f9c82]">
            {connectedCount} {t('integrations.connectedCount')}
          </span>
        )}
        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          title={t('integrations.refresh')}
          className="ml-auto cursor-pointer rounded-md border border-hair px-1.5 py-1 text-[12px] text-fgdim hover:border-ink hover:text-fg disabled:opacity-40"
        >
          <Icon icon={faRotateRight} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-hair text-fgdim hover:border-ink hover:text-fg"
          title={t('dialogs.close')}
        >
          <Icon icon={faXmark} />
        </button>
      </div>

      {/* Notice bar */}
      {notice && (
        <div
          className={`shrink-0 border-b px-4 py-2 text-[11px] ${
            notice.type === 'error'
              ? 'border-[#e2c4c0] bg-[#FBECEA] text-[#9c3b33]'
              : 'border-[#c0d9d4] bg-[#eaf4ef] text-[#1f7a5e]'
          }`}
        >
          {notice.msg}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Left sidebar: categories */}
        <div className="thin-scroll flex shrink-0 flex-col overflow-y-auto border-b border-hair bg-panel md:w-[180px] md:border-b-0 md:border-r">
          <div className="px-3 pt-3 pb-1 text-[9.5px] font-bold tracking-wide text-fgdim uppercase">
            {t('integrations.categories')}
          </div>
          {[
            { id: 'all', label: t('integrations.all') },
            { id: 'connected', label: t('integrations.connectedFilter'), badge: connectedCount || null },
            ...categories.map((c) => ({ id: c, label: c.charAt(0).toUpperCase() + c.slice(1) })),
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => { setCategory(cat.id); load(cat.id === 'connected' ? '' : cat.id); }}
              className={`flex items-center justify-between border-b border-hair px-3 py-1.5 text-left text-[11.5px] ${
                category === cat.id ? 'bg-chip font-bold text-fg' : 'text-fgdim hover:bg-chip/60'
              }`}
            >
              <span className="truncate">{cat.label}</span>
              {cat.badge ? (
                <span className="ml-1 shrink-0 rounded-full bg-[#2f9c82] px-1.5 text-[9px] font-bold text-white">
                  {cat.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Main content */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Search */}
          <div className="shrink-0 border-b border-hair bg-bg px-3 py-2">
            <input
              type="search"
              placeholder={t('integrations.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-hair bg-panel px-3 py-1.5 text-[12px] text-fg outline-none placeholder:text-fgdim focus:border-ink"
            />
          </div>

          {/* No key configured — OAuth login */}
          {data && !data.hasKey && !data.toolkits && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-hair bg-panel text-[30px] text-fgdim">
                <Icon icon={faLink} />
              </div>
              <div>
                <div className="text-[14px] font-bold text-fg">{t('integrations.noKey.title')}</div>
                <div className="mt-1 max-w-sm text-[12px] text-fgdim">{t('integrations.noKey.body')}</div>
              </div>
              {oauthState === 'waiting' ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2 rounded-xl border border-hair bg-panel px-4 py-3 text-[12px] text-fgdim">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fgdim border-t-transparent" />
                    {t('integrations.oauth.waiting')}
                  </div>
                  <button
                    type="button"
                    onClick={() => { clearInterval(pollRef.current); pollRef.current = null; sessionIdRef.current = null; setOauthState(null); }}
                    className="text-[11px] text-fgdim underline"
                  >
                    {t('integrations.oauth.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startOAuth}
                  disabled={oauthState === 'starting'}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border-[1.5px] border-ink bg-brand px-5 py-2.5 text-[13px] font-bold text-fg hover:opacity-90 disabled:opacity-50"
                >
                  {oauthState === 'starting' ? t('integrations.oauth.starting') : (
                    <><Icon icon={faArrowUpRightFromSquare} className="text-[12px]" /> {t('integrations.oauth.button')}</>
                  )}
                </button>
              )}
              {oauthState === 'error' && (
                <div className="max-w-sm rounded-lg border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[11px] text-[#9c3b33]">
                  {oauthError}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {data?.error && data.hasKey && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="text-[28px] text-[#9c3b33]"><Icon icon={faTriangleExclamation} /></span>
              <div className="max-w-md text-[12px] text-[#9c3b33]">{data.error}</div>
              <button
                type="button"
                onClick={() => load()}
                className="cursor-pointer rounded-lg border border-ink bg-panel px-3 py-1.5 text-[11.5px] font-bold text-fg hover:bg-chip"
              >
                {t('dialogs.retry')}
              </button>
            </div>
          )}

          {/* Loading */}
          {loading && !data && (
            <div className="flex flex-1 items-center justify-center text-[12px] text-fgdim">
              {t('dialogs.loading')}
            </div>
          )}

          {/* Grid */}
          {data?.toolkits && (
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3">
              {toolkits.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-16 text-[12px] text-fgdim">
                  {t('integrations.empty')}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {toolkits.map((toolkit) => (
                    <IntegrationCard
                      key={toolkit.slug}
                      toolkit={toolkit}
                      onConnect={handleConnect}
                      onDisconnect={handleDisconnect}
                      connecting={connecting}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
