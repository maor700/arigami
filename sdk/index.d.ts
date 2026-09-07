// @arigami/sdk — the PUBLIC contract for Arigami extensions (API v1).
//
// An extension is a directory under $ARIGAMI_DIR/user/extensions/<name>/ with a
// manifest.json and, optionally, listener.ts / hooks.ts / tools/ / docs/ / ui/.
// The host resolves this package through a symlink
// ($ARIGAMI_DIR/user/node_modules/@arigami/sdk → <repo>/sdk) that the loader
// maintains, so `import type { ... } from '@arigami/sdk'` works with no install.
//
// Everything in this file is frozen for apiVersion 1: a breaking change needs
// EXT_API_VERSION to go up. Anything in server/* is NOT public — extensions
// never import it.

/** The apiVersion an extension must declare (major must match the host's). */
export declare const EXT_API_VERSION: 1;

// ---------------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------------

/** A JSON-Schema-ish object; the host validates required keys and primitive types. */
export type JsonSchema = Record<string, any>;

export interface ManifestTab {
  /** unique within the extension; used in open_tab({type:'ext', tab}) */
  id: string;
  title: string;
  /** path inside the extension dir, must live under ui/ (e.g. "ui/index.html") */
  entry: string;
  icon?: string;
  /** where the cockpit offers it: "tab-bar" | "slash:/pick" (wave 2) */
  openFrom?: string[];
}

export interface ManifestListener {
  /** globally unique listener type (prefix with the extension name when in doubt) */
  type: string;
  /** module inside the extension dir, e.g. "listener.ts" */
  module: string;
  /** named export holding the ListenerProvider */
  export: string;
  schema?: JsonSchema;
  fireOn?: string[];
  defaultIntervalSec?: number;
  label?: string;
}

export interface ManifestToolMcp {
  kind: 'mcp';
  name: string;
  command: string;
  args?: string[];
  /** ${EXT_DIR} is expanded to the extension directory */
  env?: Record<string, string>;
}

export interface ManifestToolModule {
  kind: 'module';
  name: string;
  /** module inside the extension dir exporting `tools` (see ToolDef) */
  module: string;
  env?: Record<string, string>;
}

export type ManifestTool = ManifestToolMcp | ManifestToolModule;

export interface ManifestDoc {
  /** markdown file inside the extension dir, e.g. "docs/USAGE.md" */
  file: string;
  /** generated skill name → /arigami-ext:<skill> */
  skill: string;
  /** the "when to use" line Claude reads to decide — this is the trigger text */
  description: string;
}

export interface ManifestHooks {
  /** module inside the extension dir, e.g. "hooks.ts" */
  module: string;
  /** domain events the module subscribes to (see DomainEvent) */
  events?: string[];
  /** gates the module implements (currently only "merge.before") */
  gates?: string[];
}

export interface ManifestWebhook {
  /** custom webhook id suffix — the full id is `ext-<name>-<id>` */
  id: string;
  /** listener type whose provider.onWebhook receives the event */
  listener: string;
}

export interface ManifestDaemon {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Manifest {
  /** ^[a-z0-9][a-z0-9-]*$ — also the directory name */
  name: string;
  version: string;
  /** must be 1 for this SDK */
  apiVersion: number;
  title?: string;
  description?: string;
  tabs?: ManifestTab[];
  listeners?: ManifestListener[];
  tools?: ManifestTool[];
  docs?: ManifestDoc[];
  hooks?: ManifestHooks;
  webhooks?: ManifestWebhook[];
  /** e.g. "session:message", "session:tabs", "tools:featdb", "notify", "events:merge.*" */
  permissions?: string[];
  settings?: { schema?: Record<string, { type?: string; default?: unknown; title?: string; description?: string }> };
  /** parsed but NOT run in wave 1 */
  daemons?: ManifestDaemon[];
}

// ---------------------------------------------------------------------------
// listeners
// ---------------------------------------------------------------------------

/** What a provider gets on every call. Never holds host internals. */
export interface ListenerCtx {
  /** appends to $ARIGAMI_DIR/logs/ext-<name>.log and the per-listener ring buffer */
  log(msg: string): void;
  fetch: typeof fetch;
  /** extensions.json secrets[<ext>] — never logged, never in the user repo */
  secrets: Record<string, string>;
  /** extensions.json settings[<ext>] merged over the manifest defaults */
  settings: Record<string, unknown>;
  /** the host's deadline for this call (20s for poll) */
  signal: AbortSignal;
  extDir: string;
  apiVersion: number;
}

/** The listener row a provider is allowed to see (never the whole record). */
export interface ListenerView<Args = any, WM = any> {
  id: string;
  sessionId: string;
  type: string;
  params: Args;
  watermark: WM;
  fireOn: string[];
}

export type PollOutcome<WM = any> =
  | { kind: 'ok'; shouldFire: boolean; summary?: string; nextWatermark: WM; terminal?: string | null }
  | { kind: 'transient' | 'auth' | 'gone'; error: string };

export interface WebhookEvent {
  kind: string;
  customId?: string;
  body: unknown;
  receivedAt?: string;
}

export interface ListenerProvider<Args = any, WM = any> {
  /** globally unique; the value of `type` in register_listener */
  type: string;
  /** the label shown on the rail */
  label(args: Args): string;
  schema?: JsonSchema;
  fireOn?: string[];
  defaultIntervalSec?: number;
  /** baseline poll at registration — never fire on the past */
  register(ctx: ListenerCtx, args: Args): Promise<{ params: Args; watermark: WM; intervalSec?: number }>;
  poll(ctx: ListenerCtx, l: ListenerView<Args, WM>): Promise<PollOutcome<WM>>;
  /** push instead of poll, for a manifest `webhooks[]` entry */
  onWebhook?(ctx: ListenerCtx, l: ListenerView<Args, WM>, event: WebhookEvent): Promise<PollOutcome<WM>>;
  cancel?(ctx: ListenerCtx, l: ListenerView<Args, WM>): Promise<void>;
}

// ---------------------------------------------------------------------------
// hooks, gates, notification channels
// ---------------------------------------------------------------------------

/** Domain event names an extension may subscribe to (globs allowed: `merge.*`). */
export type DomainEvent =
  | 'session.created'
  | 'listener.fired'
  | 'review.approved'
  | 'merge.done'
  | 'merge.conflict'
  | 'action.answered'
  | 'setup.done'
  | 'incident'
  | 'webhook.received';

export interface NotifyPayload {
  title: string;
  body: string;
  tag?: string;
  sessionId?: string;
  url?: string;
  /** channel ids; omit for every registered channel + push */
  channels?: string[];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HookCtx {
  /** deliverToSession semantics: idle → now, busy → queued with auto-play */
  sendPrompt(sessionId: string, text: string): Promise<{ delivered: 'now' | 'queued' } | { error: string }>;
  notify(payload: NotifyPayload): Promise<void>;
  exec(cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  fetch: typeof fetch;
  log(msg: string): void;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  /** a chat card in the session's transcript (kind: 'ext-card') */
  appendCard(sessionId: string, card: Record<string, unknown>): void;
  /** "does the host I am running on have X?" — never assume */
  has(feature: string): boolean;
  apiVersion: number;
  extDir: string;
}

export type GateResult = { ok: true } | { ok: false; reason: string };

export interface Hooks {
  on?: Partial<Record<string, (ev: any, ctx: HookCtx) => Promise<void> | void>>;
  gates?: Partial<Record<'merge.before' | string, (ev: any, ctx: HookCtx) => Promise<GateResult> | GateResult>>;
}

/** hooks.ts may also `export const channels = { telegram: async (payload, ctx) => {} }`. */
export type NotifyChannel = (payload: NotifyPayload, ctx: HookCtx) => Promise<void> | void;

// ---------------------------------------------------------------------------
// module-kind tools (wrapped by mcp/ext-mcp.js)
// ---------------------------------------------------------------------------

export interface ToolCtx {
  extDir: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  fetch: typeof fetch;
  host: { api(method: string, path: string, body?: unknown): Promise<any> };
}

export interface ToolDef<Args = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(args: Args, ctx: ToolCtx): Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// identity helpers (runtime = index.js; they only give you the types)
// ---------------------------------------------------------------------------

export declare function defineListener<Args = any, WM = any>(p: ListenerProvider<Args, WM>): ListenerProvider<Args, WM>;
export declare function defineHooks(h: Hooks): Hooks;
export declare function defineTools(t: ToolDef[]): ToolDef[];
export declare function defineManifest(m: Manifest): Manifest;

// ---------------------------------------------------------------------------
// browser tab SDK — window.arigami, served by the host at /__ext-sdk.js
// ---------------------------------------------------------------------------

export interface TabContext {
  sessionId: string;
  tabId: string;
  extension: string;
  apiVersion: number;
  agent?: string | null;
  cwd?: string;
  settings: Record<string, unknown>;
  lang?: string;
  permissions: string[];
}

export interface ArigamiSdk {
  ready(): Promise<TabContext>;
  /**
   * mode 'auto' (default) = deliverToSession semantics: idle → now, busy →
   * queued with auto-play. 'now' writes mid-turn; 'queue' only queues.
   */
  sendPrompt(text: string, opts?: { mode?: 'auto' | 'now' | 'queue'; attachments?: unknown[] }): Promise<{ delivered: 'now' | 'queued' }>;
  runTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  setStatus(opts: { badge?: string; color?: string; title?: string }): Promise<void>;
  openArtifact(path: string, opts?: { title?: string }): Promise<void>;
  subscribe(events: string[], cb: (ev: any) => void): () => void;
  close(): void;
}
