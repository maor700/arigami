// Client mirror of server/lib/providers.ts — who issues an account and which
// engine consumes it. The server's `GET /__api/accounts/providers` is the
// source of truth for the add-account chooser (a new provider shows up there
// without a web change); this table is the fallback for old hosts and the
// place the badge/type labels live. Product names are not translated.
import { normalizeEngine } from './engines.js';

export const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    engine: 'claude',
    localType: 'keychain',
    methods: [{ id: 'browser', type: 'oauth-token' }, { id: 'paste', type: 'oauth-token' }],
    pasteHint: 'sk-ant-oat01-…',
    pastePattern: '^sk-ant-',
    // badge colour: a dot on the card, never the only signal (the label is text)
    dot: '#d97757',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    engine: 'codex',
    localType: 'codex-home',
    methods: [{ id: 'browser', type: 'chatgpt' }, { id: 'paste', type: 'api-key' }],
    pasteHint: 'sk-…',
    pastePattern: '^sk-',
    dot: '#10a37f',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = 'claude';

/** Unknown / legacy (pre-provider) values mean claude — same rule as the server. */
export function normalizeProvider(v) {
  return PROVIDERS[v] ? v : DEFAULT_PROVIDER;
}

/** The provider whose accounts a session on `engine` runs on. */
export function providerForEngine(engine) {
  const e = normalizeEngine(engine);
  return PROVIDER_IDS.find((p) => PROVIDERS[p].engine === e) || DEFAULT_PROVIDER;
}

export function providerOf(account) {
  return normalizeProvider(account?.provider);
}

/** Product name for the card badge / headings. */
export function providerLabel(provider) {
  return PROVIDERS[normalizeProvider(provider)].label;
}

// Locale keys for every account.type, by provider — the pill next to the label.
export const TYPE_LABEL_KEYS = {
  keychain: 'launcher.account.typeKeychain',
  'oauth-token': 'launcher.account.typeToken',
  'codex-home': 'launcher.account.typeCodexHome',
  chatgpt: 'launcher.account.typeChatgpt',
  'api-key': 'launcher.account.typeApiKey',
};

/** Merge the server catalog (authoritative) over the local table, keeping local-only fields (dot). */
export function mergeCatalog(serverProviders) {
  const out = { ...PROVIDERS };
  for (const p of serverProviders || []) {
    if (!p?.id) continue;
    out[p.id] = { ...(out[p.id] || { dot: '#888' }), ...p };
  }
  return out;
}

/**
 * The usage object rebuilt from the compact `lastUsage` snapshot the accounts
 * list carries (what the card shows before the first live broadcast). A window
 * the snapshot never had (codex free plan: no secondary) stays absent — a
 * `{pct: null}` window would draw as "100% left".
 */
export function snapshotUsage(account) {
  const lu = account?.lastUsage;
  if (!lu || lu.reason) return lu?.reason ? { available: false, reason: lu.reason } : null;
  const win = (pct, mins) => (pct == null ? null : { pct, ...(mins ? { windowMins: mins } : {}) });
  return { available: true, session: win(lu.session, lu.sessionMins), week: win(lu.week, lu.weekMins) };
}

/**
 * A usage window's label. Claude's are fixed (5h session, 7-day week); codex
 * reports each window's LENGTH (minutes), and a free plan has one 30-day
 * window where a paid one has 5h + weekly — so label by length when known.
 */
export function windowLabel(t, provider, which, win) {
  const mins = win?.windowMins;
  if (normalizeProvider(provider) === 'claude') {
    return which === 'session' ? t('launcher.account.usageSession') : t('launcher.account.usageWeek');
  }
  if (!mins) return t('launcher.account.usageWindow');
  if (mins <= 60 * 12) return t('launcher.account.windowHours', { n: Math.round(mins / 60) });
  if (mins <= 60 * 24 * 8) return t('launcher.account.windowDays', { n: Math.round(mins / 1440) });
  return t('launcher.account.windowDays', { n: Math.round(mins / 1440) });
}
