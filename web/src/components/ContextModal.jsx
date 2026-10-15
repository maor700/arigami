import { useEffect, useState } from 'react';
import { fmtTokens, contextColor } from './ui.jsx';
import { useT } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { supportsCompaction } from '../lib/engines.js';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Input } from './ui/input.jsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.jsx';

// Context categories we can derive from the stream-json usage block. (Claude
// Code's /context splits further — system prompt, tools, memory… — but the
// stream doesn't expose those, so we show the honest token-level breakdown.)
const CATS = [
  { key: 'cacheRead', labelKey: 'dialogs.ctxCachedContext', color: '#6b8db5' },
  { key: 'cacheCreation', labelKey: 'dialogs.ctxCacheWrite', color: '#4aa3a3' },
  { key: 'input', labelKey: 'dialogs.ctxFreshInput', color: '#caa53d' },
];

const COLS = 20;
const ROWS = 10;
const CELLS = COLS * ROWS; // each cell ≈ 1/200th of the window

// A grid "context view" like /context: each cell is a slice of the window,
// coloured by what occupies it; the rest is free space.
export default function ContextModal({ session, usage, onClose }) {
  const t = useT();
  const canCompact = supportsCompaction(session.engine);

  // Auto-compact is a real `claude --autocompact <tokens>` spawn flag now (not
  // a message injected into the conversation), so it's per-session and a
  // threshold change restarts the session — same trade-off as switching model.
  const enabled = session.claude?.autoCompactPct != null;
  const [autoCompactPct, setAutoCompactPct] = useState(session.claude?.autoCompactPct ?? 80);
  useEffect(() => { setAutoCompactPct(session.claude?.autoCompactPct ?? 80); }, [session.claude?.autoCompactPct]);

  const applyAutoCompact = (nextPct) => {
    api.post(`/sessions/${session.id}/autocompact`, { pct: nextPct }).catch(() => {});
  };

  const [compacting, setCompacting] = useState(false);
  const compactNow = async () => {
    setCompacting(true);
    try {
      await api.post(`/sessions/${session.id}/message`, { text: '/compact' });
    } catch {
      /* swallow — chat shows the outcome */
    }
    setCompacting(false);
  };

  const win = usage?.ctxWindow || 200000;
  // No usage yet (no turn sent this spawn) means we haven't seen the real
  // window either — treat that the same as an explicitly assumed one.
  const assumed = usage ? !!usage.ctxAssumed : true;
  const used = usage?.ctxTokens || 0;
  const bd = usage?.breakdown || {};
  const pct = Math.min(100, usage?.ctxPct ?? Math.round((used / win) * 100));
  const freeTokens = Math.max(0, win - used);

  const segs = CATS.map((c) => {
    const tokens = bd[c.key] || 0;
    return { ...c, label: t(c.labelKey), tokens, cells: Math.round((tokens / win) * CELLS), pct: Math.round((tokens / win) * 100) };
  });

  // Lay the coloured cells out sequentially, then fill the remainder as free.
  const cells = [];
  for (const s of segs) for (let i = 0; i < s.cells && cells.length < CELLS; i++) cells.push(s.color);
  while (cells.length < CELLS) cells.push(null);

  const rows = [...segs, {
    key: 'free', label: t('dialogs.ctxFreeSpace'), color: 'var(--color-border)',
    tokens: freeTokens, pct: Math.max(0, 100 - pct),
  }];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showClose={false} aria-describedby={undefined} className="w-[min(30rem,calc(100vw-1.5rem))] gap-0 p-0">
        <div className="flex items-center justify-between gap-3 border-b border-hair px-5 py-3">
          <DialogTitle className="text-sm">{t('dialogs.contextWindow')}</DialogTitle>
          <div className="flex items-center gap-2 text-xs text-fgdim tabular-nums" dir="ltr">
            <span className="font-medium" style={{ color: contextColor(pct) }}>{pct}%</span>
            <span>{fmtTokens(used)} / {fmtTokens(win)}{assumed ? ` (${t('dialogs.ctxWindowAssumed')})` : ''}</span>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="grid gap-[3px]" dir="ltr" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
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
              <div key={r.key} className="flex items-center gap-2 text-sm">
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: r.color }} />
                <span className="flex-1 text-fg">{r.label}</span>
                <span className="text-xs text-fgdim tabular-nums" dir="ltr">{fmtTokens(r.tokens)}</span>
                <span className="w-9 text-end text-xs text-fgdim tabular-nums" dir="ltr">{r.pct}%</span>
              </div>
            ))}
          </div>
        </div>

        {!canCompact && (
          <div className="border-t border-hair px-5 py-3 text-xs text-fgdim">{t('dialogs.ctxNoCompactionCodex')}</div>
        )}
        {canCompact && <div className="border-t border-hair px-5 py-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(v) => applyAutoCompact(v === true ? autoCompactPct : null)}
            />
            <span className="flex-1 text-fg">{t('dialogs.autoCompactWhenReaches')}</span>
            <Input
              type="number"
              min={50}
              max={95}
              dir="ltr"
              value={autoCompactPct}
              disabled={!enabled}
              onChange={(e) => setAutoCompactPct(Number(e.target.value))}
              onBlur={() => enabled && applyAutoCompact(autoCompactPct)}
              onKeyDown={(e) => { if (e.key === 'Enter' && enabled) applyAutoCompact(autoCompactPct); }}
              className="w-14 px-1.5 text-end tabular-nums"
            />
            <span className="text-xs text-fgdim">%</span>
          </label>
          <div className="mt-1.5 ps-6 text-xs text-fgdim">{t('dialogs.ctxAutoCompactRestartNote')}</div>
        </div>}

        <div className="flex items-center justify-end gap-2 border-t border-hair px-5 py-2.5">
          <Button onClick={onClose}>{t('dialogs.close')}</Button>
          {canCompact && <Button variant="primary" disabled={compacting} onClick={compactNow}>
            {compacting ? t('dialogs.compacting') : t('dialogs.compactNow')}
          </Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
