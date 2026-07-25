import { useEffect, useRef, useState } from 'react';
import { Dot, sessionLabel } from './ui.jsx';
import { needsAttention } from '../lib/store.js';
import { Icon } from '../lib/icons.js';

// ⌘K command palette: fuzzy-filter sessions AND commands, then run/jump. Arrow
// keys move, Enter runs, Esc closes. Empty query lists sessions (the fast
// jump-to path); typing also surfaces matching commands (open Settings, new
// session, archive current, …) so everything is reachable keyboard-only.
export default function QuickSwitcher({ sessions, selectedId, onSelect, onClose, actions = [] }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const live = sessions.filter((s) => !s.archived);
  const needle = q.trim().toLowerCase();
  const sessionMatches = needle
    ? live.filter((s) =>
        `${sessionLabel(s)} ${s.metadata?.ticket || ''} ${s.title || ''}`.toLowerCase().includes(needle),
      )
    : live;
  const actionMatches = needle
    ? actions.filter((a) => `${a.label} ${a.keywords || ''}`.toLowerCase().includes(needle))
    : [];
  // Commands first when searching (they're the intent of a typed query), then
  // sessions. One flat list so arrow-nav crosses both.
  const items = [
    ...actionMatches.map((a) => ({ kind: 'action', a })),
    ...sessionMatches.map((s) => ({ kind: 'session', s })),
  ];

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = (item) => {
    if (!item) return;
    onClose();
    if (item.kind === 'action') item.a.run();
    else onSelect(item.s.id);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(items[active]); return; }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-[rgba(20,20,22,0.45)] p-5 pt-[12vh]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[440px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search sessions and commands…"
          className="w-full border-b border-hair bg-transparent px-4 py-3 text-[13px] outline-none placeholder:text-[#aaa]"
        />
        <div className="thin-scroll max-h-[50vh] overflow-auto py-1.5">
          {items.length === 0 && (
            <div className="px-4 py-3 text-[12px] text-fgdim">No sessions or commands match “{q}”.</div>
          )}
          {items.map((item, i) => {
            const isActive = i === active;
            if (item.kind === 'action') {
              const a = item.a;
              return (
                <button
                  key={`a:${a.id}`}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(item)}
                  className={`flex w-full items-center gap-2.5 px-4 py-2 text-left ${isActive ? 'bg-hair' : ''}`}
                >
                  <span className="w-[11px] shrink-0 text-center text-[11px] text-fgdim">{a.icon ? typeof a.icon === 'string' ? a.icon : <Icon icon={a.icon} /> : '⌘'}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{a.label}</span>
                  <span className="font-mono text-[9.5px] tracking-wide text-fgdim uppercase">command</span>
                </button>
              );
            }
            const s = item.s;
            const attn = needsAttention(s);
            const working = s.claude?.state === 'working';
            return (
              <button
                key={`s:${s.id}`}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => run(item)}
                className={`flex w-full items-center gap-2.5 px-4 py-2 text-left ${isActive ? 'bg-hair' : ''}`}
              >
                <Dot color={s.color} size={11} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{sessionLabel(s)}</span>
                {s.id === selectedId && (
                  <span className="font-mono text-[9.5px] tracking-wide text-fgdim uppercase">current</span>
                )}
                {working && <span className="pulse-yellow h-[7px] w-[7px] shrink-0 rounded-full bg-brand" />}
                {attn && !working && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-danger" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-hair px-4 py-2 font-mono text-[10px] text-fgdim">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
