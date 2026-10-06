// What this machine is doing, for the human — the same snapshot sessions read
// through host_resources (server/lib/resources.ts), which until now had no
// view at all.
//
//   MachineMini   the rail strip: CPU · memory · swap, coloured by pressure;
//                 click → Settings › Host › Machine resources
//   MachinePanel  that section: the verdict and why, what each SESSION costs
//                 (its agent, MCP servers, Chrome and every dev server it
//                 started, found by env marker), the heaviest processes, and
//                 the worktrees a delete refused to remove because they held
//                 unpushed work.
//
// Sizes are rem so the UI-scale preference applies; colours are the rail's
// own status colours, which read on both themes.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useStore } from '../lib/store.js';

const GOOD = '#3C9A4E';
const WARN = '#CE8324';
const BAD = '#B23B30';
const tone = (pct) => (pct == null ? null : pct >= 90 ? BAD : pct >= 75 ? WARN : GOOD);
const PRESSURE = { ok: GOOD, busy: WARN, critical: BAD };

/** Poll the snapshot while the page is visible. */
function useResources(everyMs, top = 12) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let dead = false;
    let timer = null;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const r = await api.get(`/host/resources?top=${top}`);
          if (!dead) {
            setSnap(r);
            setError(null);
          }
        } catch (e) {
          if (!dead) setError(String(e.message || e));
        }
      }
      if (!dead) timer = setTimeout(tick, everyMs);
    };
    tick();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [everyMs, top]);
  return { snap, error };
}

const fmtMb = (mb) => (mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

function Bar({ label, pct, detail }) {
  const c = tone(pct);
  return (
    <div title={detail || undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[0.6875rem] md:text-[0.59375rem] tracking-[0.04em] text-fgdim uppercase">
          {label}
        </span>
        <span className="shrink-0 font-mono text-[0.6875rem] md:text-[0.59375rem] font-bold tabular-nums" style={{ color: c || undefined }}>
          {pct == null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="mt-[3px] h-1.5 overflow-hidden rounded-full bg-hair">
        {pct != null && (
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, pct)}%`, background: c }} />
        )}
      </div>
    </div>
  );
}

function swapPct(snap) {
  const s = snap?.swap;
  return s && s.totalMb > 0 ? Math.round((s.usedMb / s.totalMb) * 100) : null;
}

/** One metric's value in the mini strip: label, percent, coloured by pressure. */
function MiniStat({ label, pct, detail }) {
  return (
    <span className="flex items-baseline gap-1" title={detail || undefined}>
      <span className="text-fgdim">{label}</span>
      <span className="font-bold tabular-nums" style={{ color: tone(pct) || undefined }}>
        {pct == null ? '—' : `${Math.round(pct)}%`}
      </span>
    </span>
  );
}

// One row, not the full panel's stacked sliders — the rail has no room for
// three 2-line bars, especially on mobile where this sits above the usage
// strip and footer.
export function MachineMini() {
  const t = useT();
  const { snap } = useResources(15_000, 1);
  if (!snap) return null;
  const sp = swapPct(snap);
  return (
    <button
      type="button"
      onClick={() => {
        location.hash = '#/settings/host/resources';
      }}
      title={snap.why}
      className="flex w-full cursor-pointer items-center gap-2 border-t border-hair px-[0.8125rem] py-2 text-start hover:bg-chip/40"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRESSURE[snap.pressure] || GOOD }} />
      <span className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden font-mono text-[0.6875rem] md:text-[0.59375rem] tracking-[0.02em]">
        <MiniStat label={t('machine.cpu')} pct={snap.cpu?.pct} />
        <MiniStat
          label={t('machine.memory')}
          pct={snap.memory?.usedPct}
          detail={t('machine.memoryDetail', { avail: fmtMb(snap.memory?.availableMb), total: fmtMb(snap.memory?.totalMb) })}
        />
        {sp != null && sp > 0 && <MiniStat label={t('machine.swap')} pct={sp} detail={fmtMb(snap.swap.usedMb)} />}
      </span>
    </button>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div className="min-w-[7rem] flex-1 rounded-lg border border-hair px-3 py-2">
      <div className="font-mono text-[0.625rem] tracking-[0.06em] text-fgdim uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-[1rem] font-bold tabular-nums" style={{ color: color || undefined }}>
        {value}
      </div>
      {sub && <div className="font-mono text-[0.6875rem] text-fgdim">{sub}</div>}
    </div>
  );
}

export function MachinePanel() {
  const t = useT();
  const { sessions } = useStore();
  const { snap, error } = useResources(5_000, 15);
  const [kept, setKept] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [swept, setSwept] = useState(null);

  const loadKept = () => api.get('/host/kept-worktrees').then(setKept).catch(() => setKept([]));
  useEffect(() => {
    loadKept();
  }, []);

  const title = (id) => sessions.find((s) => s.id === id)?.title || id;
  const openSession = (id) => {
    if (sessions.some((s) => s.id === id)) location.hash = `#/session/${id}`;
  };

  if (error && !snap) return <div className="text-[0.78125rem] text-danger">{error}</div>;
  if (!snap) return <div className="font-mono text-[0.6875rem] text-fgdim">{t('machine.loading')}</div>;

  const sp = swapPct(snap);
  const load = snap.cpu?.load1 != null ? t('machine.load', { load: snap.cpu.load1.toFixed(2), cores: snap.cores }) : `${snap.cores} ${t('machine.cores')}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-lg border border-hair px-3 py-2.5">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PRESSURE[snap.pressure] || GOOD }} />
        <div className="min-w-0">
          <div className="text-[0.8125rem] font-bold text-fg">{t(`machine.pressure.${snap.pressure}`)}</div>
          <div className="text-[0.75rem] text-fgdim" dir="ltr">
            {snap.why}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" dir="ltr">
        <Stat label={t('machine.cpu')} value={snap.cpu?.pct == null ? '—' : `${snap.cpu.pct}%`} sub={load} color={tone(snap.cpu?.pct)} />
        <Stat
          label={t('machine.memory')}
          value={snap.memory?.usedPct == null ? '—' : `${snap.memory.usedPct}%`}
          sub={t('machine.memoryDetail', { avail: fmtMb(snap.memory?.availableMb), total: fmtMb(snap.memory?.totalMb) })}
          color={tone(snap.memory?.usedPct)}
        />
        {snap.swap && snap.swap.totalMb > 0 && (
          <Stat label={t('machine.swap')} value={`${sp}%`} sub={`${fmtMb(snap.swap.usedMb)} / ${fmtMb(snap.swap.totalMb)}`} color={tone(sp)} />
        )}
        {snap.disk && (
          <Stat
            label={t('machine.disk')}
            value={`${snap.disk.usedPct}%`}
            sub={t('machine.diskFree', { free: fmtMb(snap.disk.freeMb) })}
            color={tone(snap.disk.usedPct)}
          />
        )}
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[0.625rem] tracking-[0.06em] text-fgdim uppercase">{t('machine.bySession')}</div>
        {snap.sessions?.length ? (
          <table className="w-full text-[0.75rem]">
            <thead>
              <tr className="text-start font-mono text-[0.625rem] text-fgdim uppercase">
                <th className="py-1 text-start font-normal">{t('machine.session')}</th>
                <th className="py-1 text-end font-normal">{t('machine.procs')}</th>
                <th className="py-1 text-end font-normal">{t('machine.memory')}</th>
                <th className="py-1 text-end font-normal">{t('machine.cpu')}</th>
              </tr>
            </thead>
            <tbody>
              {snap.sessions.map((r) => {
                const gone = !sessions.some((s) => s.id === r.session);
                return (
                  <tr key={r.session} className="border-t border-hair">
                    <td className="max-w-0 truncate py-1.5">
                      <button
                        type="button"
                        onClick={() => openSession(r.session)}
                        className={gone ? 'cursor-default text-danger' : 'cursor-pointer text-fg hover:underline'}
                        title={gone ? t('machine.orphanHint') : r.session}
                      >
                        {gone ? t('machine.orphan', { id: r.session }) : title(r.session)}
                      </button>
                    </td>
                    <td className="py-1.5 text-end font-mono tabular-nums text-fgdim">{r.procs}</td>
                    <td className="py-1.5 text-end font-mono tabular-nums">{fmtMb(r.rssMb)}</td>
                    <td className="py-1.5 text-end font-mono tabular-nums text-fgdim">{Math.round(r.cpuPct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-[0.75rem] text-fgdim">{t('machine.noSessionProcs')}</div>
        )}
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[0.625rem] tracking-[0.06em] text-fgdim uppercase">{t('machine.topProcs')}</div>
        {/* table-fixed + explicit widths: under auto layout the two truncating
            columns (name, session) collapse to zero width. */}
        <table className="w-full table-fixed text-[0.75rem]" dir="ltr">
          <colgroup>
            <col className="w-[4.5rem]" />
            <col className="w-[30%]" />
            <col />
            <col className="w-[5rem]" />
            <col className="w-[3.5rem]" />
          </colgroup>
          <tbody>
            {(snap.processes || []).map((p) => (
              <tr key={p.pid} className="border-t border-hair">
                <td className="py-1 font-mono text-fgdim tabular-nums">{p.pid}</td>
                <td className="truncate py-1 font-mono" title={p.name}>{p.name}</td>
                <td className="truncate py-1 ps-2 text-fgdim">{p.session ? title(p.session) : ''}</td>
                <td className="py-1 text-end font-mono tabular-nums">{fmtMb(p.rssMb)}</td>
                <td className="py-1 text-end font-mono tabular-nums text-fgdim">{p.cpuPct == null ? '' : `${Math.round(p.cpuPct)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-1.5 flex items-center font-mono text-[0.625rem] tracking-[0.06em] text-fgdim uppercase">
          <span className="flex-1">{t('machine.kept')}</span>
          <button
            type="button"
            disabled={sweeping}
            onClick={async () => {
              setSweeping(true);
              try {
                setSwept(await api.post('/host/sweep'));
                loadKept();
              } finally {
                setSweeping(false);
              }
            }}
            className="cursor-pointer normal-case tracking-normal hover:text-fg disabled:opacity-50"
          >
            {sweeping ? t('machine.sweeping') : t('machine.sweep')}
          </button>
        </div>
        {swept && (
          <div className="mb-1.5 text-[0.75rem] text-fgdim">
            {t('machine.swept', { p: swept.processes, s: swept.scratch, c: swept.chrome, x: swept.transcripts, w: swept.worktrees ?? 0 })}
          </div>
        )}
        {kept?.length ? (
          <ul className="flex flex-col gap-1.5">
            {kept.map((k) => (
              <li key={k.dir} className="rounded-lg border border-hair px-3 py-2">
                <div className="text-[0.75rem] font-bold text-fg">{k.title}</div>
                <div className="break-all font-mono text-[0.6875rem] text-fgdim" dir="ltr">
                  {k.dir}
                </div>
                <div className="mt-0.5 text-[0.6875rem]" style={{ color: WARN }} dir="ltr">
                  {k.reasons.join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[0.75rem] text-fgdim">{t('machine.noKept')}</div>
        )}
      </div>
    </div>
  );
}
