// Read-only git access for the org's profile repo, without the user having signed in to anything.
//
// A tenant pod boots with no GitHub login, so a private bundle (and the extensions inside it) cannot be cloned
// the usual way. The control-plane hands every tenant ONE read-only token (a deploy token / fine-grained PAT) as
// `ARIGAMI_GIT_TOKEN`; this module turns it into git config via the environment, for https URLs on an allow-listed
// host only. The token never goes into a URL (so it cannot reach a log, `.git/config` or the process list) and is
// never sent to a host that is not listed.
//
//   ARIGAMI_GIT_TOKEN        the token (unset ⇒ nothing changes, git behaves as before)
//   ARIGAMI_GIT_TOKEN_HOSTS  comma-separated hosts it may be sent to (default: github.com)
//   ARIGAMI_GIT_TOKEN_USER   the basic-auth user (default: x-access-token — what GitHub expects for tokens)

/** Hosts the token may be sent to. */
export function gitTokenHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.ARIGAMI_GIT_TOKEN_HOSTS || 'github.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Extra environment for a `git` run against `url`: empty unless a token is configured AND `url` is an https URL on
 * an allow-listed host. Uses git's GIT_CONFIG_COUNT/KEY/VALUE (git ≥ 2.31), scoped to that host's URL prefix.
 */
export function gitAuthEnv(url: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = env.ARIGAMI_GIT_TOKEN;
  if (!token) return {};
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return {}; // scp-style (git@host:…), a path, anything that is not a plain https URL
  }
  if (u.protocol !== 'https:' || !gitTokenHosts(env).includes(u.hostname.toLowerCase())) return {};
  const user = env.ARIGAMI_GIT_TOKEN_USER || 'x-access-token';
  const basic = Buffer.from(`${user}:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${u.protocol}//${u.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** `process.env` plus the auth for `url` — what to pass as `env:` to a git spawn that talks to `url`. */
export function gitEnvFor(url: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', ...gitAuthEnv(url) };
}
