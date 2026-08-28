// Pure schedule math for the M2 cron trigger — see server/cron-schedule.ts.
import { test, expect, describe } from 'bun:test';
import {
  parseIntervalMs,
  nextCronRun,
  computeNextRun,
  validateSchedule,
} from '../server/cron-schedule.ts';

describe('parseIntervalMs', () => {
  test('parses unit suffixes', () => {
    expect(parseIntervalMs('30s')).toBe(30_000);
    expect(parseIntervalMs('5m')).toBe(5 * 60_000);
    expect(parseIntervalMs('2h')).toBe(2 * 3_600_000);
    expect(parseIntervalMs('1d')).toBe(86_400_000);
  });
  test('parses a plain millisecond count (string or number)', () => {
    expect(parseIntervalMs('1500')).toBe(1500);
    expect(parseIntervalMs(1500)).toBe(1500);
  });
  test('rejects zero/negative/garbage', () => {
    expect(() => parseIntervalMs('0s')).toThrow();
    expect(() => parseIntervalMs('-5m')).toThrow();
    expect(() => parseIntervalMs('soon')).toThrow();
    expect(() => parseIntervalMs(0)).toThrow();
  });
});

describe('nextCronRun', () => {
  test('every minute fires the minute right after `after`', () => {
    const after = new Date('2026-08-28T10:00:30Z');
    const next = nextCronRun('* * * * *', after);
    expect(next.toISOString()).toBe('2026-08-28T10:01:00.000Z');
  });
  test('specific minute/hour — next Monday 09:00', () => {
    // 2026-08-28 is a Friday.
    const after = new Date('2026-08-28T10:00:00Z');
    const next = nextCronRun('0 9 * * 1', after);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });
  test('step + range: */15 minutes', () => {
    const after = new Date('2026-08-28T10:02:00Z');
    const next = nextCronRun('*/15 * * * *', after);
    expect(next.getMinutes()).toBe(15);
  });
  test('dom/dow OR rule: both restricted matches either', () => {
    // 1st of the month OR a Monday — 2026-08-28 is a Friday, next Monday is
    // 2026-08-31, but the 1st of September (Tue) comes first.
    const after = new Date('2026-08-28T00:00:00Z');
    const next = nextCronRun('0 0 1 * 1', after);
    // Sept 1 2026 is a Tuesday — comes before Aug 31 (Monday)? Aug 31 < Sep 1.
    expect(next.getTime()).toBeLessThan(new Date('2026-09-02T00:00:00Z').getTime());
  });
  test('dow alias 7 == Sunday', () => {
    const after = new Date('2026-08-28T00:00:00Z'); // Friday
    const a = nextCronRun('0 0 * * 0', after);
    const b = nextCronRun('0 0 * * 7', after);
    expect(a.getTime()).toBe(b.getTime());
  });
  test('rejects malformed expressions', () => {
    expect(() => nextCronRun('* * * *', new Date())).toThrow();
    expect(() => nextCronRun('60 * * * *', new Date())).toThrow(); // minute out of range
    expect(() => nextCronRun('x * * * *', new Date())).toThrow();
  });
});

describe('computeNextRun', () => {
  const createdAt = Date.parse('2026-08-28T00:00:00Z');

  test('interval: first run is createdAt + interval when never run', () => {
    const next = computeNextRun({ kind: 'interval', value: '10m' }, { createdAt, lastRun: null });
    expect(next).toBe(createdAt + 10 * 60_000);
  });
  test('interval: subsequent runs are lastRun + interval', () => {
    const lastRun = createdAt + 3600_000;
    const next = computeNextRun({ kind: 'interval', value: '10m' }, { createdAt, lastRun });
    expect(next).toBe(lastRun + 10 * 60_000);
  });
  test('at: fires once at the given timestamp, never again after lastRun is set', () => {
    const at = '2026-09-01T12:00:00Z';
    const first = computeNextRun({ kind: 'at', value: at }, { createdAt, lastRun: null });
    expect(first).toBe(Date.parse(at));
    const again = computeNextRun({ kind: 'at', value: at }, { createdAt, lastRun: Date.parse(at) });
    expect(again).toBeNull();
  });
  test('at: invalid timestamp throws', () => {
    expect(() => computeNextRun({ kind: 'at', value: 'not-a-date' }, { createdAt, lastRun: null })).toThrow();
  });
  test('cron: delegates to nextCronRun using lastRun (or createdAt) as the base', () => {
    const next = computeNextRun({ kind: 'cron', value: '0 * * * *' }, { createdAt, lastRun: null });
    expect(new Date(next).getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(createdAt);
  });
  test('unknown kind throws', () => {
    expect(() => computeNextRun({ kind: 'bogus', value: '' }, { createdAt, lastRun: null })).toThrow();
  });
});

describe('validateSchedule', () => {
  test('returns the first run time for a valid schedule', () => {
    const next = validateSchedule({ kind: 'interval', value: '1h' }, createdAtFixture());
    expect(next).toBeGreaterThan(createdAtFixture());
  });
  test('throws on an invalid cron expression instead of silently never firing', () => {
    expect(() => validateSchedule({ kind: 'cron', value: '99 * * * *' })).toThrow();
  });
});

function createdAtFixture() {
  return Date.parse('2026-08-28T00:00:00Z');
}
