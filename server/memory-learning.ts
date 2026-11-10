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
import { runOneShot, hostEngine } from './lib/oneshot.js';
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
  numberLines,
  buildConsolidationPrompt,
  planConsolidation,
  learnSignature,
  type ConsolidationOp,
  type DeferredFact,
} from './lib/memory-consolidate.js';
import { ARIGAMI_DIR } from './lib/instance.js';
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
  fileHash,
  capFor,
  setCapsSource,
} from './memory.js';

// CONSOL1: the shared caps and per-agent caps come from config (absent = CAPS).
setCapsSource(() => (cfg as any).memory?.caps);

export const RUNS_FILE = path.join(MEMORY_DIR, 'learning-runs.jsonl');
export const STATE_FILE = path.join(MEMORY_DIR, 'learning-state.json');
export const CONSOLIDATION_FILE = path.join(MEMORY_DIR, 'consolidation-runs.jsonl');
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
  /**
   * CONSOL1: signature (pending ids + file hashes) of the last run that moved
   * nothing because the files were full. While it still matches, the scheduler
   * does not re-ask the model — before CONSOL1 it re-ran the same ~40 deferred
   * facts every 15 minutes (≈300 identical LLM calls in two weeks).
   */
  stuckSig?: string | null;
}

export interface ConsolidationRecord {
  kind: 'consolidation';
  id: string;
  ts: string;
  trigger: 'cap' | 'manual';
  /** auto: applied without a human (every op a verified dedupe) */
  applied: boolean;
  auto: boolean;
  baseHash: Record<Target, string>;
  ops: (ConsolidationOp & { applied?: boolean; logSeqs?: number[]; undone?: boolean; error?: string })[];
  admit: string[];
  deferred: DeferredFact[];
  tokens: { before: Record<Target, number>; after: Record<Target, number> };
  notes: string[];
  error?: string;
  durationMs: number;
}

interface ConsolidationPatch {
  kind: 'consolidation-patch';
  id: string;
  ts: string;
  applied?: boolean;
  auto?: boolean;
  ops?: Record<string, { applied?: boolean; logSeqs?: number[]; undone?: boolean; error?: string }>;
  notes?: string[];
}

export interface LearnerDeps {
  llm: (prompt: string) => Promise<string>;
  now: () => number;
  memAvailableMb: () => number;
  config: () => MemoryLearningConfig;
  log: (line: string) => void;
  emit: (event: Record<string, unknown>) => void;
  /** CONSOL1: tell the human a consolidation proposal waits for review. */
  notify: (n: { title: string; body: string; url?: string }) => void;
  /** CONSOL1: skill names the model may move procedures to. */
  skills: () => string[];
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
    return { firstSeenAt: parsed.firstSeenAt || null, lastRunAt: parsed.lastRunAt || null, lastDeferred: parsed.lastDeferred || null, stuckSig: parsed.stuckSig || null };
  } catch {
    return { firstSeenAt: null, lastRunAt: null, lastDeferred: null, stuckSig: null };
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

function appendConsolidationLine(obj: ConsolidationRecord | ConsolidationPatch): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.appendFileSync(CONSOLIDATION_FILE, JSON.stringify(obj) + '\n');
}

/** All consolidation proposals, newest first, patches folded in. */
export function readConsolidations(limit = 20): ConsolidationRecord[] {
  const recs = new Map<string, ConsolidationRecord>();
  for (const line of readSafe(CONSOLIDATION_FILE).split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.kind === 'consolidation') recs.set(o.id, o);
    else if (o.kind === 'consolidation-patch') {
      const r = recs.get(o.id);
      if (!r) continue;
      if (typeof o.applied === 'boolean') r.applied = o.applied;
      if (o.auto) r.auto = true;
      if (o.notes) r.notes = [...r.notes, ...o.notes];
      if (o.ops) for (const op of r.ops) if (o.ops[op.key]) Object.assign(op, o.ops[op.key]);
    }
  }
  return [...recs.values()].reverse().slice(0, Math.max(1, limit));
}

function defaultSkills(): string[] {
  const out = new Set<string>();
  for (const dir of [path.join(ARIGAMI_DIR, 'skills'), path.join(ARIGAMI_DIR, 'user', 'skills')]) {
    try {
      for (const d of fs.readdirSync(dir)) if (!d.startsWith('_') && !d.startsWith('.')) out.add(d);
    } catch { /* none */ }
  }
  return [...out].sort();
}

const hashes = (): Record<Target, string> => ({ user: fileHash('user'), memory: fileHash('memory') });

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
    llm: (prompt) => runOneShot(prompt, { engine: hostEngine(), cwd: MEMORY_DIR, timeoutMs: LLM_TIMEOUT_MS, tag: 'memory-learning' }),
    now: () => Date.now(),
    memAvailableMb: probeMemAvailableMb,
    config: () => cfg.memory?.learning || { mode: 'auto', minBatch: 40, maxAgeHours: 48, minFreeMb: 600 },
    log: (line) => console.log(`[memory-learning] ${line}`),
    emit: () => {},
    notify: (n) => {
      import('./notify.js').then((m: any) => m.notify?.({ ...n, tag: 'memory-consolidation' })).catch(() => {});
    },
    skills: defaultSkills,
    ...deps,
  };
  let running = false;
  let consolidating = false;
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

  async function run(opts: { trigger?: Trigger; apply?: boolean; consolidate?: boolean } = {}): Promise<RunRecord> {
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
      // CONSOL1: a run that moved nothing for lack of room is "stuck" until the
      // queue or the files change — remember its signature so tick() skips it.
      const capDeferred = rec.items.filter((i) => i.action === 'DEFER' && i.reasonKey === 'cap');
      const moved = rec.counts.entered + rec.counts.merged;
      st.stuckSig = apply && capDeferred.length && !moved ? learnSignature(listPending().map((p) => p.id), hashes()) : null;
      writeState(st);
      d.log(`run ${id} (${trigger}, ${apply ? 'applied' : 'proposed'}): ${rec.counts.proposed} proposed → ${rec.counts.entered} entered · ${rec.counts.merged} merged · ${rec.counts.dropped} dropped · ${rec.counts.deferred} deferred${rec.notes.length ? ' · ' + rec.notes.join(' | ') : ''}`);
      d.emit({ kind: 'learning', phase: 'done', runId: id, counts: rec.counts, applied: rec.applied });
      // CONSOL1: the files are full and facts wait — dream instead of deferring
      // forever (at most one open proposal per file state; see consolidate()).
      if (capDeferred.length && opts.consolidate !== false)
        queueMicrotask(() => {
          consolidate({ trigger: 'cap', deferred: capDeferred.map((i) => ({ key: i.key, target: i.target, content: i.content, count: i.count })) }).catch((e) =>
            d.log(`consolidation failed: ${(e as Error).message}`)
          );
        });
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

  // ---- consolidation ("dreaming", CONSOL1) ---------------------------------------------

  /** An unapplied proposal computed against the CURRENT files, if any (one at a time). */
  function openProposal(): ConsolidationRecord | null {
    const h = hashes();
    return readConsolidations(50).find((r) => !r.applied && !r.error && r.baseHash.user === h.user && r.baseHash.memory === h.memory) || null;
  }

  /**
   * One consolidation pass over the EXISTING lines of USER.md + MEMORY.md. The
   * model proposes a diff; it is applied without a human only in auto mode AND
   * only when every op is a deterministically verified MERGE/DROP of duplicates.
   * Anything else is stored as a reviewable proposal and the human is notified.
   */
  async function consolidate(opts: { trigger?: 'cap' | 'manual'; deferred?: DeferredFact[] } = {}): Promise<ConsolidationRecord | null> {
    if (consolidating) throw Object.assign(new Error('a consolidation is already in progress'), { status: 409 });
    const trigger = opts.trigger || 'manual';
    const existing = openProposal();
    if (existing && trigger === 'cap') return existing; // already waiting for the human — don't re-ask the model
    consolidating = true;
    const started = d.now();
    const id = `cr_${started.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { userMd, memoryMd } = docs();
    const baseHash = hashes();
    const deferred = opts.deferred || [];
    const rec: ConsolidationRecord = {
      kind: 'consolidation',
      id,
      ts: new Date(started).toISOString(),
      trigger,
      applied: false,
      auto: false,
      baseHash,
      ops: [],
      admit: [],
      deferred,
      tokens: { before: { user: estimateTokens(userMd), memory: estimateTokens(memoryMd) }, after: { user: 0, memory: 0 } },
      notes: [],
      durationMs: 0,
    };
    try {
      const lines = numberLines(userMd, memoryMd);
      const caps = { user: capFor('user'), memory: capFor('memory') };
      const text = await d.llm(buildConsolidationPrompt({ lines, deferred, caps, tokens: rec.tokens.before, skills: d.skills() }));
      const plan = planConsolidation({ text, userMd, memoryMd, deferredKeys: deferred.map((x) => x.key), estimateTokens });
      rec.ops = plan.ops;
      rec.admit = plan.admit;
      rec.tokens = plan.tokens;
      rec.notes.push(...plan.notes);
      rec.durationMs = d.now() - started;
      appendConsolidationLine(rec);
      if (!rec.ops.length) { d.log(`consolidation ${id}: nothing to change`); return rec; }
      const freed = rec.tokens.before.user + rec.tokens.before.memory - rec.tokens.after.user - rec.tokens.after.memory;
      if (d.config().mode === 'auto' && plan.withinAutoLimits) {
        // Auto mode manages its own memory, deletions included — archived to the
        // journal first, undo per op, and the human is told what changed.
        const applied = applyConsolidation(id, undefined, { auto: true });
        const n = applied.ops.filter((o) => o.applied).length;
        d.log(`consolidation ${id}: auto-applied ${n}/${applied.ops.length} op(s), ~${freed} tokens freed`);
        d.notify({
          title: 'Memory consolidated',
          body: `${n} change(s) to USER.md/MEMORY.md, ~${freed} tokens freed; removed lines archived to the journal. Undo per change in Settings.`,
          url: '/__host/#/settings/appearance/memory',
        });
        d.emit({ kind: 'consolidation', phase: 'auto-applied', id, ops: n, freed });
        return applied;
      }
      if (d.config().mode === 'auto') rec.notes.push('not auto-applied: the diff removes more than half of a file — waiting for review');
      d.notify({
        title: 'Memory consolidation ready for review',
        body: `${rec.ops.length} change(s) to USER.md/MEMORY.md, ~${freed} tokens freed, ${rec.admit.length} waiting fact(s) can enter after.`,
        url: '/__host/#/settings/appearance/memory',
      });
      d.emit({ kind: 'consolidation', phase: 'proposed', id, ops: rec.ops.length, freed });
      return rec;
    } catch (e) {
      rec.error = (e as Error).message;
      rec.durationMs = d.now() - started;
      appendConsolidationLine(rec);
      throw e;
    } finally {
      consolidating = false;
    }
  }

  /**
   * Apply a stored proposal (all ops, or only `keys`). The files must still be
   * exactly what the proposal was computed against (hash check) — otherwise 409:
   * line ids would point at the wrong text. Each write chains the previous
   * write's hash, so a concurrent memory_write in between aborts the rest of the
   * batch instead of being overwritten.
   */
  function applyConsolidation(id: string, keys?: string[], opts: { auto?: boolean } = {}): ConsolidationRecord {
    const rec = readConsolidations(1e6).find((r) => r.id === id);
    if (!rec) throw Object.assign(new Error('no such consolidation'), { status: 404 });
    if (rec.applied) throw Object.assign(new Error('consolidation already applied'), { status: 409 });
    const now = hashes();
    if (now.user !== rec.baseHash.user || now.memory !== rec.baseHash.memory)
      throw Object.assign(new Error('memory changed since this proposal was computed — run a new consolidation'), { status: 409 });
    const only = keys ? new Set(keys) : null;
    const source = `consolidation:${id}`;
    const expect: Record<Target, string> = { ...rec.baseHash };
    const patch: ConsolidationPatch = { kind: 'consolidation-patch', id, ts: new Date(d.now()).toISOString(), applied: true, ops: {} };
    let aborted = false;
    for (const op of rec.ops) {
      if (only && !only.has(op.key)) continue;
      if (aborted) { patch.ops![op.key] = { applied: false, error: 'not applied: an earlier write conflicted' }; continue; }
      const seqs: number[] = [];
      let error: string | undefined;
      const steps: { action: 'replace' | 'remove'; old: string; content?: string }[] =
        op.kind === 'MERGE' || op.kind === 'REWRITE'
          ? [{ action: 'replace', old: op.originals[0], content: op.content }, ...op.originals.slice(1).map((o) => ({ action: 'remove' as const, old: o }))]
          : [{ action: 'remove', old: op.originals[0] }];
      // Archive what is about to disappear (journal: append-only, searchable) —
      // a deletion by the learner never loses the text, it only stops being injected.
      const file = op.target === 'user' ? 'USER.md' : 'MEMORY.md';
      const why = op.kind === 'MOVE_TO_SKILL' ? `belongs in skill ${op.skill || '?'}` : op.reason || op.kind.toLowerCase();
      for (const o of op.originals)
        writeMemory({ target: 'journal', action: 'add', content: `[memory ${op.kind} ${id}/${op.key}] removed from ${file} (${why}): ${o}`, source });
      for (const st of steps) {
        const r = writeMemory({ target: op.target, action: st.action, old_text: st.old, content: st.content, source, expectedHash: expect[op.target] });
        if (!r.ok) { error = r.error; if (r.conflict) aborted = true; break; }
        if (r.logSeq) seqs.push(r.logSeq);
        if (r.hash) expect[op.target] = r.hash;
      }
      patch.ops![op.key] = { applied: !error && seqs.length === steps.length, logSeqs: seqs, error };
    }
    appendConsolidationLine({ ...patch, ...(opts.auto ? { auto: true, notes: ['auto-applied (auto mode)'] } : {}) });
    // The files changed → the stuck signature no longer matches; the next tick
    // re-runs learning and the facts waiting for room can now enter.
    const st = readState();
    st.stuckSig = null;
    writeState(st);
    d.emit({ kind: 'consolidation', phase: 'applied', id });
    return readConsolidations(1e6).find((r) => r.id === id)!;
  }

  /** Revert ONE applied op: put its original line(s) back, remove the merged/rewritten line. */
  function undoConsolidation(id: string, key: string): { ok: boolean; error?: string } {
    const rec = readConsolidations(1e6).find((r) => r.id === id);
    const op = rec?.ops.find((o) => o.key === key);
    if (!rec || !op) return { ok: false, error: 'no such consolidation op' };
    if (!op.applied) return { ok: false, error: 'op was not applied' };
    if (op.undone) return { ok: false, error: 'already undone' };
    const source = `consolidation-undo:${id}:${key}`;
    if (op.kind === 'MERGE' || op.kind === 'REWRITE') {
      const r = writeMemory({ target: op.target, action: 'replace', old_text: op.content, content: op.originals[0], source, allowOverCap: true });
      if (!r.ok) return { ok: false, error: r.error };
    }
    const readd = op.kind === 'MERGE' || op.kind === 'REWRITE' ? op.originals.slice(1) : op.originals;
    for (const o of readd) {
      const r = writeMemory({ target: op.target, action: 'add', content: o, source, allowOverCap: true });
      if (!r.ok) return { ok: false, error: r.error };
    }
    appendConsolidationLine({ kind: 'consolidation-patch', id, ts: new Date(d.now()).toISOString(), ops: { [key]: { undone: true } } });
    d.emit({ kind: 'consolidation', phase: 'undone', id, key });
    return { ok: true };
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
      /** CONSOL1: the open consolidation proposal (computed against the current files), if any */
      consolidation: openProposal(),
      preview: opts.preview === false ? undefined : preview(),
    };
  }

  async function tick(): Promise<{ ran: boolean; verdict: ScheduleVerdict }> {
    const pending = listPending().length;
    const st = readState();
    if (pending > 0 && !st.firstSeenAt) { st.firstSeenAt = new Date(d.now()).toISOString(); writeState(st); }
    if (pending === 0 && st.firstSeenAt && !st.lastRunAt) { st.firstSeenAt = null; writeState(st); }
    const v = verdict(pending);
    if (v.run && st.stuckSig && st.stuckSig === learnSignature(listPending().map((p) => p.id), hashes())) {
      // Nothing changed since a run that could not move anything — asking again
      // returns the same answer. A new proposal or any file edit clears this.
      return { ran: false, verdict: { run: false, deferred: 'not-yet', reason: v.reason } };
    }
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

  return {
    run,
    applyRun,
    approveClusters,
    undo,
    status,
    preview,
    tick,
    verdict,
    start,
    stop,
    readRuns,
    consolidate,
    applyConsolidation,
    undoConsolidation,
    readConsolidations,
    isRunning: () => running,
  };
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
