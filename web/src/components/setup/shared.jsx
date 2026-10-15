// S2 — bits every setup step shares (styles, error box, status pill). The
// same components render inside a chat card (SetupCard), the first-run
// wizard, the Setup screen and Settings → Connections, so they use the
// neutral panel palette rather than the chat's term-accent variables.
import { Icon } from '../ChatIcon.jsx';
import { useT } from '../../lib/i18n.js';
import { serverText } from '../../lib/server-text.js';
import { Badge } from '../ui/badge.jsx';
import { faTriangleExclamation, faCheck, faCircleNotch } from '@fortawesome/free-solid-svg-icons';

const B = 'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border text-sm font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50';
export const BTN = `${B} min-h-9 border-transparent bg-primary px-4 py-1.5 text-primary-foreground hover:bg-[var(--accent-hover)] coarse:min-h-11`;
export const BTN2 = `${B} min-h-9 border-input bg-card px-4 py-1.5 text-foreground hover:bg-muted coarse:min-h-11`;
export const BTN_SM = `${B} h-7 border-transparent bg-primary px-2.5 text-xs text-primary-foreground hover:bg-[var(--accent-hover)] coarse:min-h-11`;
export const BTN2_SM = `${B} h-7 border-input bg-card px-2.5 text-xs text-foreground hover:bg-muted coarse:min-h-11`;
export const INPUT = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-fg outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 coarse:h-11';
export const CARD = 'rounded-lg border border-hair bg-panel';
export const BODY = 'text-sm leading-relaxed text-fgdim';
export const OK = 'text-sm font-medium text-ok';

// Kept for importers: status → text/border classes (neutral chip look).
export const PILL = {
  ok: 'border-hair bg-chip text-fgdim', done: 'border-hair bg-chip text-fgdim', todo: 'border-hair bg-chip text-fgdim', pending: 'border-hair bg-chip text-fgdim',
  error: 'border-hair bg-chip text-fgdim', failed: 'border-hair bg-chip text-fgdim', blocked: 'border-hair bg-chip text-fgdim', skipped: 'border-hair bg-chip text-fgdim',
  timeout: 'border-hair bg-chip text-fgdim', running: 'border-hair bg-chip text-fgdim', auto: 'border-hair bg-chip text-fgdim',
};
const PILL_DOT = { ok: 'ok', done: 'ok', todo: 'warn', pending: 'warn', error: 'err', failed: 'err', running: 'info', auto: 'info' };

export function Pill({ status, label }) {
  const t = useT();
  return <Badge status={PILL_DOT[status] || 'idle'}>{label ?? t(`setup.state.${status}`)}</Badge>;
}

export function ErrorBox({ err }) {
  if (!err) return null;
  return (
    <div dir="auto" className="mt-3 rounded-md border border-err-line bg-err-bg px-3 py-2 text-xs text-err">
      <Icon icon={faTriangleExclamation} /> {serverText(String(err).replace(/^HTTP \d+ — /, ''))}
    </div>
  );
}

export function OkLine({ children }) {
  return <div className={`mt-3 ${OK}`}><Icon icon={faCheck} /> {children}</div>;
}

export function Spinner({ children }) {
  return <div className="text-xs text-fgdim"><Icon icon={faCircleNotch} spin /> {children}</div>;
}

// Shared async-action helper: `run(fn)` → busy flag + error string.
import { useState, useCallback } from 'react';
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr(e?.message || String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, err, run, setErr };
}
