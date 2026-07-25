// Worker watchdog — the pure decision for the `worker` listener type (decision 8).
// The backstop for failure modes an explicit report_to_master can't cover: a
// crashed worker (claude proc died), or a hung / silently-finished one (no state
// change and no report for too long). Kept pure (no state singleton, no IO) so it
// is unit-testable the same way listeners-pr.ts is. listeners.ts does the IO
// around it (read the worker, enqueue the thin wake to the master).

export interface WorkerWatermark {
  lastState: string | null; // claude_state at the last evaluation (crash de-dupe)
  lastStallActivity: number; // activity epoch we last fired a stall for (de-dupe)
}

export interface WorkerView {
  claudeState?: string; // worker.claude.state
  updatedAt?: string; // worker.updatedAt — bumps on any state change / event
  result?: { state?: string; reportedAt?: string } | null; // worker.metadata.result
}

export type WatchdogAction = 'retire' | 'crash' | 'stall' | 'none';

export interface WatchdogDecision {
  action: WatchdogAction;
  reason?: string;
  nextWatermark: WorkerWatermark;
}

const TERMINAL = new Set(['done', 'blocked', 'error']);

// Decide what (if anything) the watchdog should do about a worker this tick.
// - retire: the worker reached a terminal state via its own report — the explicit
//   path covered it, so the watchdog stops watching.
// - crash:  claude_state transitioned to 'dead' — fire once (de-duped via lastState).
// - stall:  no activity (state change or report) for longer than stallMs — fire
//   once per activity timestamp (de-duped via lastStallActivity). Covers hang +
//   silent-done (a worker that finished but never reported).
// - none:   nothing to do; just advance lastState.
export function evaluateWorker(input: {
  worker: WorkerView;
  watermark: WorkerWatermark;
  stallMs: number;
  now: number;
}): WatchdogDecision {
  const { worker, watermark, stallMs, now } = input;
  const cstate = worker.claudeState;

  if (worker.result && TERMINAL.has(worker.result.state || ''))
    return { action: 'retire', reason: worker.result.state, nextWatermark: watermark };

  if (cstate === 'dead' && watermark.lastState !== 'dead')
    return { action: 'crash', nextWatermark: { ...watermark, lastState: 'dead' } };

  const lastActivity = Math.max(
    worker.updatedAt ? Date.parse(worker.updatedAt) || 0 : 0,
    worker.result?.reportedAt ? Date.parse(worker.result.reportedAt) || 0 : 0
  );
  const idleMs = now - lastActivity;
  if (
    cstate !== 'dead' &&
    lastActivity > 0 &&
    idleMs > stallMs &&
    watermark.lastStallActivity !== lastActivity
  ) {
    return {
      action: 'stall',
      reason: `${Math.round(idleMs / 1000)}s`,
      nextWatermark: { lastState: cstate ?? null, lastStallActivity: lastActivity },
    };
  }

  return { action: 'none', nextWatermark: { ...watermark, lastState: cstate ?? watermark.lastState } };
}
