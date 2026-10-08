// S2 — bits every setup step shares (styles, error box, status pill). The
// same components render inside a chat card (SetupCard), the first-run
// wizard, the Setup screen and Settings → Connections, so they use the
// neutral panel palette rather than the chat's term-accent variables.
import { Icon } from '../../lib/icons.js';
import { useT } from '../../lib/i18n.js';
import { faTriangleExclamation, faCheck, faCircleNotch } from '@fortawesome/free-solid-svg-icons';

export const BTN = 'cursor-pointer rounded-[9px] border-[1.5px] border-ink bg-brand px-4 py-2 text-[13px] font-bold text-[#1a1a1a] disabled:cursor-default disabled:opacity-50';
export const BTN2 = 'cursor-pointer rounded-[9px] border-[1.5px] border-border bg-panel px-4 py-2 text-[12.5px] font-semibold text-fgdim hover:border-ink hover:text-fg disabled:opacity-50';
export const BTN_SM = 'cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-2.5 py-1 text-[11px] font-bold text-[#1a1a1a] disabled:opacity-50';
export const BTN2_SM = 'cursor-pointer rounded-[7px] border-[1.5px] border-border bg-panel px-2.5 py-1 text-[11px] font-semibold text-fgdim hover:border-ink hover:text-fg disabled:opacity-50';
export const INPUT = 'w-full rounded-[8px] border-[1.5px] border-border bg-bg px-3 py-2 text-[12.5px] text-fg outline-none focus:border-ink';
export const CARD = 'rounded-[12px] border-[1.5px] border-ink bg-panel';
export const BODY = 'text-[12.5px] leading-relaxed text-fgdim';
export const OK = 'text-[12.5px] font-semibold text-ok';

export const PILL = {
  ok: 'border-ok-line bg-ok-bg text-ok',
  done: 'border-ok-line bg-ok-bg text-ok',
  todo: 'border-warn-line bg-warn-bg text-warn',
  pending: 'border-warn-line bg-warn-bg text-warn',
  error: 'border-err-line bg-err-bg text-err',
  failed: 'border-err-line bg-err-bg text-err',
  blocked: 'border-hair bg-chip text-fgdim',
  skipped: 'border-hair bg-chip text-fgdim',
  timeout: 'border-hair bg-chip text-fgdim',
  running: 'border-info-line bg-info-bg text-info',
  auto: 'border-info-line bg-info-bg text-info',
};

export function Pill({ status, label }) {
  const t = useT();
  return (
    <span className={`shrink-0 rounded-full border px-2 py-px text-[11px] md:text-[9.5px] font-bold uppercase ${PILL[status] || PILL.blocked}`}>
      {label ?? t(`setup.state.${status}`)}
    </span>
  );
}

export function ErrorBox({ err }) {
  if (!err) return null;
  return (
    <div dir="auto" className="mt-3 rounded-[8px] border border-err-line bg-err-bg px-3 py-2 text-[11.5px] text-err">
      <Icon icon={faTriangleExclamation} /> {String(err).replace(/^HTTP \d+ — /, '')}
    </div>
  );
}

export function OkLine({ children }) {
  return <div className={`mt-3 ${OK}`}><Icon icon={faCheck} /> {children}</div>;
}

export function Spinner({ children }) {
  return <div className="text-[12px] text-fgdim"><Icon icon={faCircleNotch} spin /> {children}</div>;
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
