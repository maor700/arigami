// What this machine is doing, for the human — the same snapshot sessions read
// through host_resources (server/lib/resources.ts), which until now had no
// view at all.
//
//   MachineMini   the rail strip: CPU · memory · swap · disk, coloured by pressure;
//                 click → Settings › Host › Machine resources
//   MachinePanel  that section: the verdict and why, what each SESSION costs
//                 (its agent, MCP servers, Chrome and every dev server it
//                 started, found by env marker), the heaviest processes, and
//                 the worktrees a delete refused to remove because they held
//                 unpushed work.
//
// Sizes come from the type scale (rem), so the UI-scale preference applies.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useStore } from '../lib/store.js';
import { Button, StatusDot } from './ui/index.js';

// Pressure is carried by a status dot / the bar fill only; numbers stay neutral text.
const tone = (pct) => (pct == null ? null : pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok');
const PRESSURE = { ok: 'ok', busy: 'warn', critical: 'err' };
const FILL = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err' };

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

function swapPct(snap) {
  const s = snap?.swap;
  return s && s.totalMb > 0 ? Math.round((s.usedMb / s.totalMb) * 100) : null;
}

/** One metric's value in the mini strip: label, percent; a dot appears only under pressure. */
function MiniStat({ label, pct, detail }) {
  const c = tone(pct);
  return (
    <span className="flex items-baseline gap-1" title={detail || undefined}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground tabular-nums">{pct == null ? '—' : `${Math.round(pct)}%`}</span>
      {c && c !== 'ok' && <StatusDot status={c} className="self-center" />}
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
      data-machine-mini
      className="flex min-h-9 w-full cursor-pointer items-center gap-2 border-t border-border px-[0.8125rem] py-2 text-start hover:bg-muted coarse:min-h-11"
    >
      <StatusDot status={PRESSURE[snap.pressure] || 'ok'} className="size-2" />
      <span className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden text-2xs">
        <MiniStat label={t('machine.cpu')} pct={snap.cpu?.pct} />
        <MiniStat
          label={t('machine.memory')}
          pct={snap.memory?.usedPct}
          detail={t('machine.memoryDetail', { avail: fmtMb(snap.memory?.availableMb), total: fmtMb(snap.memory?.totalMb) })}
        />
        {sp != null && sp > 0 && <MiniStat label={t('machine.swap')} pct={sp} detail={fmtMb(snap.swap.usedMb)} />}
        {snap.disk && (
          <MiniStat label={t('machine.disk')} pct={snap.disk.usedPct} detail={t('machine.diskFree', { free: fmtMb(snap.disk.freeMb) })} />
        )}
      </span>
    </button>
  );
}

function Stat({ label, value, sub, tone: c }) {
  return (
    <div className="min-w-[7rem] flex-1 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {c && c !== 'ok' && <StatusDot status={c} />}
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold text-foreground tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      {c && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${FILL[c]}`} style={{ width: `${parseFloat(String(value)) || 0}%` }} />
        </div>
      )}
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

  if (error && !snap) return <div className="text-sm text-destructive">{error}</div>;
  if (!snap) return <div className="text-xs text-muted-foreground">{t('machine.loading')}</div>;

  const sp = swapPct(snap);
  const load = snap.cpu?.load1 != null ? t('machine.load', { load: snap.cpu.load1.toFixed(2), cores: snap.cores }) : `${snap.cores} ${t('machine.cores')}`;
  const head = 'mb-1.5 text-xs font-medium text-muted-foreground';

  return (
    <div className="flex flex-col gap-5" data-machine-panel="">
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3.5 py-3">
        <StatusDot status={PRESSURE[snap.pressure] || 'ok'} className="mt-1.5 size-2" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t(`machine.pressure.${snap.pressure}`)}</div>
          <div className="text-xs text-muted-foreground" dir="ltr">
            {snap.why}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" dir="ltr">
        <Stat label={t('machine.cpu')} value={snap.cpu?.pct == null ? '—' : `${snap.cpu.pct}%`} sub={load} tone={tone(snap.cpu?.pct)} />
        <Stat
          label={t('machine.memory')}
          value={snap.memory?.usedPct == null ? '—' : `${snap.memory.usedPct}%`}
          sub={t('machine.memoryDetail', { avail: fmtMb(snap.memory?.availableMb), total: fmtMb(snap.memory?.totalMb) })}
          tone={tone(snap.memory?.usedPct)}
        />
        {snap.swap && snap.swap.totalMb > 0 && (
          <Stat label={t('machine.swap')} value={`${sp}%`} sub={`${fmtMb(snap.swap.usedMb)} / ${fmtMb(snap.swap.totalMb)}`} tone={tone(sp)} />
        )}
        {snap.disk && (
          <Stat
            label={t('machine.disk')}
            value={`${snap.disk.usedPct}%`}
            sub={t('machine.diskFree', { free: fmtMb(snap.disk.freeMb) })}
            tone={tone(snap.disk.usedPct)}
          />
        )}
      </div>

      <div>
        <div className={head}>{t('machine.bySession')}</div>
        {snap.sessions?.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
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
                  <tr key={r.session} className="border-t border-border">
                    <td className="max-w-0 truncate py-1.5">
                      <button
                        type="button"
                        onClick={() => openSession(r.session)}
                        className={gone ? 'cursor-default text-destructive' : 'cursor-pointer text-foreground hover:underline'}
                        title={gone ? t('machine.orphanHint') : r.session}
                      >
                        {gone ? t('machine.orphan', { id: r.session }) : title(r.session)}
                      </button>
                    </td>
                    <td className="py-1.5 text-end text-muted-foreground tabular-nums">{r.procs}</td>
                    <td className="py-1.5 text-end tabular-nums">{fmtMb(r.rssMb)}</td>
                    <td className="py-1.5 text-end text-muted-foreground tabular-nums">{Math.round(r.cpuPct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-muted-foreground">{t('machine.noSessionProcs')}</div>
        )}
      </div>

      <div>
        <div className={head}>{t('machine.topProcs')}</div>
        {/* table-fixed + explicit widths: under auto layout the two truncating
            columns (name, session) collapse to zero width. */}
        <table className="w-full table-fixed text-sm" dir="ltr">
          <colgroup>
            <col className="w-[4.5rem]" />
            <col className="w-[30%]" />
            <col />
            <col className="w-[5rem]" />
            <col className="w-[3.5rem]" />
          </colgroup>
          <tbody>
            {(snap.processes || []).map((p) => (
              <tr key={p.pid} className="border-t border-border">
                <td className="py-1 font-mono text-xs text-muted-foreground tabular-nums">{p.pid}</td>
                <td className="truncate py-1 font-mono text-xs" title={p.name}>{p.name}</td>
                <td className="truncate py-1 ps-2 text-muted-foreground">{p.session ? title(p.session) : ''}</td>
                <td className="py-1 text-end text-xs tabular-nums">{fmtMb(p.rssMb)}</td>
                <td className="py-1 text-end text-xs text-muted-foreground tabular-nums">{p.cpuPct == null ? '' : `${Math.round(p.cpuPct)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-1.5 flex items-center text-xs font-medium text-muted-foreground">
          <span className="flex-1">{t('machine.kept')}</span>
          <Button
            variant="outline"
            size="xs"
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
          >
            {sweeping ? t('machine.sweeping') : t('machine.sweep')}
          </Button>
        </div>
        {swept && (
          <div className="mb-1.5 text-sm text-muted-foreground">
            {t('machine.swept', { p: swept.processes, s: swept.scratch, c: swept.chrome, x: swept.transcripts, w: swept.worktrees ?? 0 })}
          </div>
        )}
        {kept?.length ? (
          <ul className="flex flex-col gap-1.5">
            {kept.map((k) => (
              <li key={k.dir} className="rounded-lg border border-border bg-card px-3 py-2">
                <div className="text-sm font-medium text-foreground">{k.title}</div>
                <div className="break-all font-mono text-xs text-muted-foreground" dir="ltr">
                  {k.dir}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground" dir="ltr">
                  <StatusDot status="warn" /> {k.reasons.join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-muted-foreground">{t('machine.noKept')}</div>
        )}
      </div>
    </div>
  );
}
