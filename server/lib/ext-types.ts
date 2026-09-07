// The public extension contract, as the SERVER sees it.
//
// One definition, two consumers: extensions import '@arigami/sdk' (resolved
// through the node_modules symlink the loader maintains), the host imports this
// file. Re-exporting instead of copying is deliberate — if the two ever drift,
// an extension that typechecks would still fail at runtime.
export type {
  EXT_API_VERSION as EXT_API_VERSION_T,
  JsonSchema,
  Manifest,
  ManifestTab,
  ManifestListener,
  ManifestTool,
  ManifestToolMcp,
  ManifestToolModule,
  ManifestDoc,
  ManifestHooks,
  ManifestWebhook,
  ManifestDaemon,
  ListenerProvider,
  ListenerCtx,
  ListenerView,
  PollOutcome,
  WebhookEvent,
  DomainEvent,
  Hooks,
  HookCtx,
  GateResult,
  NotifyPayload,
  NotifyChannel,
  ExecResult,
  ToolDef,
  ToolCtx,
  TabContext,
  ArigamiSdk,
} from '../../sdk/index.js';
