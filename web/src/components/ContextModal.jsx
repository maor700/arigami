import { useEffect } from 'react';
import { fmtTokens, contextColor } from './ui.jsx';
import { usePrefs, setPrefs } from '../lib/prefs.js';

// Context categories we can derive from the stream-json usage block. (Claude
// Code's /context splits further — system prompt, tools, memory… — but the
// stream doesn't expose those, so we show the honest token-level breakdown.)
const CATS = [
  { key: 'cacheRead', label: 'Cached context', color: '#6b8db5' },
  { key: 'cacheCreation', label: 'Cache write', color: '#4aa3a3' },
  { key: 'input', label: 'Fresh input', color: '#caa53d' },
];

const COLS = 20;
const ROWS = 10;
const CELLS = COLS * ROWS; // each cell ≈ 1/200th of the window

// A grid "context view" like /context: each cell is a slice of the window,
// coloured by what occupies it; the rest is free space.
export default function ContextModal({ usage, onClose }) {
  const prefs = usePrefs();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const win = usage?.ctxWindow || 200000;
  const used = usage?.ctxTokens || 0;
  const bd = usage?.breakdown || {};
  const pct = Math.min(100, usage?.ctxPct ?? Math.round((used / win) * 100));
  const freeTokens = Math.max(0, win - used);

  const segs = CATS.map((c) => {
    const tokens = bd[c.key] || 0;
    return { ...c, tokens, cells: Math.round((tokens / win) * CELLS), pct: Math.round((tokens / win) * 100) };
  });

  // Lay the coloured cells out sequentially, then fill the remainder as free.
  const cells = [];
  for (const s of segs) for (let i = 0; i < s.cells && cells.length < CELLS; i++) cells.push(s.color);
  while (cells.length < CELLS) cells.push(null);

  const rows = [...segs, {
    key: 'free', label: 'Free space', color: 'var(--color-border)',
    tokens: freeTokens, pct: Math.max(0, 100 - pct),
  }];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,22,0.5)] p-5"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[480px] max-w-full overflow-hidden rounded-xl border-2 border-ink bg-panel text-fg shadow-[5px_6px_0_rgba(42,42,42,0.25)]"
      >
        <div className="flex items-center justify-between border-b border-hair px-[18px] py-3">
          <div className="text-[15px] font-bold">Context window</div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-fgdim">
            <span className="font-bold" style={{ color: contextColor(pct) }}>{pct}%</span>
            <span>{fmtTokens(used)} / {fmtTokens(win)}</span>
          </div>
        </div>

        <div className="px-[18px] py-4">
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
            {cells.map((c, i) => (
              <span
                key={i}
                className="aspect-square rounded-[2px]"
                style={{ background: c || 'var(--color-border)', opacity: c ? 1 : 0.5 }}
              />
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-1.5">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-2 text-[12px]">
                <span className="h-[11px] w-[11px] shrink-0 rounded-[3px]" style={{ background: r.color }} />
                <span className="flex-1 text-fg">{r.label}</span>
                <span className="font-mono text-[11px] text-fgdim tabular-nums">{fmtTokens(r.tokens)}</span>
                <span className="w-[34px] text-right font-mono text-[11px] text-fgdim tabular-nums">{r.pct}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-hair px-[18px] py-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-[12px]">
            <input
              type="checkbox"
              checked={prefs.autoCompact}
              onChange={(e) => setPrefs({ autoCompact: e.target.checked })}
              className="h-[14px] w-[14px] shrink-0 cursor-pointer accent-[var(--color-ink)]"
            />
            <span className="flex-1 text-fg">Auto-compact when context reaches</span>
            <input
              type="number"
              min={50}
              max={95}
              value={prefs.autoCompactPct}
              disabled={!prefs.autoCompact}
              onChange={(e) => setPrefs({ autoCompactPct: Number(e.target.value) })}
              className="w-[48px] rounded-md border-[1.5px] border-border bg-panel px-1.5 py-1 text-right font-mono text-[11px] tabular-nums text-fg focus:border-ink focus:outline-none disabled:opacity-40"
            />
            <span className="font-mono text-[11px] text-fgdim">%</span>
          </label>
          <div className="mt-1.5 pl-[24px] text-[11px] text-fgdim">
            Runs <span className="font-mono">/compact</span> once when this session is idle.
          </div>
        </div>

        <div className="flex justify-end border-t border-hair px-[18px] py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border-[1.5px] border-border bg-panel px-3 py-1.5 text-[12px] text-fgdim hover:border-ink hover:text-fg"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
