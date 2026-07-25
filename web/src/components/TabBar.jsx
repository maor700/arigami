import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { tabSrc } from '../lib/hostUrl.js';
import { Wave, Dot, YellowButton } from './ui.jsx';
import { Truncate } from './Truncate.jsx';
import { Icon } from '../lib/icons.js';
import { faBars, faFolderTree, faPlusMinus, faXmark } from '@fortawesome/free-solid-svg-icons';

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
  if (kind === 'dot') {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: obj?.color || '#3C9A4E',
          boxShadow: `0 0 0 2px ${obj?.color ? 'rgba(0,0,0,0.08)' : 'rgba(60,154,78,0.18)'}`,
        }}
      />
    );
  }
  if (kind === 'external') return <span className="text-[11px] text-fgdim">↗</span>;
  const text = obj ? (obj.text ?? obj.count ?? obj.value ?? '') : badge;
  return <span className="shrink-0 font-mono text-[10px] text-fgdim">{String(text)}</span>;
}

function isExternal(tab) {
  return (
    tab.external === true ||
    tab.badge === 'external' ||
    tab.badge === '↗' ||
    (typeof tab.badge === 'object' && tab.badge?.type === 'external')
  );
}

function AddTabPopover({ sessionId, onClose }) {
  const ref = useRef(null);
  const urlRef = useRef(null);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    urlRef.current?.focus();
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

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
    <div
      ref={ref}
      className="absolute top-[42px] right-0 z-30 w-[280px] rounded-[10px] border-[1.5px] border-ink bg-panel p-3 shadow-[3px_3px_0_rgba(42,42,42,0.18)]"
    >
      <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-fgdim uppercase">
        Open a URL as a tab
      </div>
      <input
        ref={urlRef}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="http://localhost:3021/…"
        className="mb-2 w-full rounded-lg border-[1.5px] border-ink px-2.5 py-2 font-mono text-[11.5px] outline-none placeholder:text-fgdim"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Title (optional)"
        className="mb-2.5 w-full rounded-lg border-[1.5px] border-border px-2.5 py-2 text-xs outline-none placeholder:text-fgdim focus:border-fgdim"
      />
      {error && <div className="mb-2 text-[11px] text-danger">{error}</div>}
      <YellowButton
        onClick={submit}
        disabled={busy || !url.trim()}
        className="w-full px-3 py-2 text-xs"
      >
        {busy ? 'Opening…' : 'Open tab'}
      </YellowButton>
    </div>
  );
}

export default function TabBar({ session, tabs: tabsProp, activeTabId, onActivate, addOpen, setAddOpen }) {
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

  return (
    <div className="relative z-10 flex h-11 shrink-0 items-stretch border-b border-hair bg-panel px-3">
      {/* session-color edge strip */}
      <span
        className="absolute top-0 bottom-0 left-0 w-[3px]"
        style={{ background: color }}
      />
      {/* mobile: hamburger opens the rail drawer (there's no separate top bar
          over a session — this row is the top bar) */}
      <button
        type="button"
        aria-label="Open sessions"
        onClick={() => window.dispatchEvent(new CustomEvent('host:open-rail'))}
        className="mr-2 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-center rounded-[7px] border-[1.5px] border-border bg-bg text-[13px] text-fg md:hidden"
      >
        <Icon icon={faBars} />
      </button>
      {/* brand glyph */}
      <span className="hidden shrink-0 items-center pr-[11px] md:flex">
        <Wave />
      </span>

      <div className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const isSession = tab.type === 'session';
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => activate(tab)}
              className={`group flex cursor-pointer items-center gap-1.5 border-b-2 px-2.5 text-xs ${
                active
                  ? 'border-brand font-bold text-fg'
                  : 'border-transparent text-fgdim hover:text-fg'
              } ${isSession ? 'min-w-0 flex-[0_1_auto]' : 'shrink-0'}`}
            >
              {isSession ? (
                <>
                  <Dot color={color} size={10} />
                  <Truncate text={tab.title || 'Session'} className="min-w-0" />
                  {awaiting && (
                    <span className="pulse-yellow h-[7px] w-[7px] shrink-0 rounded-full bg-brand" />
                  )}
                </>
              ) : tab.type === 'changes' ? (
                <>
                  <span className="shrink-0 text-[12px] leading-none text-fgdim"><Icon icon={faPlusMinus} /></span>
                  <span className="shrink-0">{tab.title || 'Changes'}</span>
                </>
              ) : tab.type === 'orchestration' ? (
                <>
                  <span className="shrink-0 text-[12px] leading-none text-fgdim"><Icon icon={faFolderTree} /></span>
                  <span className="shrink-0">{tab.title || 'Orchestration'}</span>
                </>
              ) : (
                <>
                  <span
                    className="h-[13px] w-[13px] shrink-0 rounded-[3px]"
                    style={{ background: tab.color || '#d8d8d8' }}
                  />
                  <Truncate text={tab.title || tab.type} className="max-w-[140px]" />
                  <Badge badge={tab.badge} />
                  <span
                    role="button"
                    title="Close tab"
                    onClick={(e) => closeTab(e, tab)}
                    className="-mr-1 ml-0.5 hidden rounded px-0.5 text-[11px] text-fgdim hover:text-fg group-hover:inline [@media(pointer:coarse)]:inline"
                  >
                    <Icon icon={faXmark} />
                  </span>
                </>
              )}
            </button>
          );
        })}
        <button
          type="button"
          title="Open a URL as a tab (⌘T)"
          onClick={() => setAddOpen((v) => !v)}
          className="shrink-0 cursor-pointer border-b-2 border-transparent px-[9px] text-[15px] leading-none text-fgdim hover:text-fg"
        >
          +
        </button>
      </div>
      <div className="ml-auto shrink-0" />
      {addOpen && <AddTabPopover sessionId={session.id} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
