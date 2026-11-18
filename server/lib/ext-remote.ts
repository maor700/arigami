// Extensions whose tool server runs OUTSIDE the host process — in a sidecar container next to it (the Helm chart's
// `isolation.gatekeeper`), served over HTTP by mcp/ext-serve.ts.
//
//   ARIGAMI_EXT_REMOTE="gatekeeper=<base url of the sidecar>"     (comma-separated name=url pairs; the chart sets the loopback port)
//
// Unset (the default, and every standalone install): nothing changes — module tools run as a host child over stdio.
// Set: the MCP gateway and the tab path (callExtTool) talk to `<url>/shared` and `<url>/host` instead of spawning
// anything, so whatever the remote process holds (bot credentials) never exists in the host's container.
// No imports on purpose: extensions.ts and lib/mcp-gateway.ts both use it.

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** name → base URL, from the env value. Malformed entries are ignored (logged once by the caller if it cares). */
export function parseExtRemote(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(raw || '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const url = part.slice(i + 1).trim().replace(/\/+$/, '');
    if (!NAME_RE.test(name) || !/^https?:\/\/[^\s/]+$/.test(url)) continue;
    out.set(name, url);
  }
  return out;
}

/** The remote base URL of one extension, or null when it runs in-process / as a child as usual. */
export function extRemoteUrl(name: string, env: Record<string, string | undefined> = process.env): string | null {
  return parseExtRemote(env.ARIGAMI_EXT_REMOTE).get(name) ?? null;
}

/** The two endpoints a remote extension serves: sessions through the gateway, and host calls (an owner's tab). */
export const remoteEndpoint = (base: string, kind: 'shared' | 'host'): URL => new URL(`${base}/${kind}`);
