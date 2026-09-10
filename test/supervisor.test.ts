// RES1 §5 — unit tests for the pure state machine and the recovery ladder.
// Table-driven: one case per row of the ladder table in docs/RESILIENCE.md §2,
// plus the health model of §1 and the model-ladder helpers.
import { test, expect, describe } from 'bun:test';
import {
  classify,
  decide,
  effectiveChain,
  floorActivity,
  freshWatermark,
  nextRung,
  resetOnProgress,
  rungOf,
  rungsLeft,
  shouldRestoreModel,
  waitingRow,
  DEFAULT_MODEL_CHAIN,
  HEALTH_DOT,
  type Health,
  type SessionView,
  type Thresholds,
  type Watermark,
} from '../server/supervisor.ts';

const NOW = 1_700_000_000_000;
const th: Thresholds = {
  now: NOW,
  stallMs: 10 * 60_000,
  reportGraceMs: 2 * 60_000,
  notifyEveryMs: 60 * 60_000,
  maxRespawns: 2,
  maxAuthRetries: 2,
  maxNudges: 1,
};
const ago = (ms: number) => NOW - ms;
const view = (p: Partial<SessionView> = {}): SessionView => ({
  id: 's1',
  title: 'session',
  claudeState: 'idle',
  procAlive: true,
  lastActivityAt: ago(1000),
  ...p,
});
const wm = (p: Partial<Watermark> = {}): Watermark => ({ ...freshWatermark(), ...p });

// ---------------------------------------------------------------- §1 health

describe('classify — the five health states', () => {
  const cases: [string, Partial<SessionView>, Health, string?][] = [
    ['a turn in flight', { claudeState: 'working' }, 'RUNNING'],
    ['a respawn in flight', { claudeState: 'restarting' }, 'RUNNING'],
    ['a non-empty queue', { queued: 2, autoPlay: true }, 'RUNNING', 'queued'],
    ['finished and reported', { master: 'm', reported: true }, 'IDLE_OK', 'reported'],
    ['a plain idle chat', {}, 'IDLE_OK', 'idle'],
    ['an archived session', { archived: true, claudeState: 'dead' }, 'IDLE_OK', 'archived'],
    ['an open action card', { action: true }, 'WAITING_HUMAN', 'action-card'],
    ['an open request_screen', { screenRequest: true }, 'WAITING_HUMAN', 'screen-request'],
    ['an open setup card', { setupRequest: true }, 'WAITING_HUMAN', 'setup-request'],
    ['a review that was requested', { reviewRequested: true }, 'WAITING_HUMAN', 'review-requested'],
    ['an approved branch nobody merged', { mergePending: true }, 'WAITING_HUMAN', 'merge-pending'],
    ['an agent over its daily budget', { budgetExceeded: true }, 'WAITING_HUMAN', 'over-budget'],
    ['a blocking AskUserQuestion', { claudeState: 'awaiting-input' }, 'WAITING_HUMAN', 'awaiting-input'],
    ['a dead proc', { claudeState: 'dead' }, 'BLOCKED_SYSTEM', 'proc-dead'],
    ['"working" with no live proc', { claudeState: 'working', procAlive: false }, 'BLOCKED_SYSTEM', 'proc-dead'],
    ['a revoked token', { lastErrorClass: 'auth' }, 'BLOCKED_SYSTEM', 'auth'],
    ['a dry account pool', { lastErrorClass: 'limit', accountsExhausted: true }, 'BLOCKED_SYSTEM', 'accounts-exhausted'],
    ['a down MCP server', { mcpDown: ['playwright'] }, 'BLOCKED_SYSTEM', 'mcp-down'],
    [
      'a worker with nothing owed to a human, quiet too long',
      { master: 'm', reported: false, lastActivityAt: ago(20 * 60_000) },
      'STALLED',
    ],
  ];
  for (const [name, patch, want, reason] of cases) {
    test(name, () => {
      const cl = classify(view(patch), th);
      expect(cl.state).toBe(want);
      if (reason) expect(cl.reason).toBe(reason);
    });
  }

  test('WAITING_HUMAN beats every system signal', () => {
    // A session can be BOTH blocked on a person and broken. The person wins, so
    // nothing below can auto-recover it out from under them.
    const v = view({ action: true, claudeState: 'dead', lastErrorClass: 'auth', accountsExhausted: true, mcpDown: ['x'] });
    expect(classify(v, th).state).toBe('WAITING_HUMAN');
  });

  test('an idle HUMAN chat is never STALLED, however long it sits', () => {
    expect(classify(view({ lastActivityAt: ago(30 * 24 * 3600_000) }), th).state).toBe('IDLE_OK');
  });

  test('a queue parked with auto-play OFF is the human\'s, not a stall', () => {
    const v = view({ queued: 3, autoPlay: false, lastActivityAt: ago(60 * 60_000) });
    expect(classify(v, th).state).toBe('IDLE_OK');
  });

  test('a queue with auto-play ON that never played IS a stall', () => {
    const v = view({ queued: 3, autoPlay: true, lastActivityAt: ago(60 * 60_000) });
    expect(classify(v, th).state).toBe('STALLED');
  });

  test('every health state has a rail dot', () => {
    for (const s of ['RUNNING', 'IDLE_OK', 'WAITING_HUMAN', 'BLOCKED_SYSTEM', 'STALLED'] as Health[])
      expect(HEALTH_DOT[s]).toBeTruthy();
  });
});

// SUP1: a controller/PM that is idle only because its children are still
// working was misclassified STALLED and nudged — waiting on children IS the
// controller's correct resting state. `owedButBusy` reproduces the shape that
// actually mis-fired live: a session that is ALSO a worker of some higher
// master (has not reported up yet) but is correctly quiet because the work it
// owns right now belongs to its own children.
describe('SUP1 — a controller waiting on its own children is IDLE_OK, not STALLED', () => {
  const owedButBusy: Partial<SessionView> = { master: 'grandparent', reported: false, lastActivityAt: ago(20 * 60_000) };

  test('a live (non-archived, non-terminal) child → IDLE_OK', () => {
    const cl = classify(view({ ...owedButBusy, hasLiveChildren: true }), th);
    expect(cl.state).toBe('IDLE_OK');
    expect(cl.reason).toBe('waiting-on-children');
  });

  test('…and decide() never nudges, respawns or escalates it', () => {
    const d = decide({ view: view({ ...owedButBusy, hasLiveChildren: true }), thresholds: th });
    expect(d.action).toBe('none');
  });

  test('a waitingOn record the child has not answered yet → IDLE_OK', () => {
    const waitingOn = { sessionId: 'c1', since: new Date(ago(60_000)).toISOString(), what: 'merge the branch' };
    const cl = classify(view({ ...owedButBusy, waitingOn, waitingOnChildGone: false }), th);
    expect(cl.state).toBe('IDLE_OK');
    expect(cl.reason).toBe('waiting-on-child');
  });

  test('a waitingOn record whose child is gone does NOT shield it — still STALLED', () => {
    const waitingOn = { sessionId: 'c1', since: new Date(ago(60_000)).toISOString(), what: 'merge the branch' };
    const cl = classify(view({ ...owedButBusy, waitingOn, waitingOnChildGone: true }), th);
    expect(cl.state).toBe('STALLED');
  });

  test('no live children and no waitingOn, quiet past the threshold → still a genuine STALLED', () => {
    const cl = classify(view({ ...owedButBusy, hasLiveChildren: false }), th);
    expect(cl.state).toBe('STALLED');
    // reportSynthesized: true isolates the STALLED ladder step from the
    // separate (and already-tested) synthesize-report rung ahead of it.
    const d = decide({
      view: view({ ...owedButBusy, hasLiveChildren: false }),
      watermark: wm({ reportSynthesized: true }),
      thresholds: th,
    });
    expect(d.action).toBe('nudge');
  });

  test('WAITING_HUMAN still wins over a live child', () => {
    const cl = classify(view({ ...owedButBusy, hasLiveChildren: true, action: true }), th);
    expect(cl.state).toBe('WAITING_HUMAN');
  });
});

describe('floorActivity — a fresh stall window once owned work clears (SUP1 §3)', () => {
  test('no owned-work floor recorded yet → activity passes through unchanged', () => {
    expect(floorActivity(ago(999_000), 0)).toBe(ago(999_000));
  });

  test('real activity already newer than the floor → passes through unchanged', () => {
    expect(floorActivity(ago(10_000), ago(60_000))).toBe(ago(10_000));
  });

  test('stale activity gets floored at the moment owned work was last observed', () => {
    // A controller whose last child JUST finished must not be judged against
    // hours-old transcript activity — it gets a fresh stall window from now.
    expect(floorActivity(ago(60 * 60_000), ago(5_000))).toBe(ago(5_000));
  });
});

// ------------------------------------------------------- §2 recovery ladder

describe('decide — one case per row of the ladder', () => {
  const run = (patch: Partial<SessionView>, w: Partial<Watermark> = {}, t: Partial<Thresholds> = {}) =>
    decide({ view: view(patch), watermark: wm(w), thresholds: { ...th, ...t } });

  test('proc dead → respawn', () => {
    const d = run({ claudeState: 'dead' });
    expect(d.action).toBe('respawn');
    expect(d.next.respawns).toBe(1);
  });

  test('proc dead twice more → escalate to a human', () => {
    const d = run({ claudeState: 'dead' }, { respawns: 2 });
    expect(d.action).toBe('escalate');
    expect(d.escalated).toBe(true);
    expect(d.detail?.after).toBe('respawn');
  });

  test('auth revoked → refresh the token', () => {
    const d = run({ lastErrorClass: 'auth' });
    expect(d.action).toBe('refresh-auth');
    expect(d.next.authRetries).toBe(1);
  });

  test('auth refresh keeps failing → escalate', () => {
    expect(run({ lastErrorClass: 'auth' }, { authRetries: 2 }).action).toBe('escalate');
  });

  test('accounts exhausted with rungs left → drop a model rung', () => {
    const d = run({ lastErrorClass: 'limit', accountsExhausted: true, modelRungsLeft: 2 });
    expect(d.action).toBe('model-down');
    expect(d.detail?.rungsLeft).toBe(2);
  });

  test('accounts exhausted at the bottom rung → escalate', () => {
    const d = run({ lastErrorClass: 'limit', accountsExhausted: true, modelRungsLeft: 0 });
    expect(d.action).toBe('escalate');
    expect(d.detail?.after).toBe('model-ladder');
  });

  test('the top rung reset → climb back', () => {
    const d = run({ modelRung: 2, modelRestoreAt: new Date(ago(1000)).toISOString() });
    expect(d.action).toBe('model-restore');
  });

  test('a reset still in the future does NOT climb back', () => {
    const d = run({ modelRung: 2, modelRestoreAt: new Date(NOW + 60_000).toISOString() });
    expect(d.action).toBe('none');
  });

  // RES1 fix: a model-restore used to fire the instant the quota reset, even
  // mid-turn — killing whatever was in flight with no replay. The ladder must
  // never switch models under a session that is actively RUNNING; it waits.
  test('the quota reset while a turn is in flight → do NOT climb back yet', () => {
    for (const claudeState of ['working', 'restarting']) {
      const d = run({ modelRung: 2, modelRestoreAt: new Date(ago(1000)).toISOString(), claudeState });
      expect(d.action).not.toBe('model-restore');
    }
    // A queued-but-not-yet-started turn counts as RUNNING too (queued+autoPlay).
    const q = run({ modelRung: 2, modelRestoreAt: new Date(ago(1000)).toISOString(), queued: 1, autoPlay: true });
    expect(q.action).not.toBe('model-restore');
  });

  test('…and climbs back the moment it goes idle', () => {
    const d = run({ modelRung: 2, modelRestoreAt: new Date(ago(1000)).toISOString(), claudeState: 'idle' });
    expect(d.action).toBe('model-restore');
  });

  test('an optional MCP server down → disable it and keep going', () => {
    const d = run({ mcpDown: ['playwright'] });
    expect(d.action).toBe('disable-mcp');
    expect(d.detail?.servers).toEqual(['playwright']);
  });

  test('a REQUIRED MCP server down → escalate', () => {
    const d = run({ mcpDown: ['arigami'], mcpRequired: true });
    expect(d.action).toBe('escalate');
    expect(d.detail?.after).toBe('mcp');
  });

  test('STALLED with nothing owed to a human → nudge, then respawn, then escalate', () => {
    const v = { master: 'm', reported: false, lastActivityAt: ago(20 * 60_000) };
    const first = run(v, { reportSynthesized: true });
    expect(first.action).toBe('nudge');
    // The de-dupe watermark advanced, so the SAME quiet period never fires twice.
    expect(decide({ view: view(v), watermark: first.next, thresholds: th }).action).toBe('none');
    const second = run(v, { reportSynthesized: true, nudges: 1 });
    expect(second.action).toBe('respawn');
    const third = run(v, { reportSynthesized: true, nudges: 1, respawns: 2 });
    expect(third.action).toBe('escalate');
  });

  test('a child terminal without report_to_master → synthesize it, once', () => {
    const v = { master: 'm', reported: false, lastActivityAt: ago(5 * 60_000) };
    const d = run(v);
    expect(d.action).toBe('synthesize-report');
    expect(d.detail?.master).toBe('m');
    expect(decide({ view: view(v), watermark: d.next, thresholds: th }).action).not.toBe('synthesize-report');
  });

  // RES1 fix: idle-with-nothing-pending is the NORMAL gap between a working
  // session's turns, not evidence it is done. Quiet past the grace window is
  // only real evidence when WE did not just respawn it — a respawn's own
  // capture+replay explains a short quiet gap on its own; synthesizing on top
  // of it is exactly how the master got told "done" while a respawn was still
  // replaying the interrupted turn.
  test('quiet past the grace window right after WE respawned it → NOT synthesized yet', () => {
    const v = { master: 'm', reported: false, lastActivityAt: ago(3 * 60_000) };
    const w = { lastRespawnAt: ago(30_000) }; // we respawned it 30s ago, well inside the window
    const d = run(v, w);
    expect(d.action).not.toBe('synthesize-report');
  });

  test('…but once clear of that window with no further respawn, it IS synthesized', () => {
    const v = { master: 'm', reported: false, lastActivityAt: ago(3 * 60_000) };
    const w = { lastRespawnAt: ago(10 * 60_000) }; // long past — this respawn does not explain the quiet
    const d = run(v, w);
    expect(d.action).toBe('synthesize-report');
  });

  test('archived is terminal evidence on its own, no grace window needed', () => {
    const v = { master: 'm', reported: false, archived: true, lastActivityAt: ago(1000) };
    expect(run(v).action).toBe('synthesize-report');
  });

  // RES1 fix: a child whose respawn ladder gave up (proc genuinely dead, retries
  // exhausted) used to sit escalated forever with its master never told anything
  // — the synthesize-report branch was below the "already escalated" early
  // return and never reached. The ladder giving up IS terminal evidence; the
  // master must hear about it too, not just the human.
  test('a child the ladder gave up on (escalated) still gets its master a report, once', () => {
    const v = { master: 'm', reported: false, escalated: true, escalatedReason: 'proc-dead', claudeState: 'dead' };
    const d = run(v);
    expect(d.action).toBe('synthesize-report');
    expect(d.detail?.master).toBe('m');
    expect(d.detail?.terminal).toBe('escalated');
    // Fires once — the next tick falls through to the ordinary escalation cadence.
    const again = decide({ view: view(v), watermark: d.next, thresholds: th });
    expect(again.action).not.toBe('synthesize-report');
  });

  test('a child spawned but never tasked is NOT reported for', () => {
    // Its controller may be about to hand it its first job; a synthesized
    // "done" would close a worker that has not started.
    const d = run({ master: 'm', reported: false, hadTurn: false, lastActivityAt: ago(60 * 60_000) });
    expect(d.action).not.toBe('synthesize-report');
  });

  test('a child still inside the grace window is left alone', () => {
    expect(run({ master: 'm', reported: false, lastActivityAt: ago(30_000) }).action).toBe('none');
  });

  test('a child that DID report is never synthesized', () => {
    expect(run({ master: 'm', reported: true, lastActivityAt: ago(60 * 60_000) }).action).toBe('none');
  });

  test('a master waiting on a child that never got the ask → re-deliver', () => {
    const d = run({
      waitingOn: { sessionId: 'c1', since: new Date(ago(60_000)).toISOString(), what: 'merge the branch' },
      waitingOnChildKnows: false,
    });
    expect(d.action).toBe('redeliver-ask');
    expect(d.detail?.child).toBe('c1');
  });

  test('a master waiting on a child that DOES know is left alone', () => {
    const d = run({
      waitingOn: { sessionId: 'c1', since: new Date(ago(60_000)).toISOString(), what: 'merge' },
      waitingOnChildKnows: true,
    });
    expect(d.action).toBe('none');
  });

  test('the human has not seen the ask → re-notify, at most hourly', () => {
    const first = run({ reviewRequested: true });
    expect(first.action).toBe('notify-human');
    expect(decide({ view: view({ reviewRequested: true }), watermark: first.next, thresholds: th }).action).toBe('none');
    const later = decide({
      view: view({ reviewRequested: true }),
      watermark: first.next,
      thresholds: { ...th, now: NOW + 61 * 60_000 },
    });
    expect(later.action).toBe('notify-human');
  });

  test('an over-budget agent is WAITING_HUMAN and never auto-recovered (A3/A5)', () => {
    const d = run({ budgetExceeded: true, claudeState: 'dead', lastErrorClass: 'auth' });
    expect(d.health).toBe('WAITING_HUMAN');
    expect(['none', 'notify-human']).toContain(d.action);
  });
});

describe('the hard rule: a WAITING_HUMAN session is never touched', () => {
  const blockers: Partial<SessionView>[] = [
    { action: true },
    { screenRequest: true },
    { setupRequest: true },
    { reviewRequested: true },
    { mergePending: true },
    { budgetExceeded: true },
    { claudeState: 'awaiting-input' },
  ];
  // Everything that would otherwise trigger a rung of the ladder, at once.
  const alsoBroken: Partial<SessionView> = {
    lastErrorClass: 'auth',
    accountsExhausted: true,
    modelRungsLeft: 3,
    mcpDown: ['playwright'],
    master: 'm',
    reported: false,
    lastActivityAt: ago(24 * 3600_000),
    waitingOn: { sessionId: 'c1', since: new Date(ago(3600_000)).toISOString(), what: 'x' },
    waitingOnChildKnows: false,
  };
  for (const b of blockers) {
    const label = Object.keys(b)[0];
    test(`${label}: only 'none' or 'notify-human', on any watermark`, () => {
      for (const w of [wm(), wm({ nudges: 5, respawns: 5, authRetries: 5 }), wm({ lastNotifyAt: NOW })]) {
        const d = decide({ view: view({ ...alsoBroken, ...b }), watermark: w, thresholds: th });
        expect(d.health).toBe('WAITING_HUMAN');
        expect(['none', 'notify-human']).toContain(d.action);
      }
    });
  }
});

describe('a persisted escalation (metadata.supervisor) behaves like an in-memory one', () => {
  // claude.js escalates on its own at the bottom rung of the model ladder, long
  // before the supervisor's watermark knows anything about it — so the flag
  // lives on the session, survives a host restart, and both paths read it.
  const th2 = { ...th };
  test('it reads BLOCKED_SYSTEM with the recorded reason, whatever the last error text was', () => {
    const cl = classify(view({ escalated: true, escalatedReason: 'bottom rung, no quota left' }), th2);
    expect(cl.state).toBe('BLOCKED_SYSTEM');
    expect(cl.reason).toBe('bottom rung, no quota left');
  });

  test('the ladder is not walked again on a fresh watermark', () => {
    const d = decide({
      view: view({ escalated: true, escalatedReason: 'bottom rung, no quota left', claudeState: 'dead' }),
      watermark: wm(),
      thresholds: th2,
    });
    expect(['none', 'notify-human']).toContain(d.action);
    expect(d.next.respawns).toBe(0);
  });

  test('it still climbs back when the quota it was escalated for resets', () => {
    const d = decide({
      view: view({ escalated: true, modelRung: 2, modelRestoreAt: new Date(ago(1000)).toISOString() }),
      watermark: wm(),
      thresholds: th2,
    });
    expect(d.action).toBe('model-restore');
  });

  test('it produces a `system` row in the queue', () => {
    const row = waitingRow(
      view({ escalated: true, escalatedReason: 'bottom rung, no quota left' }),
      th2,
      new Date(ago(1000)).toISOString(),
      { escalated: true, detail: 'bottom rung, no quota left' }
    )!;
    expect(row.kind).toBe('system');
    expect(row.unblock).toBe('fix');
  });
});

describe('escalation is terminal until something moves', () => {
  test('an escalated session is not walked down the ladder again', () => {
    const v = view({ claudeState: 'dead' });
    const d = decide({ view: v, watermark: wm({ respawns: 2 }), thresholds: th });
    expect(d.action).toBe('escalate');
    expect(d.next.escalatedAt).toBe(NOW);
    const again = decide({ view: v, watermark: d.next, thresholds: { ...th, now: NOW + 1000 } });
    expect(again.action).toBe('none');
  });

  test('real progress clears the counters', () => {
    const w = resetOnProgress(wm({ respawns: 2, authRetries: 2, nudges: 3, escalatedAt: NOW }));
    expect(w).toMatchObject({ respawns: 0, authRetries: 0, nudges: 0, escalatedAt: 0 });
    expect(decide({ view: view({ claudeState: 'dead' }), watermark: w, thresholds: th }).action).toBe('respawn');
  });
});

// -------------------------------------------------------- the model ladder

describe('the model ladder', () => {
  test('the default chain is the host default', () => {
    expect(effectiveChain({})).toEqual([...DEFAULT_MODEL_CHAIN]);
  });

  test('most specific chain wins: session → agent → config', () => {
    expect(effectiveChain({ sessionChain: ['a', 'b'], agentChain: ['c'], configChain: ['d'] })).toEqual(['a', 'b']);
    expect(effectiveChain({ agentChain: ['c', 'd'], configChain: ['e'] })).toEqual(['c', 'd']);
    expect(effectiveChain({ configChain: ['e', 'f'] })).toEqual(['e', 'f']);
  });

  test("the human's pick is always the top rung, even off-chain", () => {
    expect(effectiveChain({ configChain: ['sonnet', 'haiku'], modelChoice: 'opus' })).toEqual(['opus', 'sonnet', 'haiku']);
    // …and it is not duplicated when it is already in the chain.
    expect(effectiveChain({ configChain: ['fable', 'sonnet'], modelChoice: 'sonnet' })).toEqual(['sonnet', 'fable']);
  });

  test('rungOf / nextRung / rungsLeft walk the chain', () => {
    const chain = ['fable', 'sonnet', 'haiku'];
    expect(rungOf(chain, 'sonnet')).toBe(1);
    expect(rungOf(chain, null)).toBe(0);
    expect(rungOf(chain, 'gpt')).toBe(-1);
    expect(nextRung(chain, 0)).toEqual({ model: 'sonnet', rung: 1 });
    expect(nextRung(chain, 1)).toEqual({ model: 'haiku', rung: 2 });
    expect(nextRung(chain, 2)).toBeNull();
    expect(rungsLeft(chain, 0)).toBe(2);
    expect(rungsLeft(chain, 2)).toBe(0);
  });

  test('restore only once the reset time has passed', () => {
    expect(shouldRestoreModel(null, NOW)).toBe(false);
    expect(shouldRestoreModel(new Date(NOW + 1000).toISOString(), NOW)).toBe(false);
    expect(shouldRestoreModel(new Date(NOW - 1000).toISOString(), NOW)).toBe(true);
    expect(shouldRestoreModel('not a date', NOW)).toBe(false);
  });
});

// ------------------------------------------------------ the "waiting for you" queue

describe('waitingRow — what is blocked, since when, and the one unblocking action', () => {
  const since = new Date(ago(5 * 60_000)).toISOString();
  const cases: [Partial<SessionView>, string, string][] = [
    [{ action: true }, 'action', 'answer'],
    [{ screenRequest: true }, 'screen', 'take-over'],
    [{ setupRequest: true }, 'setup', 'connect'],
    [{ reviewRequested: true }, 'review', 'approve'],
    [{ mergePending: true }, 'merge', 'merge'],
    [{ budgetExceeded: true }, 'budget', 'raise-cap'],
  ];
  for (const [patch, kind, unblock] of cases) {
    test(`${kind} → ${unblock}`, () => {
      const row = waitingRow(view(patch), th, since)!;
      expect(row).toBeTruthy();
      expect(row.kind).toBe(kind as never);
      expect(row.unblock).toBe(unblock as never);
      expect(row.what).toBe(`waiting.what.${kind}`);
      expect(row.since).toBe(since);
      expect(row.sessionId).toBe('s1');
    });
  }

  test('a healthy session contributes no row', () => {
    expect(waitingRow(view(), th, since)).toBeNull();
    expect(waitingRow(view({ claudeState: 'working' }), th, since)).toBeNull();
  });

  test('a system block only shows up once the ladder escalated it', () => {
    const v = view({ claudeState: 'dead' });
    expect(waitingRow(v, th, since)).toBeNull();
    const row = waitingRow(v, th, since, { escalated: true, detail: 'proc-dead' })!;
    expect(row.kind).toBe('system');
    expect(row.unblock).toBe('fix');
    expect(row.detail).toBe('proc-dead');
  });
});
