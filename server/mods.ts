// MODS — Arigami's runtime for Claude Code mods, for engines that have no mods of their own (codex).
//
// One mod, two places it runs: a Claude session loads an extension's mod natively (`--plugin-dir`, claude.js),
// and every other engine runs the SAME hooks module here, against the same API shape — `register(on, options)`,
// `on(event, [matcher], async ($, e, next) => …)`, middleware `next(e)`, `{ deny }` / `{ result }` / `{ drop }`,
// `.catch(handler)` with `next.called` / `next.error` — so a mod written for Claude Code runs on codex unchanged
// as long as it stays inside the subset below.
//
// Where the events come from (the engine adapters):
//   tool.call      codex's Claude-shaped hooks (mcp/policy-hook.js --mods): PreToolUse runs the chain up to the
//                  point where the last hook calls next(e) — that is where the engine runs the tool — and the
//                  chain stays suspended until PostToolUse brings the result back (paired by tool_use_id). What the
//                  hooks return after next() decides the PostToolUse answer.
//   prompt.submit  the host itself, on .../message, before the text reaches the engine.
//   session.start  once per session, before its first event.
// Any other event a mod registers is never fired here; it is reported once per load (unsupported()).
//
// The `$` subset: plugin, env, http, fs, process, store, session, clock, ui (log/toast/notice → a chat card).
// Calling anything else throws "… is not available in Arigami's mods runtime", so a mod never fails open silently.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ARIGAMI_DIR } from './lib/instance.js';
import { extensionMods, type ExtMod } from './extensions.js';

export const SUPPORTED_EVENTS = ['tool.call', 'prompt.submit', 'session.start'];
/** Claude Code's limit on a hook's own time before it calls next / returns. */
const HOOK_BUDGET_MS = 10_000;
const CATCH_BUDGET_MS = 1_000;
/** How long a suspended tool.call chain waits for its PostToolUse (a long build is a long tool call). */
const TOOL_RESULT_WAIT_MS = 30 * 60_000;
/** How long PostToolUse waits for the hooks after next() to decide. */
const AFTER_NEXT_WAIT_MS = 20_000;

type Hook = ($: any, e: any, next: Next) => Promise<any>;
type Next = ((e: any) => Promise<any>) & { called: boolean; error?: { kind: string; message: string }; signal: AbortSignal; origin: { plugin: string; tier: string }; budget: { ms: number; remainingMs: number } };
interface Registration { mod: string; event: string; matcher: Record<string, unknown> | null; hook: Hook; onError: Hook | null }
interface SessionCtx { id: string; cwd: string; env: Record<string, string>; card: (mod: string, text: string) => void }
interface Loaded { regs: Registration[]; unsupported: string[]; mtime: number; started: boolean }

// ---------------------------------------------------------------------------
// loading — one module instance PER SESSION, like Claude Code (each session is its own process there)
// ---------------------------------------------------------------------------
const loaded = new Map<string, Loaded>(); // `${sessionId}` → registrations of every mod

const mtimeOf = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

async function loadFor(ctx: SessionCtx): Promise<Loaded> {
  const mods = extensionMods();
  const mtime = mods.reduce((a, m) => Math.max(a, mtimeOf(m.hooksJson), ...m.modules.map(mtimeOf)), mods.length);
  const cur = loaded.get(ctx.id);
  if (cur && cur.mtime === mtime) return cur;
  const regs: Registration[] = [];
  const unsupported: string[] = [];
  for (const m of mods) {
    for (const file of m.modules) {
      try {
        const mod = await import(`${pathToFileURL(file).href}?s=${encodeURIComponent(ctx.id)}&t=${mtimeOf(file)}`);
        if (typeof mod.register !== 'function') throw new Error('the hooks module exports no register(on, options)');
        const on = (event: string, a: any, b?: any) => {
          const matcher = typeof a === 'function' ? null : a || null;
          const reg: Registration = { mod: m.name, event, matcher, hook: typeof a === 'function' ? a : b, onError: null };
          if (!SUPPORTED_EVENTS.includes(event) && !unsupported.includes(`${m.name}: ${event}`)) unsupported.push(`${m.name}: ${event}`);
          regs.push(reg);
          return { catch(h: Hook) { reg.onError = h; return this; } };
        };
        await mod.register(on, {});
      } catch (e) {
        ctx.card(m.name, `mod did not load here (${(e as Error).message}) — it is NOT enforced in this session`);
      }
    }
  }
  if (unsupported.length) ctx.card('mods', `not run by this engine (Arigami runs ${SUPPORTED_EVENTS.join(', ')}): ${unsupported.join('; ')}`);
  const next: Loaded = { regs, unsupported, mtime, started: false };
  loaded.set(ctx.id, next);
  return next;
}

export function forgetSession(id: string): void {
  loaded.delete(id);
}

/** Does any enabled extension contribute a mod? (the adapters only hook in then) */
export const hasMods = (): boolean => extensionMods().length > 0;

// ---------------------------------------------------------------------------
// the mods API ($) — the subset Arigami implements
// ---------------------------------------------------------------------------
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as any)) deepFreeze(v);
  }
  return o;
};

function storeFile(mod: string): string {
  return path.join(ARIGAMI_DIR, 'mods-store', `${mod.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}
function readStore(mod: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(storeFile(mod), 'utf8')); } catch { return {}; }
}
function writeStore(mod: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storeFile(mod)), { recursive: true });
  fs.writeFileSync(storeFile(mod), JSON.stringify(data));
}

function unavailable(where: string): never {
  throw new Error(`$.${where} is not available in Arigami's mods runtime (this engine has no native mods) — see server/mods.ts`);
}

/** Calls to a namespace or method we do not implement throw instead of returning undefined. */
const strict = <T extends object>(ns: string, impl: T): T =>
  new Proxy(impl, { get: (t: any, k) => (typeof k === 'symbol' || k in t ? t[k] : () => unavailable(`${ns}.${String(k)}`)) });

export function makeApi(ctx: SessionCtx, mod: ExtMod | { name: string; dir: string }): any {
  const inCwd = (p: string) => path.resolve(ctx.cwd, p);
  const api = {
    plugin: strict('plugin', { name: mod.name, root: mod.dir }),
    env: strict('env', {
      get: async (k: string) => ctx.env[k] ?? process.env[k],
      set: async (k: string, v: string) => { ctx.env[k] = String(v); },
    }),
    http: strict('http', {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const r = await fetch(url, { method: init.method || 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(30_000) });
        const text = await r.text();
        return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), text: text.slice(0, 4 * 1024 * 1024) };
      },
    }),
    fs: strict('fs', {
      read: async (p: string) => fs.readFileSync(inCwd(p), 'utf8'),
      write: async (p: string, data: string) => { fs.mkdirSync(path.dirname(inCwd(p)), { recursive: true }); fs.writeFileSync(inCwd(p), String(data)); },
      exists: async (p: string) => fs.existsSync(inCwd(p)),
      list: async (p: string) => fs.readdirSync(inCwd(p)),
      stat: async (p: string) => { const st = fs.statSync(inCwd(p)); return { size: st.size, isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs }; },
    }),
    process: strict('process', {
      run: (argv: string[], opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {}) =>
        new Promise((resolve) => {
          const p = spawn(argv[0], argv.slice(1), { cwd: opts.cwd ? inCwd(opts.cwd) : ctx.cwd, env: { ...process.env, ...ctx.env } });
          let stdout = '', stderr = '';
          const t = setTimeout(() => p.kill('SIGKILL'), Math.min(opts.timeoutMs || 30_000, 600_000));
          p.stdout.on('data', (d) => (stdout += d));
          p.stderr.on('data', (d) => (stderr += d));
          if (opts.stdin) p.stdin.end(opts.stdin); else p.stdin.end();
          p.on('close', (code) => { clearTimeout(t); resolve({ exitCode: code ?? -1, stdout, stderr }); });
          p.on('error', (e) => { clearTimeout(t); resolve({ exitCode: -1, stdout, stderr: stderr + e.message }); });
        }),
    }),
    store: strict('store', {
      get: async (k: string) => readStore(mod.name)[k],
      set: async (k: string, v: unknown) => { const d = readStore(mod.name); d[k] = v; writeStore(mod.name, d); },
      delete: async (k: string) => { const d = readStore(mod.name); delete d[k]; writeStore(mod.name, d); },
      keys: async () => Object.keys(readStore(mod.name)),
    }),
    session: strict('session', {
      id: async () => ctx.id,
      cwd: async () => ctx.cwd,
      root: async () => ctx.cwd,
      surfaces: async () => ['arigami'],
    }),
    clock: strict('clock', {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    }),
    ui: strict('ui', {
      log: (text: string) => ctx.card(mod.name, String(text)),
      toast: (text: string) => ctx.card(mod.name, String(text)),
      notice: (text: string) => ctx.card(mod.name, String(text)),
      invalidate: () => {},
    }),
  };
  return new Proxy(api, { get: (t: any, k) => (typeof k === 'symbol' || k in t ? t[k] : strict(String(k), {})) });
}

// ---------------------------------------------------------------------------
// the middleware chain — Claude Code's semantics
// ---------------------------------------------------------------------------
function matches(m: Record<string, unknown> | null, e: any): boolean {
  if (!m) return true;
  return Object.entries(m).every(([k, want]) => {
    const got = e?.[k];
    if (want instanceof RegExp) return typeof got === 'string' && want.test(got);
    if (Array.isArray(want)) return want.includes(got);
    return got === want;
  });
}

const timeout = (ms: number, kind: string) =>
  new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${kind} after ${ms}ms`), { kind: 'timeout' })), ms);
    t.unref?.();
  });

/**
 * Run `event` through every matching hook, outermost first, ending in `terminal` (the engine's own behaviour).
 * A hook that throws or overruns its budget before calling next() is skipped (or answered by its .catch); one that
 * fails after next() keeps the result next() produced — exactly as Claude Code documents it.
 */
async function runChain(ctx: SessionCtx, regs: Registration[], event: string, e: any, terminal: (e: any) => Promise<any>): Promise<any> {
  const chain = regs.filter((r) => r.event === event && matches(r.matcher, e));
  const dispatch = async (i: number, ev: any): Promise<any> => {
    if (i >= chain.length) return terminal(ev);
    const r = chain[i];
    const $ = makeApi(ctx, { name: r.mod, dir: '' });
    const ac = new AbortController();
    let downstream: Promise<any> | null = null;
    let calledResolve: () => void = () => {};
    const called = new Promise<void>((res) => (calledResolve = res));
    const next = Object.assign(
      (e2: any) => {
        next.called = true;
        calledResolve();
        downstream = dispatch(i + 1, deepFreeze(e2 === undefined ? ev : e2));
        return downstream;
      },
      { called: false, signal: ac.signal, origin: { plugin: 'engine', tier: 'core' }, budget: { ms: HOOK_BUDGET_MS, remainingMs: HOOK_BUDGET_MS } }
    ) as Next;
    const run = Promise.resolve().then(() => r.hook($, ev, next));
    try {
      // the budget covers the hook's OWN time: it stops counting once next() was called
      let t: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(Object.assign(new Error(`no answer within ${HOOK_BUDGET_MS}ms`), { kind: 'timeout' })), HOOK_BUDGET_MS);
        void called.then(() => clearTimeout(t));
      });
      try {
        return await Promise.race([run, budget]);
      } finally {
        clearTimeout(t);
      }
    } catch (err: any) {
      const kind = err?.kind === 'timeout' ? 'timeout' : 'throw';
      ctx.card(r.mod, `${event} hook ${kind === 'timeout' ? 'timed out' : 'threw'}: ${err?.message || err}`);
      if (r.onError) {
        const handlerNext = Object.assign(
          (e2: any) => (next.called && downstream ? downstream : dispatch(i + 1, e2 === undefined ? ev : e2)),
          { called: next.called, error: { kind, message: String(err?.message || err) }, signal: ac.signal, origin: next.origin, budget: { ms: CATCH_BUDGET_MS, remainingMs: CATCH_BUDGET_MS } }
        ) as Next;
        try {
          return await Promise.race([Promise.resolve().then(() => r.onError!($, ev, handlerNext)), timeout(CATCH_BUDGET_MS, 'timeout')]);
        } catch {
          /* a failing handler: as if there were none */
        }
      }
      return next.called && downstream ? downstream : dispatch(i + 1, ev);
    }
  };
  return dispatch(0, deepFreeze(e));
}

async function ensureStarted(ctx: SessionCtx, l: Loaded): Promise<void> {
  if (l.started) return;
  l.started = true;
  await runChain(ctx, l.regs, 'session.start', { sessionId: ctx.id }, async () => ({})).catch(() => {});
}

// ---------------------------------------------------------------------------
// tool.call across PreToolUse → PostToolUse
// ---------------------------------------------------------------------------
interface Pending { resolveResult: (r: any) => void; final: Promise<any>; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();

export type PreVerdict = { allow: true; input?: Record<string, unknown> } | { allow: false; reason: string };
export type PostVerdict = { pass: true } | { replace: string } | { block: string };

const resultText = (r: any): string => (typeof r === 'string' ? r : r == null ? '' : JSON.stringify(r));

/** PreToolUse: run tool.call up to next(); returns once the chain either reached the engine or answered itself. */
export async function toolPre(ctx: SessionCtx, call: { tool: string; input: Record<string, unknown>; id: string }): Promise<PreVerdict> {
  const l = await loadFor(ctx);
  if (!l.regs.some((r) => r.event === 'tool.call')) return { allow: true };
  await ensureStarted(ctx, l);
  let settlePre: (v: PreVerdict) => void = () => {};
  const pre = new Promise<PreVerdict>((res) => (settlePre = res));
  let reachedEngine = false;
  let resolveResult: (r: any) => void = () => {};
  const resultP = new Promise<any>((res) => (resolveResult = res));
  const e = { tool: call.tool, ...call.input };
  const final = runChain(ctx, l.regs, 'tool.call', e, async (e2) => {
    reachedEngine = true;
    const { tool: _t, ...input } = e2 || {};
    settlePre(JSON.stringify(input) === JSON.stringify(call.input) ? { allow: true } : { allow: true, input });
    return resultP; // suspended until PostToolUse delivers the tool's result
  }).then(
    (out) => {
      if (!reachedEngine) {
        // answered without the engine: { deny } refuses; { result } cannot be injected into codex → refuse with it as the reason
        settlePre({ allow: false, reason: out?.deny ? String(out.deny) : out?.result !== undefined ? resultText(out.result) : 'refused by a mod' });
      }
      return out;
    },
    (err) => {
      settlePre({ allow: false, reason: `a mod failed: ${(err as Error)?.message || err}` });
      throw err;
    }
  );
  const timer = setTimeout(() => { resolveResult({ deny: 'the tool result never arrived' }); pending.delete(call.id); }, TOOL_RESULT_WAIT_MS);
  timer.unref?.();
  pending.set(call.id, { resolveResult, final: final.catch(() => ({ deny: 'a mod failed after the tool ran' })), timer });
  const v = await pre;
  if (!reachedEngine) { clearTimeout(timer); pending.delete(call.id); }
  return v;
}

/** PostToolUse: hand the tool's result to the suspended chain and turn what the mods returned into the hook answer. */
export async function toolPost(ctx: SessionCtx, call: { id: string; output: unknown }): Promise<PostVerdict> {
  const p = pending.get(call.id);
  if (!p) return { pass: true };
  pending.delete(call.id);
  clearTimeout(p.timer);
  const original = resultText(call.output);
  p.resolveResult({ result: call.output });
  const out = await Promise.race([p.final, timeout(AFTER_NEXT_WAIT_MS, 'timeout').catch(() => ({ deny: 'mods did not decide in time after the tool ran' }))]);
  if (out?.deny) return { block: String(out.deny) };
  if (out && out.result !== undefined && resultText(out.result) !== original) return { replace: resultText(out.result) };
  return { pass: true };
}

// ---------------------------------------------------------------------------
// prompt.submit — the host's own adapter (every engine without native mods)
// ---------------------------------------------------------------------------
export async function promptSubmit(ctx: SessionCtx, text: string): Promise<{ drop: string } | { text: string }> {
  const l = await loadFor(ctx);
  if (!l.regs.some((r) => r.event === 'prompt.submit')) return { text };
  await ensureStarted(ctx, l);
  let sent: any = null;
  const out = await runChain(ctx, l.regs, 'prompt.submit', { text, context: [] }, async (e2) => { sent = e2; return {}; });
  if (out?.drop && !sent) return { drop: String(out.drop) };
  const ev = sent || { text };
  const extra = Array.isArray(ev.context) && ev.context.length ? `\n\n${ev.context.join('\n')}` : '';
  return { text: String(ev.text ?? text) + extra };
}
