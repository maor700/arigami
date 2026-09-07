// The listener TYPE registry — one map instead of the if/else chain that used
// to be the only way to add a listener type.
//
// The scheduler in listeners.ts is unchanged and generic: watermarks, backoff,
// auth-fail counting, TTL, queue-until-idle delivery and coalescing serve every
// type for free. A provider only answers two questions — "what is the baseline
// when this is armed?" (register) and "what changed since the watermark?" (poll).
//
// The built-in types (github-pr, linear-issue, slack, whatsapp, sms, worker)
// keep their existing code paths in listeners.ts; they are described here only
// so GET /__api/listener-types can list them next to the extension ones (that
// endpoint is what the MCP `register_listener` enum is built from at startup).
//
// Provider code comes from an extension and runs IN-PROCESS with host
// privileges (the documented trust model), so every call the scheduler makes
// is wrapped in a deadline — see pollProvider().
import type { ListenerProvider, ListenerCtx, ListenerView, PollOutcome } from './lib/ext-types.js';

export type { ListenerProvider, ListenerCtx, ListenerView, PollOutcome };

export interface RegisteredProvider {
  provider: ListenerProvider;
  /** the extension that contributed it; absent for a core type */
  ext?: string;
}

/** How a type is described to callers (MCP enum, cockpit, `bin/host ext list`). */
export interface ListenerTypeInfo {
  type: string;
  label: string;
  schema: Record<string, unknown> | null;
  fireOn: string[];
  defaultIntervalSec?: number;
  ext?: string;
  builtin: boolean;
}

/** Types the core implements inside listeners.ts — listed, never dispatched here. */
export const BUILTIN_LISTENER_TYPES: ListenerTypeInfo[] = [
  {
    type: 'github-pr',
    label: 'GitHub pull request',
    schema: { type: 'object', properties: { url: { type: 'string' }, owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' } } },
    fireOn: ['new_review', 'approved', 'changes_requested', 'new_comment', 'ci_failed', 'ci_passed', 'conflicts'],
    builtin: true,
  },
  {
    type: 'linear-issue',
    label: 'Linear issue',
    schema: { type: 'object', required: ['issue_id'], properties: { issue_id: { type: 'string' } } },
    fireOn: ['new_comment', 'status_changed', 'assignee_changed'],
    builtin: true,
  },
  {
    type: 'slack',
    label: 'Slack channel or thread',
    schema: { type: 'object', properties: { channel_id: { type: 'string' }, thread_ts: { type: 'string' }, url: { type: 'string' } } },
    fireOn: ['new_message', 'mention', 'reply'],
    builtin: true,
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp messages',
    schema: { type: 'object', properties: { group_jid: { type: 'string' }, contacts: { type: 'array', items: { type: 'string' } }, db_path: { type: 'string' } } },
    fireOn: ['new_message'],
    builtin: true,
  },
  {
    type: 'sms',
    label: 'Inbound SMS',
    schema: { type: 'object', properties: { from_filter: { type: 'string' } } },
    fireOn: ['new_sms'],
    builtin: true,
  },
];

const BUILTIN_SET = new Set(BUILTIN_LISTENER_TYPES.map((t) => t.type).concat(['worker']));
const registry = new Map<string, RegisteredProvider>();

export const isBuiltinListenerType = (type: string): boolean => BUILTIN_SET.has(type);

/**
 * Register a provider for `type`. Re-registering the same type replaces it
 * (that is what a reload does); a core type can never be shadowed.
 */
export function register(provider: ListenerProvider, opts: { ext?: string } = {}): void {
  const type = String(provider?.type || '');
  if (!type) throw new Error('listener provider has no `type`');
  if (BUILTIN_SET.has(type)) throw new Error(`listener type "${type}" is a built-in type and cannot be replaced`);
  if (typeof provider.poll !== 'function') throw new Error(`listener provider "${type}" has no poll()`);
  if (typeof provider.register !== 'function') throw new Error(`listener provider "${type}" has no register()`);
  registry.set(type, { provider, ext: opts.ext });
}

/** Drop every provider contributed by one extension (used before it reloads). */
export function unregisterExt(ext: string): void {
  for (const [type, r] of [...registry]) if (r.ext === ext) registry.delete(type);
}

export const get = (type: string): RegisteredProvider | undefined => registry.get(type);
export const has = (type: string): boolean => registry.has(type);
export const size = (): number => registry.size;

/** Core types + every registered provider — the shape GET /__api/listener-types returns. */
export function listTypes(): ListenerTypeInfo[] {
  const out: ListenerTypeInfo[] = [...BUILTIN_LISTENER_TYPES];
  for (const [type, r] of registry) {
    out.push({
      type,
      label: safeLabel(r.provider, type),
      schema: (r.provider.schema as Record<string, unknown>) || null,
      fireOn: Array.isArray(r.provider.fireOn) ? r.provider.fireOn : [],
      defaultIntervalSec: r.provider.defaultIntervalSec,
      ext: r.ext,
      builtin: false,
    });
  }
  return out;
}

function safeLabel(p: ListenerProvider, type: string): string {
  try {
    const l = p.label?.({} as never);
    return typeof l === 'string' && l.trim() ? l : type;
  } catch {
    return type;
  }
}

/** The label for a concrete listener (falls back to the type when the provider throws). */
export function labelFor(type: string, args: unknown): string {
  const r = registry.get(type);
  if (!r) return type;
  try {
    const l = r.provider.label?.(args as never);
    return typeof l === 'string' && l.trim() ? l.slice(0, 200) : type;
  } catch {
    return type;
  }
}

// ---- argument validation ----------------------------------------------------
// Deliberately minimal (required keys + primitive types): a provider is trusted
// code, this is a typo guard for the human/agent that armed the listener, not a
// security boundary.
export function validateArgs(schema: unknown, args: Record<string, unknown>): string[] {
  const s = schema as any;
  if (!s || typeof s !== 'object') return [];
  const errors: string[] = [];
  const required: string[] = Array.isArray(s.required) ? s.required : [];
  for (const k of required) if (args[k] === undefined || args[k] === null) errors.push(`missing required argument "${k}"`);
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
  for (const [k, def] of Object.entries(props as Record<string, any>)) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    const want = def?.type;
    if (!want) continue;
    const got = Array.isArray(v) ? 'array' : typeof v;
    const ok =
      want === 'array' ? got === 'array'
      : want === 'integer' ? got === 'number' && Number.isInteger(v)
      : want === 'object' ? got === 'object' && !Array.isArray(v)
      : got === want;
    if (!ok) errors.push(`argument "${k}" must be ${want} (got ${got})`);
  }
  return errors;
}

// ---- deadlines --------------------------------------------------------------
/** The scheduler's per-poll deadline. A provider that blocks longer is a transient failure. */
export const POLL_TIMEOUT_MS = 20_000;
/** Registration is a baseline fetch — a little more room than a poll. */
export const REGISTER_TIMEOUT_MS = 30_000;

export class ProviderTimeout extends Error {
  constructor(type: string, ms: number) {
    super(`listener provider "${type}" exceeded ${Math.round(ms / 1000)}s`);
    this.name = 'ProviderTimeout';
  }
}

/**
 * Run one provider call under a deadline. The provider also gets the signal in
 * its ctx, so a well-behaved `fetch` aborts on its own; the race is what
 * protects the (serial) tick from one that isn't.
 */
export async function withDeadline<T>(type: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await Promise.race([
      fn(ac.signal),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new ProviderTimeout(type, ms)), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * poll() for a registered type, already wrapped in the deadline and normalised:
 * a throw / timeout becomes a `transient` outcome so the existing backoff owns
 * the retry. Returns null when no provider is registered for the type.
 */
export async function pollProvider(
  type: string,
  makeCtx: (signal: AbortSignal) => ListenerCtx,
  view: ListenerView
): Promise<PollOutcome | null> {
  const r = registry.get(type);
  if (!r) return null;
  try {
    const outcome = await withDeadline(type, POLL_TIMEOUT_MS, (signal) => Promise.resolve(r.provider.poll(makeCtx(signal), view)));
    return normalize(type, outcome);
  } catch (e) {
    return { kind: 'transient', error: (e as Error)?.message || String(e) };
  }
}

/** onWebhook() for a registered type, same normalisation. Null when unsupported. */
export async function webhookProvider(
  type: string,
  makeCtx: (signal: AbortSignal) => ListenerCtx,
  view: ListenerView,
  event: { kind: string; customId?: string; body: unknown; receivedAt?: string }
): Promise<PollOutcome | null> {
  const r = registry.get(type);
  if (!r || typeof r.provider.onWebhook !== 'function') return null;
  try {
    const outcome = await withDeadline(type, POLL_TIMEOUT_MS, (signal) => Promise.resolve(r.provider.onWebhook!(makeCtx(signal), view, event)));
    return normalize(type, outcome);
  } catch (e) {
    return { kind: 'transient', error: (e as Error)?.message || String(e) };
  }
}

/** A provider can return anything; the scheduler may only see the four shapes. */
function normalize(type: string, o: unknown): PollOutcome {
  const out = o as any;
  if (!out || typeof out !== 'object') return { kind: 'transient', error: `provider "${type}" returned ${typeof out}` };
  if (out.kind === 'transient' || out.kind === 'auth' || out.kind === 'gone')
    return { kind: out.kind, error: String(out.error || out.kind) };
  if (out.kind !== 'ok') return { kind: 'transient', error: `provider "${type}" returned an unknown outcome kind: ${String(out.kind)}` };
  return {
    kind: 'ok',
    shouldFire: !!out.shouldFire,
    summary: typeof out.summary === 'string' ? out.summary : '',
    nextWatermark: out.nextWatermark === undefined ? {} : out.nextWatermark,
    terminal: out.terminal ?? null,
  };
}
