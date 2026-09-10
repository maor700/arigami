// A3 — Settings › Host › Budgets ("תקציבים"): one row per agent (avatar/name × model × daily
// token cap × used today). Caps are edited inline → PATCH /__api/agents/:slug
// {budget:{tokensPerDay}}; the "used" column is GET /__api/agents/budgets
// (today's 'turn' lines of the agent's activity ledger, host-local day).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useStore } from '../../lib/store.js';
import { useT } from '../../lib/i18n.js';
import { toast, toastError } from '../../lib/toast.js';
import { Section, BTN_SM, INPUT } from './shared.jsx';
import { AgentAvatar } from '../AgentCard.jsx';

export const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return String(v);
};
export const fmtUsd = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(Number(n) >= 1 ? 2 : 3)}` : '$0');

export function BudgetRow({ row, onSaved }) {
  const t = useT();
  const [cap, setCap] = useState(row.cap ? String(row.cap) : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCap(row.cap ? String(row.cap) : ''); }, [row.cap]);
  const dirty = (Number(cap) || 0) !== (row.cap || 0);
  const pct = row.cap ? Math.min(100, Math.round((row.usedTokens / row.cap) * 100)) : null;
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/agents/${row.slug}`, { budget: Number(cap) > 0 ? { tokensPerDay: Number(cap) } : null });
      toast(t('host.budgets.saved', { name: row.name }));
      onSaved?.();
    } catch (e) {
      toastError(e?.body?.error || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-budget-row={row.slug} className="border-b border-hair last:border-b-0">
      <td className="py-1.5 pe-2">
        <span className="flex items-center gap-1.5">
          <AgentAvatar agent={row} size={18} />
          <span dir="auto" className="font-bold text-fg">{row.name}</span>
        </span>
      </td>
      <td className="py-1.5 pe-2 font-mono text-[11.5px] md:text-[10.5px] text-fgdim" dir="ltr">{row.model || t('host.budgets.modelDefault')}</td>
      <td className="py-1.5 pe-2">
        <span className="flex items-center gap-1.5">
          <input type="number" min="0" step="1000" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={t('host.budgets.noCap')} className={`${INPUT} w-[110px]`} dir="ltr" />
          {dirty && <button type="button" disabled={busy} onClick={save} className={BTN_SM}>{t('host.budgets.save')}</button>}
        </span>
      </td>
      <td className="py-1.5 font-mono text-[11.5px] md:text-[10.5px]" dir="ltr">
        <span className={row.exceeded ? 'font-bold text-danger' : 'text-fg'}>{fmtTokens(row.usedTokens)}</span>
        {row.cap ? <span className="text-fgdim"> / {fmtTokens(row.cap)} · {pct}%</span> : null}
        <span className="text-fgdim"> · {fmtUsd(row.usedCostUsd)}</span>
        {row.exceeded && <span className="ms-1 rounded-full bg-danger/15 px-1.5 text-[11px] md:text-[9.5px] text-danger">{t('host.budgets.exceeded')}</span>}
      </td>
    </tr>
  );
}

export function BudgetsTable({ rows, day, onSaved }) {
  const t = useT();
  if (!rows) return <div className="text-[11px] text-fgdim">…</div>;
  if (rows.length === 0) return <div className="text-[11px] text-fgdim">{t('host.budgets.empty')}</div>;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-hair px-3 py-1">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="border-b border-hair font-mono text-[11px] md:text-[9.5px] tracking-[0.08em] text-fgdim uppercase">
            <th className="py-1 pe-2 text-start font-normal">{t('host.budgets.agent')}</th>
            <th className="py-1 pe-2 text-start font-normal">{t('host.budgets.model')}</th>
            <th className="py-1 pe-2 text-start font-normal">{t('host.budgets.cap')}</th>
            <th className="py-1 text-start font-normal">{t('host.budgets.used')}</th>
          </tr>
        </thead>
        <tbody>{rows.map((r) => <BudgetRow key={r.slug} row={r} onSaved={onSaved} />)}</tbody>
      </table>
      {day && <div className="py-1 font-mono text-[11px] md:text-[9.5px] text-fgdim">{t('host.budgets.day', { day })}</div>}
    </div>
  );
}

export default function Budgets() {
  const t = useT();
  const { agents } = useStore();
  const [data, setData] = useState(null);
  const load = () => api.get('/agents/budgets').then(setData).catch(() => setData({ budgets: [], day: '' }));
  useEffect(() => { load(); }, [agents?.length]);
  return (
    <Section id="budgets" title={t('host.budgets')} onRefresh={load}>
      <div className="text-[11px] text-fgdim">{t('host.budgets.hint')}</div>
      <BudgetsTable rows={data?.budgets || null} day={data?.day} onSaved={load} />
    </Section>
  );
}
