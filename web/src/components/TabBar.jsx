import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, FolderTree, Menu, Plus, Diff, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { tabSrc } from '../lib/hostUrl.js';
import { useStore } from '../lib/store.js';
import { extTabItems } from '../lib/ext.js';
import { Dot } from './ui.jsx';
import { Truncate } from './Truncate.jsx';
import { useT } from '../lib/i18n.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.jsx';
import { Tip } from './ui/tooltip.jsx';

function Badge({ badge }) {
  if (badge == null || badge === '') return null;
  const obj = typeof badge === 'object' ? badge : null;
  const kind =
    obj?.type ||
    (typeof badge === 'number'
      ? 'count'
      : badge === 'dot'
        ? 'dot'
        : badge === 'external' || badge === '↗'
          ? 'external'
          : 'text');
  // A tab's dot badge keeps the colour the agent gave it (default: the "ok" green).
  if (kind === 'dot') {
    return <span className="size-1.5 shrink-0 rounded-full" style={{ background: obj?.color || 'var(--hb-ok)' }} />;
  }
  if (kind === 'external') return <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-label="external" />;
  const text = obj ? (obj.text ?? obj.count ?? obj.value ?? '') : badge;
  return <span className="shrink-0 rounded-sm bg-muted px-1 text-2xs tabular-nums text-muted-foreground">{String(text)}</span>;
}

function isExternal(tab) {
  return (
    tab.external === true ||
    tab.badge === 'external' ||
    tab.badge === '↗' ||
    (typeof tab.badge === 'object' && tab.badge?.type === 'external')
  );
}

// The "+" popover: a URL tab (the bar's own address field) or any tab an active
// extension declares. Controlled by the parent so ⌘T can toggle it.
function AddTabForm({ sessionId, onClose }) {
  const t = useT();
  const urlRef = useRef(null);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // EXT: every tab an active extension declares is openable from here, exactly
  // like `open_tab({type:'ext'})` — the human is not worse off than the agent.
  const { extensions } = useStore();
  const extTabs = useMemo(() => extTabItems(extensions), [extensions]);

  useEffect(() => {
    urlRef.current?.focus();
  }, []);

  const openExt = async (row) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const tab = await api.post(`/sessions/${sessionId}/tabs`, { type: 'ext', ext: row.ext, tab: row.tab });
      if (tab?.id) await api.post(`/sessions/${sessionId}/activate-tab`, { tabId: tab.id });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  const submit = async () => {
    if (busy) return; // guard: Enter can fire while the POST is already in flight
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
    let name = title.trim();
    if (!name) {
      try {
        name = new URL(target).host;
      } catch {
        name = 'Tab';
      }
    }
    setBusy(true);
    setError(null);
    try {
      const tab = await api.post(`/sessions/${sessionId}/tabs`, {
        type: 'url',
        title: name,
        url: target,
      });
      if (tab?.id) await api.post(`/sessions/${sessionId}/activate-tab`, { tabId: tab.id });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <>
      {extTabs.length > 0 && (
        <div className="mb-3 border-b border-border pb-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            {t('ext.tabs.heading')}
          </div>
          <div className="flex flex-col gap-0.5">
            {extTabs.map((row) => (
              <button
                key={`${row.ext}/${row.tab}`}
                type="button"
                disabled={busy}
                onClick={() => openExt(row)}
                className="flex min-h-8 cursor-pointer items-baseline gap-1.5 rounded-md px-2 py-1 text-start text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50 coarse:min-h-11 coarse:items-center"
              >
                <span className="min-w-0 truncate">{row.title}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">{row.extTitle}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {t('rail.openUrlAsTab')}
      </div>
      <Input
        ref={urlRef}
        value={url}
        dir="ltr"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="http://localhost:3021/…"
        className="mb-2 font-mono text-xs"
      />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={t('rail.titleOptional')}
        className="mb-3"
      />
      {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
      <Button variant="default" onClick={submit} disabled={busy || !url.trim()} className="w-full">
        {busy ? t('rail.opening') : t('rail.openTab')}
      </Button>
    </>
  );
}

// `embedded`: the bar sits under another header that already carries the
// mobile hamburger (the agent page) — skip it here.
export default function TabBar({ session, tabs: tabsProp, activeTabId, onActivate, addOpen, setAddOpen, embedded = false }) {
  const t = useT();
  const tabs = tabsProp?.length
    ? tabsProp
    : session.tabs?.length
      ? session.tabs
      : [{ id: '__session', type: 'session' }];
  const color = session.color || '#c4c4c4';
  const awaiting =
    /review/i.test(session.status || '') || session.claude?.state === 'awaiting-input';

  const activate = (tab) => {
    if (isExternal(tab) && tab.url) {
      // proxied → reachable from any device (the raw url may be host-localhost)
      window.open(tabSrc(tab.url), '_blank', 'noopener');
      return;
    }
    if (onActivate) {
      onActivate(tab);
      return;
    }
    if (tab.id !== activeTabId) {
      api.post(`/sessions/${session.id}/activate-tab`, { tabId: tab.id }).catch(() => {});
    }
  };

  const closeTab = (e, tab) => {
    e.stopPropagation();
    api.del(`/sessions/${session.id}/tabs/${tab.id}`).catch(() => {});
  };

  // On a phone the strip is far narrower than its tabs, so it scrolls. Without
  // this, opening a session whose active tab is the 6th one showed tabs 1–3 and
  // no hint that the tab you are looking at is off to the side.
  const stripRef = useRef(null);
  useEffect(() => {
    const el = stripRef.current?.querySelector('[data-tab-active="1"]');
    if (!el || !stripRef.current) return;
    if (stripRef.current.scrollWidth <= stripRef.current.clientWidth + 4) return;
    el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [activeTabId, tabs.length]);

  // The tab itself: hairline row, the active one carries a 2px neutral
  // underline (tabs are navigation, not the primary action).
  const tabCls = (active) =>
    `group relative flex h-full shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-sm outline-none after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
      active ? 'font-medium text-foreground after:bg-foreground' : 'text-muted-foreground after:bg-transparent hover:text-foreground'
    }`;

  return (
    <div className="relative z-10 flex h-11 shrink-0 items-stretch border-b border-border bg-background ps-1 pe-2 md:ps-3">
      {/* mobile: hamburger opens the rail drawer (there's no separate top bar
          over a session — this row is the top bar) */}
      {!embedded && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('rail.openSessions')}
          onClick={() => window.dispatchEvent(new CustomEvent('host:open-rail'))}
          className="me-1 shrink-0 self-center text-muted-foreground md:hidden"
        >
          <Menu />
        </Button>
      )}

      <div
        ref={stripRef}
        role="tablist"
        className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const isSession = tab.type === 'session';
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              data-tab-active={active ? '1' : '0'}
              onClick={() => activate(tab)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  activate(tab);
                }
              }}
              className={`${tabCls(active)} ${isSession ? 'min-w-[7.5rem] md:min-w-[4rem] md:flex-[0_1_auto]' : ''}`}
            >
              {isSession ? (
                <>
                  <Dot color={color} size={8} />
                  <Truncate text={tab.title && tab.title !== 'Session' ? tab.title : t('rail.tabSession')} className="min-w-0" />
                  {awaiting && <span className="pulse-yellow size-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />}
                </>
              ) : tab.type === 'changes' ? (
                <>
                  <Diff className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0">{tab.title || t('rail.tabChanges')}</span>
                </>
              ) : tab.type === 'orchestration' ? (
                <>
                  <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0">{tab.title || t('rail.tabOrchestration')}</span>
                </>
              ) : (
                <>
                  <span
                    className="size-3 shrink-0 rounded-[3px]"
                    style={{ background: tab.color || 'var(--hb-faint)' }}
                  />
                  <Truncate text={tab.title || tab.type} className="max-w-[8.75rem]" />
                  <Badge badge={tab.badge} />
                  <Tip label={t('rail.closeTab')}>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={t('rail.closeTab')}
                      onClick={(e) => closeTab(e, tab)}
                      className="-me-1 ms-0.5 hidden size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground group-hover:inline-flex coarse:inline-flex coarse:size-8"
                    >
                      <X className="size-3.5" />
                    </span>
                  </Tip>
                </>
              )}
            </div>
          );
        })}
        <Popover open={!!addOpen} onOpenChange={setAddOpen}>
          <Tip label={t('rail.openUrlAsTabCmd')}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('rail.openUrlAsTabCmd')}
                data-add-tab
                className="shrink-0 self-center text-muted-foreground"
              >
                <Plus />
              </Button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="start" className="w-[17.5rem]" onOpenAutoFocus={(e) => e.preventDefault()}>
            <AddTabForm sessionId={session.id} onClose={() => setAddOpen(false)} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
