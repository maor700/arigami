// S2 — bits every setup step shares (styles, error box, status pill). The
// same components render inside a chat card (SetupCard), the first-run
// wizard, the Setup screen and Settings → Connections, so they use the
// neutral panel palette rather than the chat's term-accent variables.
import { Icon } from '../ChatIcon.jsx';
import { useT } from '../../lib/i18n.js';
import { serverText } from '../../lib/server-text.js';
import { faCheck, faCircleNotch } from '@fortawesome/free-solid-svg-icons';

import { buttonVariants } from '../ui/button.jsx';
import { StatusDot } from '../ui/badge.jsx';

// Buttons: BTN is THE primary action of its card (accent), BTN2 the neutral
// secondary. Both are ui/Button classes, so 44px under a coarse pointer.
export const BTN = `cursor-pointer ${buttonVariants({ variant: 'primary' })}`;
export const BTN2 = `cursor-pointer ${buttonVariants({ variant: 'outline' })}`;
export const BTN_SM = `cursor-pointer ${buttonVariants({ variant: 'primary', size: 'sm' })}`;
export const BTN2_SM = `cursor-pointer ${buttonVariants({ variant: 'outline', size: 'sm' })}`;
export const INPUT = 'w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] text-fg outline-none focus:border-ring coarse:min-h-11';
export const CARD = 'rounded-lg border border-border bg-panel';
export const BODY = 'text-[13px] leading-relaxed text-fgdim';
export const OK = 'text-[13px] font-medium text-ok';

// status → the dot colour of the neutral chip (colour lives in the dot only)
const PILL_DOT = { ok: 'ok', done: 'ok', todo: 'warn', pending: 'warn', error: 'err', failed: 'err', blocked: 'idle', skipped: 'idle', timeout: 'idle', running: 'info', auto: 'info' };
// kept for callers that read the old map (Wizard): neutral chip classes
export const PILL = Object.fromEntries(Object.keys(PILL_DOT).map((k) => [k, 'border-transparent bg-muted text-muted-foreground']));

export function Pill({ status, label }) {
  const t = useT();
  return (
    <span data-pill={status} className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground uppercase">
      <StatusDot status={PILL_DOT[status] || 'idle'} pulse={status === 'running' || status === 'auto'} />
      {label ?? t(`setup.state.${status}`)}
    </span>
  );
}

export function ErrorBox({ err }) {
  if (!err) return null;
  return (
    <div dir="auto" className="mt-3 rounded-md border border-[var(--hb-err-line)] bg-[var(--hb-err-bg)] px-3 py-2 text-xs text-fg"><span aria-hidden="true" className="me-2 inline-block size-1.5 rounded-full bg-err align-middle" />
      {serverText(String(err).replace(/^HTTP \d+ — /, ''))}
    </div>
  );
}

export function OkLine({ children }) {
  return <div className={`mt-3 ${OK}`}><Icon icon={faCheck} /> {children}</div>;
}

export function Spinner({ children }) {
  return <div className="text-[13px] text-fgdim"><Icon icon={faCircleNotch} spin /> {children}</div>;
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
