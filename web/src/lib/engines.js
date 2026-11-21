// Which agent-engine CLI a new session is born on, and what the two pickers
// standing next to that choice are allowed to offer.
//
// `session.engine` ('claude' | 'codex' | 'gemini') is read at every spawn by pickEngine()
// (server/lib/engine-driver.ts). It is the FIRST of the launcher's four
// selects because it decides the contents of two of the others: the model list
// and the effort scale are engine-specific, not a shared vocabulary that
// happens to be spelled the same.
//
// Where each engine's model list comes from:
//   claude — fetched. server/models.js runs a `claude` CLI handshake and the
//            cockpit reads it through lib/models.js (revalidating cache).
//   codex  — fetched too, from the same GET /models: server/codex.ts
//            codexModels() asks `codex app-server` model/list under the ACTIVE
//            codex account (models_cache.json only while that call is in flight)
//            — the catalog is per login. lib/models.js hands the rows to
//            setCodexCatalog(); CODEX_MODELS below is only the fallback shown
//            until that first fetch lands.
//   gemini — families from the same GET /models (`agy models`, setGeminiCatalog()); GEMINI_MODELS is the fallback.
//            agy bakes the effort into the id (gemini-4-neon-high): model = the family, effort = the suffix.
//
// Why the effort scales are NOT shared (the thing not to "simplify"):
// `claude --effort` is a flag with one fixed ladder for every model. Codex has
// no such flag at all — reasoning depth is the `model_reasoning_effort` config
// key (`-c model_reasoning_effort=…`), and the ladder is a property of the
// MODEL: gpt-5.6-terra adds an `ultra` rung above `max`, gpt-5.5 stops at
// `xhigh` and has neither. Showing Claude's ladder for a Codex session would
// offer levels the model rejects and hide the one it has.
import { t } from './i18n.js';
import { EFFORT_OPTIONS } from './effort.js';

export const ENGINE_IDS = ['claude', 'codex', 'gemini'];
// Host default (cfg.defaultEngine from GET /__api/config, set by store.loadConfig); '' in the launcher/agent forms means this.
export let DEFAULT_ENGINE = 'claude';

/** Adopt the host's cfg.defaultEngine; unknown → claude. */
export function setDefaultEngine(engine) {
  DEFAULT_ENGINE = ENGINE_IDS.includes(engine) ? engine : 'claude';
}

/** A session's engine: '' / unknown / legacy-undefined all mean claude — same rule as pickEngine(). */
export function normalizeEngine(engine) {
  return ENGINE_IDS.includes(engine) ? engine : 'claude';
}

/** A spawn choice: '' / unknown = the host default. */
export function resolveEngine(engine) {
  return ENGINE_IDS.includes(engine) ? engine : DEFAULT_ENGINE;
}

// Product names, not translated strings — the same word in both languages.
// `label` is what UI copy calls the engine when it names the thing the human is
// talking to ("Codex is working…", "Reply to Codex…"); `term` is the CLI-ish
// lowercase form the terminal header wears next to the session name.
const ENGINE_NAMES = {
  claude: { label: 'Claude Code', term: 'claude-code', short: 'Claude' },
  codex: { label: 'Codex', term: 'codex', short: 'Codex' },
  gemini: { label: 'Gemini', term: 'gemini', short: 'Gemini' },
};

/** The one-word engine name for a rail row, or null when the session runs on the host default (nothing to say). */
export function engineBadge(engine) {
  const e = normalizeEngine(engine);
  return e === DEFAULT_ENGINE ? null : ENGINE_NAMES[e].short;
}

/**
 * How to NAME this session's engine in UI copy.
 *
 * The rule these two exist to enforce: a string that describes the ENGINE (who
 * is working, who wants the screen, whose capabilities these are) must follow
 * the session's engine; a string that describes ARIGAMI, or genuinely describes
 * the Claude Code CLI itself (its install, its keychain item, its subscription
 * usage), keeps saying Claude. Hence `{engine}` placeholders in the locales
 * rather than a search-and-replace.
 */
export function engineLabel(engine) {
  return ENGINE_NAMES[normalizeEngine(engine)].label;
}

// Host's cfg.codexTransport (GET /__api/config): 'app-server' has approvals + compaction, 'exec' has neither.
export let CODEX_TRANSPORT = 'app-server';

/** Adopt the host's cfg.codexTransport; anything but 'exec' is app-server. */
export function setCodexTransport(transport) {
  CODEX_TRANSPORT = transport === 'exec' ? 'exec' : 'app-server';
}

/** Does this engine have permission modes? claude and gemini: all four; codex app-server: bypass vs ask; codex exec: none (docs/ENGINES.md). */
export function hasPermissionModes(engine) {
  return permissionModesFor(engine).length > 0;
}

/** The permission modes this engine offers (values of the cockpit picker). */
export function permissionModesFor(engine) {
  const e = normalizeEngine(engine);
  if (e === 'claude' || e === 'gemini') return ['default', 'acceptEdits', 'plan', 'bypassPermissions']; // gemini: agy's own accept-edits / plan modes
  return CODEX_TRANSPORT === 'app-server' ? ['default', 'bypassPermissions'] : [];
}

/** Locale key for a mode whose meaning differs from claude's on this engine (`{engine}` placeholder for gemini); null = the option's own description. */
export function permDescKey(engine, mode) {
  const e = normalizeEngine(engine);
  if (e === 'codex') return mode === 'default' ? 'rail.permCodexAskDesc' : 'rail.permCodexBypassDesc';
  if (e === 'gemini' && mode === 'default') return 'rail.permEngineAskDesc'; // agy never asks about workspace file edits
  if (e === 'gemini' && mode === 'bypassPermissions') return 'rail.permEngineBypassDesc';
  return null;
}

/** Does a permission-mode change wait for the next turn instead of stopping the running one? (every engine but claude) */
export function permAppliesNextTurn(engine) {
  return normalizeEngine(engine) !== 'claude';
}

/** Can this engine compact its context (now and by threshold)? codex only on app-server (thread/compact/start); gemini through agy's own /compact. */
export function supportsCompaction(engine) {
  return normalizeEngine(engine) !== 'codex' || CODEX_TRANSPORT === 'app-server';
}

/** Is the session's CLI the `claude` one? Gates what only talks about it: /usage, the CLI-update badge, "refresh model list". */
export function isClaudeEngine(engine) {
  return normalizeEngine(engine) === 'claude';
}

/** Lowercase CLI-ish name for the terminal header. */
export function engineTermName(engine) {
  return ENGINE_NAMES[normalizeEngine(engine)].term;
}

// Labels are product names, not translated strings; the option list is a
// function (not a frozen const) so a language switch re-renders it.
export function engineOptions() {
  return [
    { value: 'claude', label: 'Claude', desc: t('launcher.options.engineClaudeDesc') },
    { value: 'codex', label: 'Codex', desc: t('launcher.options.engineCodexDesc') },
    { value: 'gemini', label: 'Gemini', desc: t('launcher.options.engineGeminiDesc') },
  ];
}

// `efforts` is that model's own `supported_reasoning_levels`, in the catalog's
// order (weakest → strongest); `defaultEffort` its `default_reasoning_level`,
// which is what Codex uses when the config key is absent. FALLBACK only — see
// codexCatalog().
export const CODEX_MODELS = [
  {
    value: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    desc: 'Balanced agentic coding model for everyday work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    desc: 'Fast and affordable agentic coding model.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    desc: 'Proven previous-generation model for coding and general work.',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
];

// The live catalog (server rows from GET /models, see lib/models.js), or null
// before the first fetch lands. Module state rather than a hook argument so
// every consumer — pickers, coerceSessionOptions, effort labels — sees the same
// list without threading it through; setCodexCatalog(null) restores the fallback.
let liveCodexModels = null;

/** Adopt the server's Codex catalog rows ({id, name, desc, efforts, defaultEffort}); null/empty = keep the fallback. */
export function setCodexCatalog(rows) {
  liveCodexModels =
    Array.isArray(rows) && rows.length
      ? rows
          .filter((r) => r && typeof r.id === 'string')
          .map((r) => ({
            value: r.id,
            label: r.name || r.id,
            desc: r.desc || '',
            efforts: Array.isArray(r.efforts) && r.efforts.length ? r.efforts : CODEX_COMMON_EFFORTS,
            defaultEffort: r.defaultEffort || null,
          }))
      : null;
  return liveCodexModels;
}

/** The Codex models the picker offers right now: the live catalog, else the fallback. */
export function codexCatalog() {
  return liveCodexModels || CODEX_MODELS;
}

// With no model pinned, Codex picks its own (config `model`, else the
// server-recommended one) — we can't know which, so offer only the rungs every
// listed model has. Anything above that would be a level the chosen model may
// reject.
const commonEfforts = (list) => list.reduce((acc, m) => acc.filter((e) => m.efforts.includes(e)), list[0].efforts);
export const CODEX_COMMON_EFFORTS = commonEfforts(CODEX_MODELS);
export function codexCommonEfforts() {
  return commonEfforts(codexCatalog());
}

// Gemini families (FALLBACK — see geminiCatalog()); unpinned, agy runs Neon at High.
export const GEMINI_DEFAULT_MODEL = 'gemini-4-neon';
export const GEMINI_DEFAULT_EFFORT = 'high';
export const GEMINI_MODELS = [
  { value: 'gemini-4-neon', label: 'Gemini 4 Neon', desc: '', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { value: 'gemini-4-argon', label: 'Gemini 4 Argon', desc: '', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { value: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', desc: '', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', desc: '', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
];

let liveGeminiModels = null;

/** Adopt the server's Gemini families ({id, name, efforts, defaultEffort}); null/empty = keep the fallback. */
export function setGeminiCatalog(rows) {
  liveGeminiModels =
    Array.isArray(rows) && rows.length
      ? rows
          .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.efforts) && r.efforts.length)
          .map((r) => ({ value: r.id, label: r.name || r.id, desc: r.desc || '', efforts: r.efforts, defaultEffort: r.defaultEffort || null }))
      : null;
  if (liveGeminiModels && !liveGeminiModels.length) liveGeminiModels = null;
  return liveGeminiModels;
}

/** The Gemini families the picker offers right now: the live catalog, else the fallback. */
export function geminiCatalog() {
  return liveGeminiModels || GEMINI_MODELS;
}

/** The catalog of an engine that has one in this module (codex, gemini); [] for claude (its list is fetched). */
export function catalogFor(engine) {
  const e = normalizeEngine(engine);
  return e === 'codex' ? codexCatalog() : e === 'gemini' ? geminiCatalog() : [];
}

/** The catalog entry behind a model value on any engine, or null. */
export function catalogModel(model, engine) {
  const lists = engine ? [catalogFor(engine)] : [codexCatalog(), geminiCatalog()];
  // agy reports the running model with its effort baked in (gemini-4-neon-high) — that is the family's row.
  const family = String(model || '').replace(/-(low|medium|high|xhigh|max)$/, '');
  for (const l of lists) {
    const hit = l.find((m) => m.value === model) || (l === geminiCatalog() ? l.find((m) => m.value === family) : null);
    if (hit) return hit;
  }
  return null;
}

const EFFORT_KEY = {
  minimal: 'rail.effortMinimal',
  low: 'rail.effortLow',
  medium: 'rail.effortMedium',
  high: 'rail.effortHigh',
  xhigh: 'rail.effortXhigh',
  max: 'rail.effortMax',
  ultra: 'rail.effortUltra',
};

/**
 * The model `<select>`'s options for this engine. `claudeModels` is the live
 * list from useModels() — passed in rather than imported so this module stays
 * pure and testable (the one GET /models carries both engines' catalogs).
 */
export function modelOptionsFor(engine, claudeModels) {
  const e = normalizeEngine(engine);
  if (e === 'gemini') {
    const def = geminiCatalog().find((m) => m.value === GEMINI_DEFAULT_MODEL) || geminiCatalog()[0];
    return [
      { value: 'default', label: t('rail.effortDefault'), desc: def.label },
      ...geminiCatalog().map(({ value, label, desc }) => ({ value, label, desc })),
    ];
  }
  if (e !== 'codex') return claudeModels || [];
  return [
    { value: 'default', label: t('rail.effortDefault'), desc: t('launcher.options.codexModelDefaultDesc') },
    ...codexCatalog().map(({ value, label, desc }) => ({ value, label, desc })),
  ];
}

/** The catalog entry for a Codex model value, or null (incl. 'default'/''). */
export function codexModel(model) {
  return codexCatalog().find((m) => m.value === model) || null;
}

/**
 * The effort `<select>`'s options for this engine + currently-picked model.
 * Claude ignores `model` (one ladder for all); Codex reads the model's own.
 * The leading 'default' entry means "send no override" in both engines — for
 * claude, omit `--effort`; for codex, omit `model_reasoning_effort` and let the
 * model's `default_reasoning_level` stand.
 */
export function effortOptionsFor(engine, model) {
  const e = normalizeEngine(engine);
  if (e === 'claude') return EFFORT_OPTIONS;
  let levels;
  if (e === 'gemini') {
    // No model pinned = the default family, whose ladder is known (unlike codex's).
    const g = catalogModel(model, 'gemini') || catalogModel(GEMINI_DEFAULT_MODEL, 'gemini') || geminiCatalog()[0];
    levels = g.efforts;
  } else {
    const m = codexModel(model);
    levels = m ? m.efforts : codexCommonEfforts();
  }
  return [
    { value: 'default', label: t('rail.effortDefault') },
    ...levels.map((e) => ({ value: e, label: EFFORT_KEY[e] ? t(EFFORT_KEY[e]) : e })), // a rung with no label yet shows as-is
  ];
}

/** Human label for a stored effort value under this engine/model. */
export function effortLabelFor(engine, model, value) {
  const v = value || 'default';
  return effortOptionsFor(engine, model).find((o) => o.value === v)?.label || v;
}

/**
 * Clamp a `{engine, skill, model, effort}` object to what the engine actually
 * offers. Switching Claude→Codex with `model: 'sonnet'` must not POST a Claude
 * alias to a Codex session — and an effort rung the new model lacks (`ultra`
 * on gpt-5.5) must not survive the model switch either. Skill is engine-
 * agnostic and never touched.
 *
 * `claudeModels` is optional: without it a Claude model value is left alone
 * (the list may not have loaded yet, and dropping a valid pick because of a
 * pending fetch would be worse than keeping it).
 */
export function coerceSessionOptions(options, claudeModels) {
  const engine = resolveEngine(options?.engine);
  const out = { ...options, engine: engine === DEFAULT_ENGINE ? '' : engine };
  const known = modelOptionsFor(engine, claudeModels);
  if (out.model) {
    const listed = known.some((o) => o.value === out.model);
    // Claude with an unloaded list → keep. Codex and Gemini always have a list
    // (live or fallback), so an unlisted value there is genuinely wrong.
    if (!listed && (engine !== 'claude' || (claudeModels && claudeModels.length))) out.model = '';
  }
  if (out.effort && !effortOptionsFor(engine, out.model).some((o) => o.value === out.effort)) out.effort = '';
  return out;
}
