import { useEffect, useState } from 'react';
import { fmtTokens, contextColor } from './ui.jsx';
import { useT } from '../lib/i18n.js';
import { api } from '../lib/api.js';
import { supportsCompaction } from '../lib/engines.js';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Input } from './ui/input.jsx';
import { Label } from './ui/label.jsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.jsx';

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[min(30rem,calc(100vw-1.5rem))] gap-0 p-0" showClose={false}>
        <DialogHeader className="flex-row items-center justify-between gap-2 border-b border-border px-5 py-3.5 pe-5">
          <DialogTitle>{t('dialogs.contextWindow')}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-xs tabular-nums">
            <span className="font-medium" style={{ color: pct >= 75 ? contextColor(pct) : undefined }}>{pct}%</span>
            <span>{fmtTokens(used)} / {fmtTokens(win)}{assumed ? ` (${t('dialogs.ctxWindowAssumed')})` : ''}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4">
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
              <div key={r.key} className="flex items-center gap-2 text-xs">
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: r.color }} />
                <span className="flex-1 text-foreground">{r.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{fmtTokens(r.tokens)}</span>
                <span className="w-[2.25rem] text-end text-xs text-muted-foreground tabular-nums">{r.pct}%</span>
              </div>
            ))}
          </div>
        </div>

        {!canCompact && (
          <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{t('dialogs.ctxNoCompactionCodex')}</div>
        )}
        {canCompact && <div className="border-t border-border px-5 py-3">
          <div className="flex items-center gap-2.5 text-sm">
            <Checkbox
              id="ctx-auto-compact"
              checked={enabled}
              onCheckedChange={(v) => applyAutoCompact(v ? autoCompactPct : null)}
            />
            <Label htmlFor="ctx-auto-compact" className="flex-1 cursor-pointer text-foreground">{t('dialogs.autoCompactWhenReaches')}</Label>
            <Input
              type="number"
              min={50}
              max={95}
              value={autoCompactPct}
              disabled={!enabled}
              aria-label={t('dialogs.autoCompactWhenReaches')}
              onChange={(e) => setAutoCompactPct(Number(e.target.value))}
              onBlur={() => enabled && applyAutoCompact(autoCompactPct)}
              onKeyDown={(e) => { if (e.key === 'Enter' && enabled) applyAutoCompact(autoCompactPct); }}
              className="h-7 w-14 px-1.5 text-end text-xs tabular-nums"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
          <div className="mt-1.5 ps-6 text-xs text-muted-foreground">{t('dialogs.ctxAutoCompactRestartNote')}</div>
        </div>}

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {canCompact && (
            <Button variant="primary" disabled={compacting} onClick={compactNow}>
              {compacting ? t('dialogs.compacting') : t('dialogs.compactNow')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>{t('dialogs.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
