// LEARN1 — autonomous memory learning: the IO half. Turns the pending queue
// (memory.ts proposeFacts → pending.json) into MEMORY.md/USER.md lines the way
// the human did by hand: a deterministic pre-pass (lib/memory-triage.ts) drops
// the sensitive / already-known / repo-doc rows and clusters the restatements,
// ONE one-shot LLM call decides ENTER / MERGE / DROP per cluster with a reason,
// planWithCap() keeps the result under the token caps, and the apply step goes
// through the SAME gate every approval does (approvePending / mergePending →
// writeMemory: sanitize, dedupe, cap, append-only log). Nothing here bypasses it.
//
// Every run is persisted to $ARIGAMI_DIR/memory/learning-runs.jsonl (append-only:
// one line per run, then `patch` lines for apply/undo; folded on read) with the
// write-log seq of each applied line so Undo can revert exactly that line.
//
// Modes (cfg.memory.learning.mode): `auto` — the scheduler runs when ≥minBatch
// proposals accumulated OR maxAgeHours passed since the last run, applies, and
// records; `manual` — a run is computed and stored with every ENTER/MERGE
// pre-checked, the human approves with one click. Neither ever runs while the
// host is under memory pressure (MemAvailable < minFreeMb — same probe the
// claude updater uses); the scheduler just tries again next tick.
import fs from 'node:fs';
import path from 'node:path';
import { cfg, type MemoryLearningConfig } from './lib/config.js';
import { runClaudeOneShot } from './lib/oneshot.js';
import { memAvailableMb as probeMemAvailableMb } from './lib/claude-update.js';
import {
  prepass,
  buildPrompt,
  parseDecisions,
  planWithCap,
  shouldRun,
  nextRun,
  type Cluster,
  type Decision,
  type Dropped,
  type Action,
  type Target,
  type ReasonKey,
  type ScheduleVerdict,
} from './lib/memory-triage.js';
import {
  MEMORY_DIR,
  USER_MD,
  MEMORY_MD,
  CAPS,
  estimateTokens,
  sanitize,
  listPending,
  approvePending,
  mergePending,
  rejectPending,
  setPendingStatus,
  writeMemory,
  undoLog,
  getLog,
} from './memory.js';

export const RUNS_FILE = path.join(MEMORY_DIR, 'learning-runs.jsonl');
export const STATE_FILE = path.join(MEMORY_DIR, 'learning-state.json');
export const TICK_MS = 15 * 60 * 1000;
export const BOOT_DELAY_MS = 2 * 60 * 1000; // after the claude updater's own 90s — let the host settle
export const LLM_TIMEOUT_MS = 4 * 60 * 1000;
export const MAX_CLUSTERS_PER_RUN = 60; // keeps one prompt well inside a single call; the rest waits for the next run

export type Trigger = 'manual' | 'auto-batch' | 'auto-age' | 'manual-approve';

export interface RunItem {
  key: string;
  action: Action;
  target: Target;
  content: string;
  ids: string[];
  count: number;
  sessions?: number;
  reason: string;
  reasonKey?: ReasonKey;
  detail?: string;
  mergeInto?: string;
  /** manual mode: pre-checked (ENTER/MERGE) — the human may untick before "approve N" */
  checked?: boolean;
  applied?: boolean;
  logSeq?: number;
  error?: string;
  undone?: boolean;
}

export interface RunRecord {
  id: string;
  ts: string;
  trigger: Trigger;
  mode: 'auto' | 'manual';
  applied: boolean;
  counts: { proposed: number; clusters: number; entered: number; merged: number; dropped: number; deferred: number };
  items: RunItem[];
  notes: string[];
  error?: string;
  durationMs: number;
  llm: boolean;
}

interface RunPatch {
  kind: 'patch';
  runId: string;
  ts: string;
  applied?: boolean;
  items?: Record<string, Partial<RunItem>>;
  notes?: string[];
  counts?: RunRecord['counts'];
}

interface LearningState {
  firstSeenAt: string | null;
  lastRunAt: string | null;
  lastDeferred: { at: string; reason: string; availableMb?: number } | null;
}

export interface LearnerDeps {
  llm: (prompt: string) => Promise<string>;
  now: () => number;
  memAvailableMb: () => number;
  config: () => MemoryLearningConfig;
  log: (line: string) => void;
  emit: (event: Record<string, unknown>) => void;
}

const readSafe = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function readState(): LearningState {
  try {
    const parsed = JSON.parse(readSafe(STATE_FILE) || '{}');
    return { firstSeenAt: parsed.firstSeenAt || null, lastRunAt: parsed.lastRunAt || null, lastDeferred: parsed.lastDeferred || null };
  } catch {
    return { firstSeenAt: null, lastRunAt: null, lastDeferred: null };
  }
}

function writeState(st: LearningState): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

function appendRunLine(obj: RunRecord | RunPatch): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.appendFileSync(RUNS_FILE, JSON.stringify(obj) + '\n');
}

function recount(items: RunItem[]): RunRecord['counts'] {
  const c = { proposed: 0, clusters: 0, entered: 0, merged: 0, dropped: 0, deferred: 0 };
  for (const it of items) {
    c.proposed += it.count;
    if (it.action === 'ENTER') c.entered++;
    else if (it.action === 'MERGE') c.merged++;
    else if (it.action === 'DROP') c.dropped += it.count;
    else c.deferred += it.count;
  }
  c.clusters = items.filter((i) => i.action !== 'DROP').length;
  return c;
}

/** All runs, newest first, with patch lines folded in. */
export function readRuns(limit = 50): RunRecord[] {
  const runs = new Map<string, RunRecord>();
  for (const line of readSafe(RUNS_FILE).split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.kind === 'patch') {
      const r = runs.get(obj.runId);
      if (!r) continue;
      if (typeof obj.applied === 'boolean') r.applied = obj.applied;
      if (obj.notes) r.notes = [...r.notes, ...obj.notes];
      if (obj.items) for (const it of r.items) if (obj.items[it.key]) Object.assign(it, obj.items[it.key]);
      if (obj.counts) r.counts = obj.counts;
      else r.counts = recount(r.items);
    } else if (obj.id) runs.set(obj.id, obj as RunRecord);
  }
  return [...runs.values()].reverse().slice(0, Math.max(1, limit));
}

function runId(now: number): string {
  return `lr_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function clusterToItem(c: Cluster, d: Decision): RunItem {
  return {
    key: c.key,
    action: d.action,
    target: d.target,
    content: d.content,
    ids: c.ids,
    count: c.count,
    sessions: c.sessions,
    reason: d.reason,
    reasonKey: d.reasonKey,
    mergeInto: d.mergeInto,
    checked: d.action === 'ENTER' || d.action === 'MERGE',
  };
}

function droppedToItem(d: Dropped): RunItem {
  return { key: d.key, action: 'DROP', target: d.target, content: d.content, ids: d.ids, count: d.count, reason: '', reasonKey: d.reasonKey, detail: d.detail, checked: false };
}

export function createLearner(deps: Partial<LearnerDeps> = {}) {
  const d: LearnerDeps = {
    llm: (prompt) => runClaudeOneShot(prompt, { cwd: MEMORY_DIR, timeoutMs: LLM_TIMEOUT_MS, tag: 'memory-learning' }),
    now: () => Date.now(),
    memAvailableMb: probeMemAvailableMb,
    config: () => cfg.memory?.learning || { mode: 'auto', minBatch: 40, maxAgeHours: 48, minFreeMb: 600 },
    log: (line) => console.log(`[memory-learning] ${line}`),
    emit: () => {},
    ...deps,
  };
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let boot: ReturnType<typeof setTimeout> | null = null;

  const docs = () => ({ userMd: readSafe(USER_MD), memoryMd: readSafe(MEMORY_MD) });

  /** The deterministic pre-pass over the live queue (no LLM) — the manual block's default view. */
  function preview() {
    const items = listPending();
    const { userMd, memoryMd } = docs();
    const r = prepass({ items, userMd, memoryMd, sanitize });
    return {
      pending: items.length,
      clusters: r.clusters.map((c) => ({ key: c.key, ids: c.ids, content: c.representative, count: c.count, sessions: c.sessions, target: c.target, related: c.related?.line, checked: true })),
      dropped: r.dropped.map(droppedToItem),
    };
  }

  // ---- apply ---------------------------------------------------------------------

  function applyItem(it: RunItem, source: string): RunItem {
    const out: RunItem = { ...it };
    const [primary, ...rest] = it.ids;
    if (it.action === 'ENTER') {
      const r = approvePending(primary, { content: it.content, target: it.target, source });
      if (r.ok) {
        out.applied = true;
        out.logSeq = r.logSeq;
        if (r.deduped) out.detail = 'already present — nothing written';
        if (rest.length) setPendingStatus(rest, 'rejected', { source, reason: 'restatement of an entered fact' });
      } else {
        out.applied = false;
        out.error = r.error;
        if (/cap/.test(r.error || '')) { out.action = 'DEFER'; out.reasonKey = 'cap'; }
      }
      return out;
    }
    if (it.action === 'MERGE') {
      const r = mergePending(primary, { oldText: it.mergeInto || '', content: it.content, target: it.target, source });
      if (r.ok) {
        out.applied = true;
        out.logSeq = r.logSeq;
        if (rest.length) setPendingStatus(rest, 'rejected', { source, reason: 'restatement of a merged fact' });
      } else if (/not found/.test(r.error || '')) {
        // The line moved since planning — fall back to a plain add through the same gate.
        const add = approvePending(primary, { content: it.content, target: it.target, source });
        out.action = 'ENTER';
        out.reasonKey = 'merge-target-missing';
        out.applied = !!add.ok;
        out.logSeq = add.logSeq;
        out.error = add.ok ? undefined : add.error;
        if (add.ok && rest.length) setPendingStatus(rest, 'rejected', { source, reason: 'restatement of an entered fact' });
      } else {
        out.applied = false;
        out.error = r.error;
        if (/cap/.test(r.error || '')) { out.action = 'DEFER'; out.reasonKey = 'cap'; }
      }
      return out;
    }
    if (it.action === 'DROP') {
      for (const id of it.ids) rejectPending(id, { source, reason: it.reasonKey || it.reason || 'dropped by triage' });
      out.applied = true;
      return out;
    }
    return out; // DEFER: stays pending
  }

  function applyItems(items: RunItem[], source: string, only?: Set<string>): RunItem[] {
    return items.map((it) => {
      if (it.applied || it.action === 'DEFER') return it;
      if (it.action === 'DROP') return applyItem(it, source);
      // ENTER/MERGE: in a selective apply, an unticked row stays pending (not dropped —
      // the human said "not now", not "never").
      if (only && !only.has(it.key)) return { ...it, checked: false, action: 'DEFER', reasonKey: undefined, reason: it.reason };
      return applyItem(it, source);
    });
  }

  // ---- one run ---------------------------------------------------------------------

  async function run(opts: { trigger?: Trigger; apply?: boolean } = {}): Promise<RunRecord> {
    if (running) throw Object.assign(new Error('a learning run is already in progress'), { status: 409 });
    running = true;
    const started = d.now();
    const conf = d.config();
    const trigger: Trigger = opts.trigger || 'manual';
    const apply = opts.apply ?? conf.mode === 'auto';
    const id = runId(started);
    d.emit({ kind: 'learning', phase: 'start', runId: id });
    const rec: RunRecord = {
      id,
      ts: new Date(started).toISOString(),
      trigger,
      mode: conf.mode,
      applied: false,
      counts: { proposed: 0, clusters: 0, entered: 0, merged: 0, dropped: 0, deferred: 0 },
      items: [],
      notes: [],
      durationMs: 0,
      llm: false,
    };
    try {
      const items = listPending();
      const { userMd, memoryMd } = docs();
      const pre = prepass({ items, userMd, memoryMd, sanitize });
      let clusters = pre.clusters;
      if (clusters.length > MAX_CLUSTERS_PER_RUN) {
        rec.notes.push(`${clusters.length - MAX_CLUSTERS_PER_RUN} clusters left for the next run (one call handles ${MAX_CLUSTERS_PER_RUN})`);
        clusters = clusters.slice(0, MAX_CLUSTERS_PER_RUN);
      }
      let decisions: Decision[] = [];
      if (clusters.length) {
        const text = await d.llm(buildPrompt(clusters, userMd, memoryMd));
        rec.llm = true;
        const parsed = parseDecisions(text, clusters, { userMd, memoryMd });
        rec.notes.push(...parsed.notes);
        const planned = planWithCap({ decisions: parsed.decisions, userMd, memoryMd, caps: CAPS, estimateTokens });
        rec.notes.push(...planned.notes);
        decisions = planned.decisions;
      }
      rec.items = [...clusters.map((c, i) => clusterToItem(c, decisions[i])), ...pre.dropped.map(droppedToItem)];
      if (apply) {
        rec.items = applyItems(rec.items, `learning:${id}`);
        rec.applied = true;
      }
      rec.counts = recount(rec.items);
      rec.durationMs = d.now() - started;
      appendRunLine(rec);
      const st = readState();
      st.lastRunAt = new Date(d.now()).toISOString();
      st.lastDeferred = null;
      writeState(st);
      d.log(`run ${id} (${trigger}, ${apply ? 'applied' : 'proposed'}): ${rec.counts.proposed} proposed → ${rec.counts.entered} entered · ${rec.counts.merged} merged · ${rec.counts.dropped} dropped · ${rec.counts.deferred} deferred${rec.notes.length ? ' · ' + rec.notes.join(' | ') : ''}`);
      d.emit({ kind: 'learning', phase: 'done', runId: id, counts: rec.counts, applied: rec.applied });
      return rec;
    } catch (e) {
      rec.error = (e as Error).message;
      rec.durationMs = d.now() - started;
      appendRunLine(rec);
      d.log(`run ${id} failed: ${rec.error}`);
      d.emit({ kind: 'learning', phase: 'error', runId: id, error: rec.error });
      throw e;
    } finally {
      running = false;
    }
  }

  /** Manual mode: apply a stored (un-applied) run — all pre-checked items, or only `keys`. */
  function applyRun(id: string, keys?: string[]): RunRecord {
    const rec = readRuns(1e6).find((r) => r.id === id);
    if (!rec) throw Object.assign(new Error('no such run'), { status: 404 });
    if (rec.applied) throw Object.assign(new Error('run already applied'), { status: 409 });
    const only = keys ? new Set(keys) : undefined;
    const items = applyItems(rec.items, `learning:${id}`, only);
    const patch: RunPatch = { kind: 'patch', runId: id, ts: new Date(d.now()).toISOString(), applied: true, items: {} };
    for (const it of items) patch.items![it.key] = { action: it.action, applied: it.applied, logSeq: it.logSeq, error: it.error, checked: it.checked, reasonKey: it.reasonKey };
    patch.counts = recount(items);
    appendRunLine(patch);
    d.emit({ kind: 'learning', phase: 'applied', runId: id, counts: patch.counts });
    return { ...rec, items, applied: true, counts: patch.counts };
  }

  /**
   * Manual mode without the model: approve the ticked pre-pass clusters as-is
   * (representative phrasing), reject the rest of each cluster and the
   * deterministic drops. Recorded as a run so the log shows it like any other.
   */
  function approveClusters(keys: string[]): RunRecord {
    const started = d.now();
    const pv = preview();
    const id = runId(started);
    const want = new Set(keys);
    const items: RunItem[] = [
      ...pv.clusters.map((c) => ({
        key: c.key,
        action: (want.has(c.key) ? 'ENTER' : 'DEFER') as Action,
        target: c.target,
        content: c.content,
        ids: c.ids,
        count: c.count,
        sessions: c.sessions,
        reason: '',
        checked: want.has(c.key),
      })),
      ...pv.dropped,
    ];
    const rec: RunRecord = {
      id,
      ts: new Date(started).toISOString(),
      trigger: 'manual-approve',
      mode: d.config().mode,
      applied: true,
      counts: { proposed: 0, clusters: 0, entered: 0, merged: 0, dropped: 0, deferred: 0 },
      items: applyItems(items, `learning:${id}`),
      notes: [],
      durationMs: d.now() - started,
      llm: false,
    };
    rec.counts = recount(rec.items);
    appendRunLine(rec);
    const st = readState();
    st.lastRunAt = new Date(d.now()).toISOString();
    writeState(st);
    return rec;
  }

  // ---- undo ----------------------------------------------------------------------

  /**
   * Revert ONE applied line by its write-log seq. Targeted (remove the entered
   * line / put the merged line back) so later writes survive — the existing
   * whole-file undoLog(seq) is the fallback when the line is no longer there.
   */
  function undo(seq: number): { ok: boolean; error?: string; logSeq?: number; fallback?: boolean } {
    let hit: { run: RunRecord; item: RunItem } | null = null;
    for (const run of readRuns(1e6)) {
      const item = run.items.find((i) => i.logSeq === seq);
      if (item) { hit = { run, item }; break; }
    }
    if (!hit) return { ok: false, error: 'no learning item with that log seq' };
    if (hit.item.undone) return { ok: false, error: 'already undone' };
    const { run, item } = hit;
    const source = `learning-undo:${seq}`;
    let r;
    if (item.action === 'MERGE' && item.mergeInto) r = writeMemory({ target: item.target, action: 'replace', old_text: item.content, content: item.mergeInto, source });
    else r = writeMemory({ target: item.target, action: 'remove', old_text: item.content, source });
    let fallback = false;
    if (!r.ok && /not found/.test(r.error || '')) {
      const entry = getLog(1e9).find((e) => e.seq === seq);
      if (!entry) return { ok: false, error: r.error };
      r = undoLog(seq);
      fallback = true;
    }
    if (!r.ok) return r;
    setPendingStatus(item.ids, 'rejected', { source, reason: 'undone by the human' });
    appendRunLine({ kind: 'patch', runId: run.id, ts: new Date(d.now()).toISOString(), items: { [item.key]: { undone: true } } });
    d.emit({ kind: 'learning', phase: 'undone', runId: run.id, seq });
    return { ok: true, logSeq: r.logSeq, fallback };
  }

  // ---- status + scheduler ----------------------------------------------------------

  function verdict(pendingCount: number): ScheduleVerdict {
    const conf = d.config();
    const st = readState();
    return shouldRun({
      mode: conf.mode,
      pending: pendingCount,
      lastRunAt: st.lastRunAt ? Date.parse(st.lastRunAt) : null,
      firstSeenAt: st.firstSeenAt ? Date.parse(st.firstSeenAt) : null,
      now: d.now(),
      minBatch: conf.minBatch,
      maxAgeHours: conf.maxAgeHours,
      memAvailableMb: d.memAvailableMb(),
      minFreeMb: conf.minFreeMb,
      running,
    });
  }

  function status(opts: { runs?: number; preview?: boolean } = {}) {
    const conf = d.config();
    const st = readState();
    const pending = listPending().length;
    const next = nextRun({
      pending,
      lastRunAt: st.lastRunAt ? Date.parse(st.lastRunAt) : null,
      firstSeenAt: st.firstSeenAt ? Date.parse(st.firstSeenAt) : null,
      minBatch: conf.minBatch,
      maxAgeHours: conf.maxAgeHours,
    });
    const runs = readRuns(opts.runs ?? 20);
    const proposed = runs.find((r) => !r.applied && !r.error) || null;
    return {
      mode: conf.mode,
      config: conf,
      pending,
      running,
      lastRunAt: st.lastRunAt,
      nextRun: next,
      lastDeferred: st.lastDeferred,
      memAvailableMb: d.memAvailableMb(),
      runs,
      /** manual mode: the latest computed-but-unapplied run (pre-checked), if any */
      proposedRun: proposed,
      preview: opts.preview === false ? undefined : preview(),
    };
  }

  async function tick(): Promise<{ ran: boolean; verdict: ScheduleVerdict }> {
    const pending = listPending().length;
    const st = readState();
    if (pending > 0 && !st.firstSeenAt) { st.firstSeenAt = new Date(d.now()).toISOString(); writeState(st); }
    if (pending === 0 && st.firstSeenAt && !st.lastRunAt) { st.firstSeenAt = null; writeState(st); }
    const v = verdict(pending);
    if (!v.run) {
      if (v.deferred === 'memory') {
        const mb = d.memAvailableMb();
        st.lastDeferred = { at: new Date(d.now()).toISOString(), reason: 'memory', availableMb: mb };
        writeState(st);
        d.log(`deferred (${v.reason}): ${mb}MB available < ${d.config().minFreeMb}MB`);
      }
      return { ran: false, verdict: v };
    }
    await run({ trigger: v.reason === 'batch' ? 'auto-batch' : 'auto-age', apply: true });
    return { ran: true, verdict: v };
  }

  function start({ bootDelayMs = BOOT_DELAY_MS, tickMs = TICK_MS } = {}) {
    stop();
    const beat = () => tick().catch((e) => d.log(`tick failed: ${(e as Error).message}`));
    boot = setTimeout(() => { beat(); timer = setInterval(beat, tickMs); }, bootDelayMs);
  }

  function stop() {
    if (boot) clearTimeout(boot);
    if (timer) clearInterval(timer);
    boot = null;
    timer = null;
  }

  return { run, applyRun, approveClusters, undo, status, preview, tick, verdict, start, stop, readRuns, isRunning: () => running };
}

export type Learner = ReturnType<typeof createLearner>;

// ---- singleton wiring (the host) ---------------------------------------------------

let singleton: Learner | null = null;

export function learner(): Learner {
  if (singleton) return singleton;
  singleton = createLearner({
    emit: (event) => {
      import('./bus.js').then((bus: any) => bus.broadcast({ type: 'host', event })).catch(() => {});
    },
  });
  return singleton;
}

/** index.ts: arm the scheduler (auto mode only ever fires; manual just keeps the age anchor). */
export function startLearningScheduler(): Learner {
  const l = learner();
  l.start();
  return l;
}
