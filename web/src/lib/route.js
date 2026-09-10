// URL routing (hash-based) — pure functions, no React, so they are unit-testable.
//
// Each main view is reflected in window.location.hash so pages are deep-linkable
// and survive a refresh. parseHash → the view state; routeFromState → the hash.
// The two are inverses so syncing them can't drift.
//
// BUGS1/B11: the host hands out `/__host/?session=<id>` (create_session's url,
// pushes, WhatsApp shares, report_to_master). That QUERY form must land on the
// same place as `#/session/<id>` — parseLocation() reads both. The hash wins
// when both are present (it is the SPA's own, more specific state); the query
// is only consulted when the hash is empty/bare.

export const SETTINGS_CATEGORIES = ['appearance', 'voice', 'connections', 'automation', 'host', 'extensions'];

export function parseHash(hash) {
  const h = (hash || '').replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const seg = h.split('/');
  switch (seg[0]) {
    // SET: #/settings/<category>[/<section>]; the old standalone pages map onto
    // Settings → Connections so shared links keep working.
    case 'settings': return { view: 'settings', cat: SETTINGS_CATEGORIES.includes(seg[1]) ? seg[1] : 'appearance', section: seg[2] || '' };
    case 'accounts': return { view: 'settings', cat: 'connections', section: 'claude', add: seg[1] === 'add' };
    case 'integrations': return { view: 'settings', cat: 'connections', section: 'integrations' };
    case 'skills': return { view: 'skills' };
    case 'brain': return { view: 'brain' };
    // UX1: #/agents/<slug>[/<tab>] — the agent surface is deep-linkable per tab
    // (a receipt's "open home" lands straight on the home ("בית") tab).
    case 'agents': return seg[1] ? { view: 'agent', slug: decodeURIComponent(seg[1]), tab: seg[2] ? decodeURIComponent(seg[2]) : '' } : { view: 'home' };
    case 'setup': return { view: 'setup' };
    case 'wizard': return { view: 'home', wizard: true };
    case 'new':
    case 'launcher': return { view: 'launcher', mode: ['ticket', 'empty', 'trigger'].includes(seg[1]) ? seg[1] : 'ticket' };
    case 'ticket': return seg[1] ? { view: 'ticket', id: decodeURIComponent(seg[1]) } : { view: 'home' };
    case 'session': return seg[1] ? { view: 'session', id: decodeURIComponent(seg[1]) } : { view: 'home' };
    default: return { view: 'home' };
  }
}

/** The session id carried by the `?session=<id>` query form (host links), or ''. */
export function sessionFromSearch(search) {
  try {
    return new URLSearchParams(search || '').get('session') || '';
  } catch {
    return '';
  }
}

/**
 * Route for a whole Location ({hash, search}). `#/…` is authoritative; a bare
 * hash (`''`, `#`, `#/`) falls back to `?session=<id>`. The result carries
 * `fromQuery:true` in that case so the first URL sync can rewrite the address
 * to the canonical hash form (and drop the stale query).
 */
export function parseLocation(loc) {
  const hash = loc?.hash || '';
  const bare = !hash.replace(/^#/, '').replace(/^\/+/, '');
  if (bare) {
    const id = sessionFromSearch(loc?.search);
    if (id) return { view: 'session', id, fromQuery: true };
  }
  return parseHash(hash);
}

export function routeFromState(s) {
  if (s.settingsOpen) return `#/settings/${s.settingsCat || 'appearance'}${s.settingsSection ? `/${s.settingsSection}` : ''}`;
  if (s.skillsOpen) return '#/skills';
  if (s.brainOpen) return '#/brain';
  if (s.agentOpen) return `#/agents/${encodeURIComponent(s.agentOpen)}${s.agentTab && s.agentTab !== 'home' ? `/${encodeURIComponent(s.agentTab)}` : ''}`;
  if (s.setupOpen) return '#/setup';
  if (s.launcher) return s.launcher.mode && s.launcher.mode !== 'ticket' ? `#/new/${s.launcher.mode}` : '#/new';
  if (s.previewTicket) return `#/ticket/${encodeURIComponent(s.previewTicket)}`;
  if (s.selectedId) return `#/session/${encodeURIComponent(s.selectedId)}`;
  return '#/';
}
