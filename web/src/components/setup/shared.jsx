// S2 — bits every setup step shares (styles, error box, status pill). The
// same components render inside a chat card (SetupCard), the first-run
// wizard, the Setup screen and Settings → Connections, so they use the
// neutral panel palette rather than the chat's term-accent variables.
import { Icon } from '../../lib/icons.js';
import { useT } from '../../lib/i18n.js';
import { faTriangleExclamation, faCheck, faCircleNotch } from '@fortawesome/free-solid-svg-icons';

export const BTN = 'cursor-pointer rounded-[9px] border-[1.5px] border-ink bg-brand px-4 py-2 text-[13px] font-bold text-fg disabled:cursor-default disabled:opacity-50';
export const BTN2 = 'cursor-pointer rounded-[9px] border-[1.5px] border-border bg-panel px-4 py-2 text-[12.5px] font-semibold text-fgdim hover:border-ink hover:text-fg disabled:opacity-50';
export const BTN_SM = 'cursor-pointer rounded-[7px] border-[1.5px] border-ink bg-brand px-2.5 py-1 text-[11px] font-bold text-fg disabled:opacity-50';
export const BTN2_SM = 'cursor-pointer rounded-[7px] border-[1.5px] border-border bg-panel px-2.5 py-1 text-[11px] font-semibold text-fgdim hover:border-ink hover:text-fg disabled:opacity-50';
export const INPUT = 'w-full rounded-[8px] border-[1.5px] border-border bg-bg px-3 py-2 text-[12.5px] text-fg outline-none focus:border-ink';
export const CARD = 'rounded-[12px] border-[1.5px] border-ink bg-panel';
export const BODY = 'text-[12.5px] leading-relaxed text-fgdim';
export const OK = 'text-[12.5px] font-semibold text-[#2f7d4f]';

export const PILL = {
  ok: 'border-[#bfe3cf] bg-[#EAF6EF] text-[#2f7d4f]',
  done: 'border-[#bfe3cf] bg-[#EAF6EF] text-[#2f7d4f]',
  todo: 'border-[#e7d3a8] bg-[#FBF3E0] text-[#8a6d1f]',
  pending: 'border-[#e7d3a8] bg-[#FBF3E0] text-[#8a6d1f]',
  error: 'border-[#e2c4c0] bg-[#FBECEA] text-[#9c3b33]',
  failed: 'border-[#e2c4c0] bg-[#FBECEA] text-[#9c3b33]',
  blocked: 'border-hair bg-chip text-fgdim',
  skipped: 'border-hair bg-chip text-fgdim',
  timeout: 'border-hair bg-chip text-fgdim',
  running: 'border-[#bcd4ee] bg-[#EAF1FB] text-[#2C6BD6]',
  auto: 'border-[#bcd4ee] bg-[#EAF1FB] text-[#2C6BD6]',
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
    <div dir="auto" className="mt-3 rounded-[8px] border border-[#e2c4c0] bg-[#FBECEA] px-3 py-2 text-[11.5px] text-[#9c3b33]">
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
