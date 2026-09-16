// S2 — client-side mirror of the capability registry (server/capabilities.ts).
// The server's list is the source of truth (a `setup` event carries its own
// `manual`/`autoCapable`); this table only fills the gaps — old hosts without
// S1, and the wizard/Setup screens that address capabilities by id.
//
// Capability ids: identity · claude · codex · git · repo:<name> · whatsapp ·
// mcp:<service> · composio:<toolkit> · desktop · push · remote · telemetry
//
// M1 `provider`: where the connection actually lives — 'native-mcp' (the
// vendor's own remote MCP server, token on this host), 'composio' (brokered),
// 'local' (this machine). The server sends it per capability; this table is the
// fallback for old hosts and for ids the UI addresses directly.
export const FAMILIES = {
  identity: { manual: { kind: 'takeover' }, autoCapable: false, icon: 'user' },
  claude: { manual: { kind: 'oauth', flow: 'pkce', token: true }, autoCapable: true, playbook: 'connect-claude', icon: 'key' },
  codex: { manual: { kind: 'oauth', flow: 'codex', token: true }, autoCapable: true, playbook: 'connect-codex', icon: 'key' },
  git: { manual: { kind: 'oauth', flow: 'device', token: true }, autoCapable: true, playbook: 'connect-github', icon: 'code' },
  repo: { manual: { kind: 'repo' }, autoCapable: false, icon: 'code' },
  whatsapp: { manual: { kind: 'qr' }, autoCapable: false, icon: 'qr' },
  mcp: { manual: { kind: 'oauth', flow: 'mcp', token: false }, autoCapable: true, playbook: 'connect-mcp', icon: 'plug', provider: 'native-mcp' },
  composio: { manual: { kind: 'oauth', flow: 'redirect', token: true }, autoCapable: true, playbook: 'connect-composio', icon: 'plug', provider: 'composio' },
  desktop: { manual: { kind: 'toggle' }, autoCapable: false, icon: 'display' },
  push: { manual: { kind: 'toggle' }, autoCapable: false, icon: 'bell' },
  remote: { manual: { kind: 'toggle' }, autoCapable: true, playbook: 'connect-tailscale', icon: 'globe' },
  telemetry: { manual: { kind: 'toggle' }, autoCapable: false, icon: 'chart' },
};

// 'composio:gmail' → 'composio'; 'repo:app' → 'repo'; 'claude' → 'claude'.
export function capFamily(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  return i === -1 ? s : s.slice(0, i);
}
// 'composio:gmail' → 'gmail' (the toolkit / repo name), '' otherwise.
export function capArg(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  return i === -1 ? '' : s.slice(i + 1);
}

// {manual, autoCapable, playbook?} for an id, from the family table.
export function manualFor(id) {
  const f = FAMILIES[capFamily(id)] || { manual: { kind: 'token' }, autoCapable: false };
  return { manual: f.manual, autoCapable: f.autoCapable, playbook: f.playbook || null };
}

// Human title: the setup.cap.<family> string, with {name} for the argument part.
export function capTitle(t, id) {
  const fam = capFamily(id);
  const arg = capArg(id);
  if (!FAMILIES[fam]) return id;
  // 'composio' / 'repo' / 'mcp' without an argument (legacy hosts, Settings rows).
  if (!arg && (fam === 'composio' || fam === 'repo' || fam === 'mcp')) return t(`setup.cap.${fam}.bare`);
  return t(`setup.cap.${fam}`, { name: arg });
}

// The consent list for AUTO mode — exactly what the agent will do. Keys are
// per playbook so the text can be precise (domains, clicks, what is never typed).
export function consentKeys(id) {
  const pb = manualFor(id).playbook;
  const n = { 'connect-composio': 4, 'connect-claude': 4, 'connect-codex': 4, 'connect-github': 4, 'connect-tailscale': 4, 'connect-mcp': 4 }[pb] || 0;
  return Array.from({ length: n }, (_, i) => `setup.consent.${pb}.${i + 1}`);
}

export const AUTO_CAPABLE = Object.keys(FAMILIES).filter((k) => FAMILIES[k].autoCapable);

// M1: 'native-mcp' | 'composio' | 'local' for an id, when the server didn't say.
export const providerOf = (id) => FAMILIES[capFamily(id)]?.provider || 'local';
