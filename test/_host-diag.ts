// What a spawned test host looks like at the moment a readiness wait gives up:
// did it exit (code/signal), is it still running (/proc state), and what is it
// blocked on (its children — a `gh`, `git` or `claude` stub it is waiting for).
// Appended to the 'host did not come up' error so a flaky boot leaves evidence
// instead of an empty log. Linux-only details are best-effort; never throws.
import fs from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';

export function hostDiag(host: ChildProcess | null | undefined): string {
  if (!host) return '\n[diag] no child process';
  const pid = host.pid;
  let out = `\n[diag] pid=${pid ?? '?'} exitCode=${host.exitCode} signal=${host.signalCode} killed=${host.killed}`;
  if (!pid || host.exitCode !== null || host.signalCode !== null) return out;
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const pick = (k: string) => (st.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim();
    out += ` state=${pick('State')} rss=${pick('VmRSS')} threads=${pick('Threads')}`;
    out += ` wchan=${fs.readFileSync(`/proc/${pid}/wchan`, 'utf8').trim()}`;
    // CPU actually burned (clock ticks, usually 100/s) — distinguishes a spin from a stall.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    out += ` utime=${f[11]} stime=${f[12]} (ticks)`;
    // Per thread: name, state, ticks — Bun names its threads, so a hot one says where.
    const rows: string[] = [];
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      try {
        const ts = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        const name = ts.slice(ts.indexOf('(') + 1, ts.lastIndexOf(')'));
        const tf = ts.slice(ts.lastIndexOf(')') + 2).split(' ');
        rows.push(`${tid} ${name} ${tf[0]} u=${tf[11]} s=${tf[12]} wchan=${fs.readFileSync(`/proc/${pid}/task/${tid}/wchan`, 'utf8').trim()}`);
      } catch {}
    }
    out += `\n[diag] threads:\n${rows.join('\n')}`;
    const fds = fs.readdirSync(`/proc/${pid}/fd`).map((d) => { try { return `${d}→${fs.readlinkSync(`/proc/${pid}/fd/${d}`)}`; } catch { return d; } });
    out += `\n[diag] fds(${fds.length}): ${fds.slice(0, 24).join(' ')}`;
  } catch {}
  try {
    const ps = spawnSync('ps', ['-o', 'pid=,stat=,etimes=,args=', '--ppid', String(pid)], { encoding: 'utf8', timeout: 3000 });
    const kids = (ps.stdout || '').trim();
    out += kids ? `\n[diag] children:\n${kids.slice(0, 800)}` : ' children=none';
  } catch {}
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const avail = (m.match(/^MemAvailable:\s*(\d+)/m) || [])[1];
    const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
    out += `\n[diag] MemAvailable=${avail ? Math.round(Number(avail) / 1024) + 'MB' : '?'} load=${load}`;
  } catch {}
  return out;
}
