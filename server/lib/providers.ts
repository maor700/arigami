// Account PROVIDERS — who issues the credential a session runs on.
//
// An account (server/accounts.js) used to mean "a Claude login". With Codex as a
// second engine there are two kinds of login, and they are not interchangeable:
// a Claude token means nothing to `codex`, and a ChatGPT auth.json means nothing
// to `claude`. Every account therefore carries `provider`, and everything that
// picks an account for a session (state.ts, claude.js, codex.ts, usage.js, the
// cockpit) asks by provider. A provider is bound to exactly one ENGINE — the
// engine is what consumes the credential — but the two ids are kept separate
// on purpose: a provider could one day serve two engines (an OpenAI API key
// serving both `codex` and a hypothetical `openai-agents`), and an engine could
// accept two providers.
//
// Adding a provider = one entry here + an auth module that knows how to mint,
// validate and read usage for it (see server/codex-account.ts for the shape),
// + the client mirror in web/src/lib/providers.js. Nothing in accounts.js or
// the REST routes needs to learn the new name.

import type { EngineId } from './engine-driver.js';

export type ProviderId = 'claude' | 'codex';

export interface ProviderAddMethod {
  /** 'browser' = an interactive sign-in the host drives; 'paste' = a secret the human pastes */
  id: 'browser' | 'paste';
  /** which `account.type` this method produces */
  type: string;
}

export interface AccountProvider {
  id: ProviderId;
  /** product name — used verbatim on the card badge in both languages */
  label: string;
  /** the engine that consumes this provider's credentials */
  engine: EngineId;
  /** `account.type` of the machine's own local login (read live, never copied; not removable) */
  localType: string;
  /** every `account.type` this provider issues */
  types: string[];
  methods: ProviderAddMethod[];
  /** placeholder shown in the paste box */
  pasteHint: string;
  /** prefix regex a pasted secret must match (a coarse mis-paste guard, not validation) */
  pastePattern: string;
}

export const PROVIDERS: Record<ProviderId, AccountProvider> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    engine: 'claude',
    localType: 'keychain',
    types: ['keychain', 'oauth-token'],
    methods: [
      { id: 'browser', type: 'oauth-token' }, // PKCE in the browser — server/oauth-login.js
      { id: 'paste', type: 'oauth-token' }, // `claude setup-token` output
    ],
    pasteHint: 'sk-ant-oat01-…',
    pastePattern: '^sk-ant-',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    engine: 'codex',
    localType: 'codex-home',
    types: ['codex-home', 'chatgpt', 'api-key'],
    methods: [
      { id: 'browser', type: 'chatgpt' }, // `codex login --device-auth` — server/codex-account.ts
      { id: 'paste', type: 'api-key' }, // an OpenAI API key (`codex login --with-api-key`)
    ],
    pasteHint: 'sk-…',
    pastePattern: '^sk-',
  },
};

export const DEFAULT_PROVIDER: ProviderId = 'claude';
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/** Unknown / legacy (pre-provider) values mean claude — every account written before this field existed is one. */
export function normalizeProvider(v: unknown): ProviderId {
  return isProviderId(v) ? v : DEFAULT_PROVIDER;
}

/** The provider whose accounts a session on `engine` runs on. */
export function providerForEngine(engine: unknown): ProviderId {
  for (const p of PROVIDER_IDS) if (PROVIDERS[p].engine === engine) return p;
  return DEFAULT_PROVIDER;
}

/** The public, secret-free description the cockpit renders the "add account" chooser from. */
export function providerCatalog(): AccountProvider[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}
