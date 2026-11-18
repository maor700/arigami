// The environment a RESTRICTED session is spawned with (docs/SECURITY.md § Restricted sessions). No imports on
// purpose: the spawn helpers (claude.js, codex.ts, lib/oneshot.ts, lib/desktops.ts) all use it, and an import of
// session-profile.ts from there would close a cycle through agent-policy.ts.
//
// A Full session inherits the host's whole environment, exactly as before (none of this runs for it). A restricted
// session gets an ALLOWLIST: only the variables below survive, whatever else the host process carries (GH_TOKEN,
// SLACK_*, cloud keys…). Anything not named here is dropped — a new secret the host gains later stays out by default.

/** Plain process plumbing: where things are, how to print, which display. No credentials. */
export const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'HOSTNAME', 'TZ', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'PORT', 'EDITOR', 'VISUAL', 'PAGER',
  'BUN_INSTALL', 'NVM_DIR', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  // engine configuration (paths / switches, not keys)
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  // the session's own identity with the host — ARIGAMI_TOKEN is scoped to this one session (the auth gate)
  'ARIGAMI_SESSION_ID', 'ARIGAMI_HOST_ID', 'ARIGAMI_URL', 'ARIGAMI_PUBLIC_PATH', 'ARIGAMI_PUBLIC_URL', 'ARIGAMI_TOKEN', 'ARIGAMI_AGENT',
  'ARIGAMI_PROFILE', 'ARIGAMI_ENGINE', 'ARIGAMI_SKILLS', 'ARIGAMI_DOCS', 'ARIGAMI_USER_SKILLS', 'ARIGAMI_DIR', 'ARIGAMI_TERMINAL_CWD',
]);
/** Locale families (LC_ALL, LC_CTYPE…). */
const ENV_ALLOW_PREFIX = ['LC_'];
/**
 * The engine's own model credential — the one secret a restricted session still holds, because the CLI cannot call the
 * model without it. Removing it is the model-call proxy (extensions/gatekeeper/README.md), not this list.
 */
export const ENGINE_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
/** Proxy settings pass only without credentials in them (no user:pass@ in the URL). */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];

/** The spawn env of a restricted session: `env` reduced to the allowlist. Pure; never adds a variable. */
export function restrictedEnv<T extends Record<string, string | undefined>>(env: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ENV_ALLOW.has(k) || ENGINE_CREDENTIALS.includes(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
    else if (PROXY_VARS.includes(k) && !/:\/\/[^/]*@/.test(v)) out[k] = v;
  }
  return out;
}

/** The env a session is spawned with: unchanged for Full, the allowlist for a restricted one. */
export const spawnEnvFor = <T extends Record<string, string | undefined>>(s: { profile?: unknown } | null | undefined, env: T): T | Record<string, string> => (s?.profile ? restrictedEnv(env) : env);
