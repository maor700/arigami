// Pure schedule math for server/triggers.ts's `type:'cron'` trigger — no I/O,
// no state, so it's fully unit-testable in isolation (see test/cron-schedule.test.js).
//
// Three schedule kinds:
//   'cron'     — standard 5-field cron expression (minute hour dom month dow),
//                minute resolution, evaluated in server-local time.
//   'interval' — a duration ("30s"|"5m"|"2h"|"1d", or a plain millisecond
//                count) that repeats from the last run (or creation time).
//   'at'       — a one-shot ISO timestamp; fires once, never again.

export type ScheduleKind = 'cron' | 'interval' | 'at';

export interface Schedule {
  kind: ScheduleKind;
  value: string;
}

// ---- interval ---------------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseIntervalMs(raw: string | number): number {
  if (typeof raw === 'number') {
    if (!(raw > 0)) throw new Error(`interval must be > 0: ${raw}`);
    return raw;
  }
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) {
    const ms = Number(s);
    if (!(ms > 0)) throw new Error(`interval must be > 0: "${raw}"`);
    return ms;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s);
  if (!m) throw new Error(`invalid interval "${raw}" — expected e.g. "30s"/"5m"/"2h"/"1d" or a millisecond count`);
  const ms = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  if (!(ms > 0)) throw new Error(`interval must be > 0: "${raw}"`);
  return ms;
}

// ---- cron ---------------------------------------------------------------

interface FieldSpec {
  values: Set<number>;
  wildcard: boolean; // '*' — unrestricted (matters for the dom/dow OR rule)
}

function parseField(raw: string, min: number, max: number, wrap?: (n: number) => number): FieldSpec {
  const wildcard = raw === '*';
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`invalid cron field "${raw}" (bad token "${part}")`);
    const start = m[1] === '*' ? min : Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : m[1] === '*' ? max : start;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (step <= 0) throw new Error(`invalid step in cron field "${raw}"`);
    if (start < min || end > max || start > end) throw new Error(`out-of-range cron field "${raw}" (expected ${min}-${max})`);
    for (let v = start; v <= end; v += step) values.add(wrap ? wrap(v) : v);
  }
  if (!values.size) throw new Error(`empty cron field "${raw}"`);
  return { values, wildcard };
}

const dowWrap = (v: number): number => (v === 7 ? 0 : v); // accept 7 as Sunday alias

// Bounded forward search — each step jumps to the next candidate field
// boundary (month/day/hour/minute) instead of crawling minute-by-minute, so
// even a once-a-year expression resolves in a handful of iterations.
const SEARCH_STEPS = 130_000; // generous ceiling — real schedules resolve in <10

export function nextCronRun(expr: string, after: Date): Date {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`cron expression must have 5 fields (minute hour dom month dow): "${expr}"`);
  const [minF, hourF, domF, monF, dowF] = parts;
  const minute = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const month = parseField(monF, 1, 12);
  const dow = parseField(dowF, 0, 7, dowWrap); // 7 accepted as a Sunday alias
  const domRestricted = !dom.wildcard;
  const dowRestricted = !dow.wildcard;

  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `after`

  for (let i = 0; i < SEARCH_STEPS; i++) {
    if (!month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = dom.values.has(d.getDate());
    const dowOk = dow.values.has(d.getDay());
    // Standard cron rule: when BOTH dom and dow are restricted, a day matches
    // if EITHER matches; if only one is restricted, only that one applies.
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domRestricted ? domOk : dowRestricted ? dowOk : true;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d;
  }
  throw new Error(`no matching run found within the search window for cron "${expr}"`);
}

// ---- unified schedule → next run --------------------------------------------

export function computeNextRun(
  schedule: Schedule,
  opts: { createdAt: number; lastRun?: number | null }
): number | null {
  const { createdAt, lastRun } = opts;
  if (schedule.kind === 'at') {
    if (lastRun) return null; // one-shot — already fired
    const t = Date.parse(schedule.value);
    if (!Number.isFinite(t)) throw new Error(`invalid "at" timestamp: "${schedule.value}"`);
    return t;
  }
  if (schedule.kind === 'interval') {
    const ms = parseIntervalMs(schedule.value);
    return (lastRun ?? createdAt) + ms;
  }
  if (schedule.kind === 'cron') {
    const base = new Date(lastRun ?? createdAt);
    return nextCronRun(schedule.value, base).getTime();
  }
  throw new Error(`unknown schedule kind: "${(schedule as Schedule).kind}"`);
}

// Validates a schedule (throws with a descriptive message on bad input) and
// returns the first run time — used at create/patch time so a typo'd cron
// expression fails loudly instead of silently never firing.
export function validateSchedule(schedule: Schedule, createdAt: number = Date.now()): number {
  const next = computeNextRun(schedule, { createdAt, lastRun: null });
  if (next == null) throw new Error('schedule never fires');
  return next;
}
